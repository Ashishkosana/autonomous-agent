import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { MemoryRecordId } from '../../domain/ids.js';
import { MemoryStoreError } from '../errors.js';
import {
  type MemoryRecordOfKind,
  type PersistentMemoryKind,
  type PersistentMemoryRecord,
} from '../records.js';
import type { EfficiencyListQuery } from '../opened-memory.js';
import type { RunMetricsRecord } from '../run-metrics.js';
import type { MemoryQuery, MemoryStore } from '../store.js';
import { assertStorableRecord, parseStoredRecord } from '../validate.js';

/**
 * MemoryStore on a single SQLite file through Node's built-in `node:sqlite`
 * (ADR-005). No third-party dependency; the file is the unit of persistence
 * and can be copied, inspected with any sqlite3 client, or deleted to forget.
 *
 * Layout: one row per record holding the full record as JSON plus the
 * indexed metadata every `MemoryQuery` filters on (kind, run, goal, task,
 * createdAt) and a tag table for all-of tag matching. The JSON body is the
 * source of truth; the columns are a query index derived from it on write.
 * Keeping the body whole means field-level schemas (OPEN) can evolve without
 * a migration — only the indexed base is fixed, and it is the same base
 * `assertStorableRecord` guards.
 *
 * Concurrency: one process writes at a time (SQLite's own locking, WAL mode,
 * 5 s busy timeout). That is the V1 shape — one agent process per store.
 */
export interface SqliteMemoryStoreOptions {
  /** Database file path. `:memory:` gives a throwaway store that dies with the handle. */
  readonly path: string;
}

export const MEMORY_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_records (
  record_id  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('knowledge', 'experience', 'decision', 'lesson')),
  run_id     TEXT NOT NULL,
  goal_id    TEXT,
  task_id    TEXT,
  created_at TEXT NOT NULL,
  summary    TEXT NOT NULL,
  body       TEXT NOT NULL,
  seq        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_records_order ON memory_records (created_at, seq);
CREATE INDEX IF NOT EXISTS memory_records_kind  ON memory_records (kind, created_at, seq);
CREATE INDEX IF NOT EXISTS memory_records_run   ON memory_records (run_id);
CREATE INDEX IF NOT EXISTS memory_records_goal  ON memory_records (goal_id);
CREATE TABLE IF NOT EXISTS memory_record_tags (
  record_id TEXT NOT NULL REFERENCES memory_records (record_id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (record_id, tag)
);
CREATE INDEX IF NOT EXISTS memory_record_tags_tag ON memory_record_tags (tag);
CREATE TABLE IF NOT EXISTS run_metrics (
  run_id TEXT PRIMARY KEY,
  goal_statement TEXT NOT NULL,
  status TEXT NOT NULL,
  succeeded INTEGER NOT NULL,
  iterations INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  model_calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  retrieval_hit_rate REAL,
  retrieval_hit_count INTEGER NOT NULL,
  signals_used TEXT NOT NULL,
  cited_record_ids TEXT NOT NULL,
  retrieved_record_ids TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_metrics_goal ON run_metrics (goal_statement, recorded_at DESC);
`;

interface RecordRow {
  record_id: string;
  kind: string;
  body: string;
}

export class SqliteMemoryStore implements MemoryStore {
  static open(options: SqliteMemoryStoreOptions): SqliteMemoryStore {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(options.path);
    } catch (error: unknown) {
      throw new MemoryStoreError(
        `Cannot open memory database at "${options.path}": ${describe(error)}`,
        'configuration',
        undefined,
        { cause: error },
      );
    }
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(SCHEMA);
      ensureSchemaVersion(db, options.path);
    } catch (error: unknown) {
      db.close();
      throw error;
    }
    return new SqliteMemoryStore(db, options.path);
  }

  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly insertRecord: StatementSync;
  private readonly deleteTags: StatementSync;
  private readonly insertTag: StatementSync;
  private readonly selectById: StatementSync;
  private readonly selectOwner: StatementSync;
  private open = true;

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
    this.insertRecord = db.prepare(`
      INSERT INTO memory_records (record_id, kind, run_id, goal_id, task_id, created_at, summary, body, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(seq) FROM memory_records), 0) + 1)
      ON CONFLICT (record_id) DO UPDATE SET
        kind = excluded.kind,
        run_id = excluded.run_id,
        goal_id = excluded.goal_id,
        task_id = excluded.task_id,
        created_at = excluded.created_at,
        summary = excluded.summary,
        body = excluded.body
    `);
    this.deleteTags = db.prepare('DELETE FROM memory_record_tags WHERE record_id = ?');
    this.insertTag = db.prepare(
      'INSERT OR IGNORE INTO memory_record_tags (record_id, tag) VALUES (?, ?)',
    );
    this.selectById = db.prepare(
      'SELECT record_id, kind, body FROM memory_records WHERE record_id = ?',
    );
    this.selectOwner = db.prepare('SELECT run_id FROM memory_records WHERE record_id = ?');
  }

  /** Releases the file handle. Further calls fail with `unavailable`. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }

  get isOpen(): boolean {
    return this.open;
  }

  async put(record: PersistentMemoryRecord): Promise<void> {
    this.requireOpen();
    assertStorableRecord(record);
    const body = JSON.stringify(record);
    this.db.exec('BEGIN');
    try {
      const existing = this.selectOwner.get(record.recordId) as { run_id: string } | undefined;
      if (existing && existing.run_id !== record.runId) {
        throw new MemoryStoreError(
          `Memory record ${record.recordId} was written by run ${existing.run_id}; run ${record.runId} may not overwrite it (id collision)`,
          'conflict',
          record.recordId,
        );
      }
      this.insertRecord.run(
        record.recordId,
        record.kind,
        record.runId,
        record.goalId ?? null,
        record.taskId ?? null,
        record.createdAt,
        record.summary,
        body,
      );
      this.deleteTags.run(record.recordId);
      for (const tag of record.tags) this.insertTag.run(record.recordId, tag);
      this.db.exec('COMMIT');
    } catch (error: unknown) {
      this.db.exec('ROLLBACK');
      if (error instanceof MemoryStoreError) throw error;
      throw new MemoryStoreError(
        `Failed to store memory record ${record.recordId}: ${describe(error)}`,
        'unavailable',
        record.recordId,
        { cause: error },
      );
    }
  }

  async get(recordId: MemoryRecordId): Promise<PersistentMemoryRecord | undefined> {
    this.requireOpen();
    const row = this.selectById.get(recordId) as RecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  async getOfKind<K extends PersistentMemoryKind>(
    kind: K,
    recordId: MemoryRecordId,
  ): Promise<MemoryRecordOfKind<K> | undefined> {
    const record = await this.get(recordId);
    return record && record.kind === kind ? (record as MemoryRecordOfKind<K>) : undefined;
  }

  async query(query: MemoryQuery): Promise<readonly PersistentMemoryRecord[]> {
    this.requireOpen();
    const { where, params } = whereClause(query);
    const limit = query.limit === undefined ? '' : ' LIMIT ?';
    if (query.limit !== undefined) params.push(Math.max(0, Math.floor(query.limit)));
    const rows = this.db
      .prepare(
        `SELECT record_id, kind, body FROM memory_records${where} ORDER BY created_at, seq${limit}`,
      )
      .all(...params) as unknown as RecordRow[];
    return rows.map(rowToRecord);
  }

  async count(query: MemoryQuery = {}): Promise<number> {
    this.requireOpen();
    const { where, params } = whereClause(query);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memory_records${where}`)
      .get(...params) as { n: number | bigint };
    return Number(row.n);
  }

  async recordEfficiency(snapshot: RunMetricsRecord): Promise<void> {
    this.requireOpen();
    this.db
      .prepare(
        `INSERT INTO run_metrics (
           run_id, goal_statement, status, succeeded, iterations, tool_calls, model_calls,
           input_tokens, output_tokens, duration_ms, retrieval_hit_rate, retrieval_hit_count,
           signals_used, cited_record_ids, retrieved_record_ids, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET
           goal_statement = excluded.goal_statement,
           status = excluded.status,
           succeeded = excluded.succeeded,
           iterations = excluded.iterations,
           tool_calls = excluded.tool_calls,
           model_calls = excluded.model_calls,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           duration_ms = excluded.duration_ms,
           retrieval_hit_rate = excluded.retrieval_hit_rate,
           retrieval_hit_count = excluded.retrieval_hit_count,
           signals_used = excluded.signals_used,
           cited_record_ids = excluded.cited_record_ids,
           retrieved_record_ids = excluded.retrieved_record_ids,
           recorded_at = excluded.recorded_at`,
      )
      .run(
        snapshot.runId,
        snapshot.goalStatement,
        snapshot.status,
        snapshot.succeeded ? 1 : 0,
        snapshot.iterations,
        snapshot.toolCalls,
        snapshot.modelCalls,
        snapshot.inputTokens,
        snapshot.outputTokens,
        snapshot.durationMs,
        snapshot.retrievalHitRate,
        snapshot.retrievalHitCount,
        JSON.stringify(snapshot.signalsUsed),
        JSON.stringify(snapshot.citedRecordIds),
        JSON.stringify(snapshot.retrievedRecordIds),
        new Date().toISOString(),
      );
  }

  async latestEfficiency(goalStatement: string): Promise<RunMetricsRecord | undefined> {
    const rows = await this.listEfficiency({ goalStatement, limit: 1 });
    return rows[0];
  }

  async listEfficiency(query: EfficiencyListQuery = {}): Promise<readonly RunMetricsRecord[]> {
    this.requireOpen();
    const limit = clampMetricLimit(query.limit);
    const rows = (query.goalStatement === undefined
      ? this.db
          .prepare(`${METRICS_SELECT} ORDER BY recorded_at DESC, rowid DESC LIMIT ?`)
          .all(limit)
      : this.db
          .prepare(
            `${METRICS_SELECT} WHERE goal_statement = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?`,
          )
          .all(query.goalStatement, limit)) as unknown as MetricsSqlRow[];
    return rows.map((row) => metricsFromSqlite(row));
  }

  async ping(): Promise<void> {
    this.requireOpen();
    this.db.prepare('SELECT 1 AS ok').get();
  }

  private requireOpen(): void {
    if (!this.open) {
      throw new MemoryStoreError(`Memory store at "${this.path}" is closed`, 'unavailable');
    }
  }
}

type SqlParam = string | number | null;

function whereClause(query: MemoryQuery): { where: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (query.kinds !== undefined) {
    if (query.kinds.length === 0) clauses.push('0');
    else {
      clauses.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
      params.push(...query.kinds);
    }
  }
  if (query.runId !== undefined) {
    clauses.push('run_id = ?');
    params.push(query.runId);
  }
  if (query.goalId !== undefined) {
    clauses.push('goal_id = ?');
    params.push(query.goalId);
  }
  if (query.tags !== undefined && query.tags.length > 0) {
    const distinct = [...new Set(query.tags)];
    clauses.push(
      `record_id IN (SELECT record_id FROM memory_record_tags WHERE tag IN (${distinct
        .map(() => '?')
        .join(', ')}) GROUP BY record_id HAVING COUNT(DISTINCT tag) = ?)`,
    );
    params.push(...distinct, distinct.length);
  }
  if (query.createdAfter !== undefined) {
    clauses.push('created_at > ?');
    params.push(query.createdAfter);
  }
  return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

function rowToRecord(row: RecordRow): PersistentMemoryRecord {
  return parseStoredRecord(row.body, row.record_id, row.kind);
}

function ensureSchemaVersion(db: DatabaseSync, path: string): void {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(
      String(MEMORY_SCHEMA_VERSION),
    );
    return;
  }
  const found = Number(row.value);
  if (found !== MEMORY_SCHEMA_VERSION) {
    throw new MemoryStoreError(
      `Memory database at "${path}" has schema version ${row.value}; this build supports ${MEMORY_SCHEMA_VERSION}`,
      'configuration',
    );
  }
}

const METRICS_SELECT = `SELECT run_id, goal_statement, status, succeeded, iterations, tool_calls, model_calls,
            input_tokens, output_tokens, duration_ms, retrieval_hit_rate, retrieval_hit_count,
            signals_used, cited_record_ids, retrieved_record_ids
     FROM run_metrics`;

interface MetricsSqlRow {
  run_id: string;
  goal_statement: string;
  status: string;
  succeeded: number;
  iterations: number;
  tool_calls: number;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  retrieval_hit_rate: number | null;
  retrieval_hit_count: number;
  signals_used: string;
  cited_record_ids: string;
  retrieved_record_ids: string;
}

function clampMetricLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

function metricsFromSqlite(row: MetricsSqlRow): RunMetricsRecord {
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
    durationMs: Number(row.duration_ms),
    retrievalHitRate: row.retrieval_hit_rate === null ? null : Number(row.retrieval_hit_rate),
    retrievalHitCount: Number(row.retrieval_hit_count),
    signalsUsed: parseMetricStrings(row.signals_used, row.run_id),
    citedRecordIds: parseMetricStrings(row.cited_record_ids, row.run_id),
    retrievedRecordIds: parseMetricStrings(row.retrieved_record_ids, row.run_id),
  };
}

function parseMetricStrings(value: string, runId: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    throw new MemoryStoreError(
      `Stored run metrics for ${runId} are not valid JSON`,
      'corrupt_record',
      undefined,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new MemoryStoreError(
      `Stored run metrics for ${runId} are not a string array`,
      'corrupt_record',
    );
  }
  return parsed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
