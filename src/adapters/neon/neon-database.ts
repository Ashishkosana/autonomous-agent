import type { EmbeddingProvider } from '../../models/embeddings.js';
import { MemoryStoreError } from '../../memory/errors.js';
import type { OpenedMemory } from '../../memory/opened-memory.js';
import type { RunMetricsRecord } from '../../memory/run-metrics.js';
import type { SemanticIndex } from '../../memory/retrieval.js';
import { MIGRATIONS, NEON_SCHEMA_VERSION } from './migrations.js';
import { NeonMemoryStore } from './neon-memory-store.js';
import { NeonSemanticIndex } from './neon-semantic-index.js';
import { PgClient } from './pg-client.js';

/** Advisory lock key for schema migration. Stable, arbitrary, not a secret. */
const SCHEMA_LOCK = 4_829_100_1;

/**
 * One Neon (Postgres) database: memory records, their vectors, and measured
 * run metrics. Opened from a composition root with a connection string that
 * was already read from the environment. Call `deleteAll` only from tests
 * or when an operator means to forget every agent row in that database.
 */
export class NeonDatabase implements OpenedMemory {
  readonly kind = 'neon' as const;
  readonly store: NeonMemoryStore;
  private index: NeonSemanticIndex | undefined;

  private constructor(private readonly db: PgClient) {
    this.store = new NeonMemoryStore(db);
  }

  static async open(options: { readonly connectionString: string }): Promise<NeonDatabase> {
    const db = new PgClient(options.connectionString);
    try {
      await migrate(db);
    } catch (error: unknown) {
      await db.close();
      throw error;
    }
    return new NeonDatabase(db);
  }

  openSemanticIndex(embeddings: EmbeddingProvider): SemanticIndex & { close(): void } {
    this.index?.close();
    this.index = new NeonSemanticIndex(this.db, embeddings);
    return this.index;
  }

  async recordEfficiency(snapshot: RunMetricsRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_run_metrics (
         run_id, goal_statement, status, succeeded, iterations, tool_calls, model_calls,
         input_tokens, output_tokens, retrieval_hit_rate, retrieval_hit_count,
         signals_used, cited_record_ids, retrieved_record_ids
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
       )
       ON CONFLICT (run_id) DO UPDATE SET
         goal_statement = EXCLUDED.goal_statement,
         status = EXCLUDED.status,
         succeeded = EXCLUDED.succeeded,
         iterations = EXCLUDED.iterations,
         tool_calls = EXCLUDED.tool_calls,
         model_calls = EXCLUDED.model_calls,
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         retrieval_hit_rate = EXCLUDED.retrieval_hit_rate,
         retrieval_hit_count = EXCLUDED.retrieval_hit_count,
         signals_used = EXCLUDED.signals_used,
         cited_record_ids = EXCLUDED.cited_record_ids,
         retrieved_record_ids = EXCLUDED.retrieved_record_ids,
         recorded_at = now()`,
      [
        snapshot.runId,
        snapshot.goalStatement,
        snapshot.status,
        snapshot.succeeded,
        snapshot.iterations,
        snapshot.toolCalls,
        snapshot.modelCalls,
        snapshot.inputTokens,
        snapshot.outputTokens,
        snapshot.retrievalHitRate,
        snapshot.retrievalHitCount,
        JSON.stringify(snapshot.signalsUsed),
        JSON.stringify(snapshot.citedRecordIds),
        JSON.stringify(snapshot.retrievedRecordIds),
      ],
    );
  }

  async latestEfficiency(goalStatement: string): Promise<RunMetricsRecord | undefined> {
    const rows = await this.db.query<MetricsRow>(
      `SELECT run_id, goal_statement, status, succeeded, iterations, tool_calls, model_calls,
              input_tokens, output_tokens, retrieval_hit_rate, retrieval_hit_count,
              signals_used, cited_record_ids, retrieved_record_ids
       FROM agent_run_metrics
       WHERE goal_statement = $1
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [goalStatement],
    );
    const row = rows[0];
    return row ? metricsFromRow(row) : undefined;
  }

  /** Deletes every agent row in this database. Tests use a dedicated database. */
  async deleteAll(): Promise<void> {
    await this.db.query(
      'TRUNCATE TABLE agent_memory_records, agent_memory_embeddings, agent_run_metrics CASCADE',
    );
  }

  async close(): Promise<void> {
    this.index?.close();
    await this.db.close();
  }
}

async function migrate(db: PgClient): Promise<void> {
  await db.transaction(async (query) => {
    await query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
    await query(
      `CREATE TABLE IF NOT EXISTS agent_schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const rows = await query<{ version: number | string }>(
      'SELECT version FROM agent_schema_migrations',
    );
    const applied = new Set(rows.map((row) => Number(row.version)));
    for (const version of applied) {
      if (version > NEON_SCHEMA_VERSION) {
        throw new MemoryStoreError(
          `Neon memory database has schema version ${version}; this build supports ${NEON_SCHEMA_VERSION}`,
          'configuration',
        );
      }
    }
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      for (const statement of migration.statements) await query(statement);
      await query('INSERT INTO agent_schema_migrations (version) VALUES ($1)', [migration.version]);
    }
  });
}

interface MetricsRow extends Record<string, unknown> {
  run_id: string;
  goal_statement: string;
  status: string;
  succeeded: boolean;
  iterations: number | string;
  tool_calls: number | string;
  model_calls: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  retrieval_hit_rate: number | string | null;
  retrieval_hit_count: number | string;
  signals_used: string;
  cited_record_ids: string;
  retrieved_record_ids: string;
}

function metricsFromRow(row: MetricsRow): RunMetricsRecord {
  const inputTokens = Number(row.input_tokens);
  const outputTokens = Number(row.output_tokens);
  return {
    runId: row.run_id,
    goalStatement: row.goal_statement,
    status: row.status,
    succeeded: Boolean(row.succeeded),
    iterations: Number(row.iterations),
    toolCalls: Number(row.tool_calls),
    modelCalls: Number(row.model_calls),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    retrievalHitRate: row.retrieval_hit_rate === null ? null : Number(row.retrieval_hit_rate),
    retrievalHitCount: Number(row.retrieval_hit_count),
    signalsUsed: parseStringArray(row.signals_used, row.run_id),
    citedRecordIds: parseStringArray(row.cited_record_ids, row.run_id),
    retrievedRecordIds: parseStringArray(row.retrieved_record_ids, row.run_id),
  };
}

function parseStringArray(value: string, runId: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    throw new MemoryStoreError(
      `Stored run metrics for ${runId} are not valid JSON`,
      'corrupt_record',
      undefined,
      {
        cause: error,
      },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new MemoryStoreError(
      `Stored run metrics for ${runId} have a malformed list`,
      'corrupt_record',
    );
  }
  return parsed;
}
