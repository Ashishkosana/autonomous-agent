import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { MemoryRecordId } from '../../domain/ids.js';
import { cosineSimilarity, type EmbeddingProvider } from '../../models/embeddings.js';
import { MemoryStoreError } from '../errors.js';
import type { SemanticIndex, SemanticMatch, SemanticSearchOptions } from '../retrieval.js';

/**
 * `SemanticIndex` on SQLite through `node:sqlite` (ADR-006): one vector per
 * record, stored as a float32 blob next to the embedding model that produced
 * it. It may share the memory store's file (its tables and `schema_meta` key
 * are distinct) or have its own.
 *
 * Similarity is brute-force cosine in-process over the candidate rows —
 * honest and exact for the record counts one agent accumulates (tens of
 * thousands of 768-float vectors compare in milliseconds); a vector database
 * is a later adapter behind the same contract, not a V1 need.
 *
 * Vectors are only comparable within one embedding model. Rows written by a
 * different model are ignored by `search`/`contains` and overwritten by
 * `index`, so switching models degrades to "nothing indexed yet" instead of
 * returning nonsense similarities.
 */
export interface SqliteSemanticIndexOptions {
  /** Database file path (may be the memory store's file). `:memory:` dies with the handle. */
  readonly path: string;
  readonly embeddings: EmbeddingProvider;
  /** Upper bound on vectors compared per search. Default 20000. */
  readonly maxCandidates?: number;
}

export const SEMANTIC_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_embeddings (
  record_id  TEXT NOT NULL,
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  text_hash  TEXT NOT NULL,
  vector     BLOB NOT NULL,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (record_id)
);
CREATE INDEX IF NOT EXISTS memory_embeddings_model ON memory_embeddings (provider, model, seq);
`;

interface VectorRow {
  record_id: string;
  dimensions: number | bigint;
  vector: Uint8Array;
}

export class SqliteSemanticIndex implements SemanticIndex {
  static open(options: SqliteSemanticIndexOptions): SqliteSemanticIndex {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(options.path);
    } catch (error: unknown) {
      throw new MemoryStoreError(
        `Cannot open semantic index at "${options.path}": ${describe(error)}`,
        'configuration',
        undefined,
        { cause: error },
      );
    }
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(SCHEMA);
      ensureSchemaVersion(db, options.path);
    } catch (error: unknown) {
      db.close();
      throw error;
    }
    return new SqliteSemanticIndex(db, options);
  }

  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly embeddings: EmbeddingProvider;
  private readonly maxCandidates: number;
  private readonly upsert: StatementSync;
  private readonly selectHash: StatementSync;
  private readonly deleteById: StatementSync;
  private readonly existsForModel: StatementSync;
  private readonly countForModel: StatementSync;
  private open = true;

  private constructor(db: DatabaseSync, options: SqliteSemanticIndexOptions) {
    this.db = db;
    this.path = options.path;
    this.embeddings = options.embeddings;
    this.maxCandidates = options.maxCandidates ?? 20_000;
    this.upsert = db.prepare(`
      INSERT INTO memory_embeddings (record_id, provider, model, dimensions, text_hash, vector, seq)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(seq) FROM memory_embeddings), 0) + 1)
      ON CONFLICT (record_id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        dimensions = excluded.dimensions,
        text_hash = excluded.text_hash,
        vector = excluded.vector,
        seq = excluded.seq
    `);
    this.selectHash = db.prepare(
      'SELECT text_hash FROM memory_embeddings WHERE record_id = ? AND provider = ? AND model = ?',
    );
    this.deleteById = db.prepare('DELETE FROM memory_embeddings WHERE record_id = ?');
    this.existsForModel = db.prepare(
      'SELECT 1 AS one FROM memory_embeddings WHERE record_id = ? AND provider = ? AND model = ?',
    );
    this.countForModel = db.prepare(
      'SELECT COUNT(*) AS n FROM memory_embeddings WHERE provider = ? AND model = ?',
    );
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** The embedding model whose vectors this handle reads and writes. */
  get descriptor() {
    return this.embeddings.descriptor;
  }

  /**
   * Embeds `text` and stores the vector for `recordId`. Re-indexing identical
   * text for the same model is a no-op (no embedding call), so an upsert of an
   * unchanged record costs nothing.
   */
  async index(recordId: MemoryRecordId, text: string): Promise<void> {
    this.requireOpen();
    if (text.trim() === '') {
      throw new MemoryStoreError(
        `Cannot index memory record ${recordId}: empty text`,
        'invalid_record',
        recordId,
      );
    }
    const { provider, model } = this.embeddings.descriptor;
    const hash = await sha256(text);
    const existing = this.selectHash.get(recordId, provider, model) as
      { text_hash: string } | undefined;
    if (existing?.text_hash === hash) return;

    const response = await this.embeddings.embed({ purpose: 'index_memory', texts: [text] });
    const vector = response.vectors[0];
    if (!vector) {
      throw new MemoryStoreError(
        `Embedding provider returned no vector for ${recordId}`,
        'unavailable',
        recordId,
      );
    }
    try {
      this.upsert.run(recordId, provider, model, vector.length, hash, encode(vector));
    } catch (error: unknown) {
      throw new MemoryStoreError(
        `Failed to store embedding for ${recordId}: ${describe(error)}`,
        'unavailable',
        recordId,
        { cause: error },
      );
    }
  }

  async remove(recordId: MemoryRecordId): Promise<void> {
    this.requireOpen();
    this.deleteById.run(recordId);
  }

  async contains(recordId: MemoryRecordId): Promise<boolean> {
    this.requireOpen();
    const { provider, model } = this.embeddings.descriptor;
    return this.existsForModel.get(recordId, provider, model) !== undefined;
  }

  /** Vectors stored for the current embedding model. */
  async count(): Promise<number> {
    this.requireOpen();
    const { provider, model } = this.embeddings.descriptor;
    const row = this.countForModel.get(provider, model) as { n: number | bigint };
    return Number(row.n);
  }

  async search(
    text: string,
    limit: number,
    options: SemanticSearchOptions = {},
  ): Promise<readonly SemanticMatch[]> {
    this.requireOpen();
    if (limit <= 0 || text.trim() === '') return [];
    if (options.within !== undefined && options.within.length === 0) return [];

    const rows = this.candidateRows(options.within);
    if (rows.length === 0) return [];

    const response = await this.embeddings.embed({ purpose: 'query_memory', texts: [text] });
    const query = response.vectors[0];
    if (!query) return [];

    const matches: SemanticMatch[] = [];
    for (const row of rows) {
      if (Number(row.dimensions) !== query.length) continue;
      matches.push({
        recordId: row.record_id as MemoryRecordId,
        score: cosineSimilarity(query, decode(row.vector)),
      });
    }
    matches.sort(
      (a, b) =>
        b.score - a.score || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
    );
    return matches.slice(0, Math.floor(limit));
  }

  private candidateRows(within: readonly MemoryRecordId[] | undefined): VectorRow[] {
    const { provider, model } = this.embeddings.descriptor;
    const params: (string | number)[] = [provider, model];
    let where = 'provider = ? AND model = ?';
    if (within !== undefined) {
      const distinct = [...new Set(within)];
      where += ` AND record_id IN (${distinct.map(() => '?').join(', ')})`;
      params.push(...distinct);
    }
    params.push(this.maxCandidates);
    return this.db
      .prepare(
        `SELECT record_id, dimensions, vector FROM memory_embeddings WHERE ${where} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...params) as unknown as VectorRow[];
  }

  private requireOpen(): void {
    if (!this.open) {
      throw new MemoryStoreError(`Semantic index at "${this.path}" is closed`, 'unavailable');
    }
  }
}

function encode(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function decode(blob: Uint8Array): Float32Array {
  // Copy so the float view starts at offset 0 regardless of how SQLite aligned the blob.
  const bytes = blob.slice();
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function ensureSchemaVersion(db: DatabaseSync, path: string): void {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'semantic_schema_version'")
    .get() as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('semantic_schema_version', ?)").run(
      String(SEMANTIC_SCHEMA_VERSION),
    );
    return;
  }
  if (Number(row.value) !== SEMANTIC_SCHEMA_VERSION) {
    throw new MemoryStoreError(
      `Semantic index at "${path}" has schema version ${row.value}; this build supports ${SEMANTIC_SCHEMA_VERSION}`,
      'configuration',
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
