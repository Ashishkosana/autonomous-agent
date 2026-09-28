import type { MemoryRecordId } from '../../domain/ids.js';
import { cosineSimilarity, type EmbeddingProvider } from '../../models/embeddings.js';
import { MemoryStoreError } from '../../memory/errors.js';
import type {
  SemanticIndex,
  SemanticMatch,
  SemanticSearchOptions,
} from '../../memory/retrieval.js';
import type { PgClient } from './pg-client.js';

/**
 * `SemanticIndex` on Postgres. One float32 vector per record, comparable
 * only within the embedding model that wrote it. Similarity is brute-force
 * cosine in process, the same rule as `SqliteSemanticIndex`, so a retriever
 * cannot tell the backends apart.
 */
export class NeonSemanticIndex implements SemanticIndex {
  private open = true;

  constructor(
    private readonly db: PgClient,
    private readonly embeddings: EmbeddingProvider,
    private readonly maxCandidates = 20_000,
  ) {}

  close(): void {
    this.open = false;
  }

  get descriptor() {
    return this.embeddings.descriptor;
  }

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
    const existing = await this.db.query<{ text_hash: string }>(
      `SELECT text_hash FROM agent_memory_embeddings
       WHERE record_id = $1 AND provider = $2 AND model = $3`,
      [recordId, provider, model],
    );
    if (existing[0]?.text_hash === hash) return;

    const response = await this.embeddings.embed({ purpose: 'index_memory', texts: [text] });
    const vector = response.vectors[0];
    if (!vector) {
      throw new MemoryStoreError(
        `Embedding provider returned no vector for ${recordId}`,
        'unavailable',
        recordId,
      );
    }
    await this.db.query(
      `INSERT INTO agent_memory_embeddings
         (record_id, provider, model, dimensions, text_hash, vector, seq)
       VALUES ($1, $2, $3, $4, $5, $6, nextval('agent_memory_embedding_seq'))
       ON CONFLICT (record_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         dimensions = EXCLUDED.dimensions,
         text_hash = EXCLUDED.text_hash,
         vector = EXCLUDED.vector,
         seq = nextval('agent_memory_embedding_seq')`,
      [recordId, provider, model, vector.length, hash, encode(vector)],
    );
  }

  async remove(recordId: MemoryRecordId): Promise<void> {
    this.requireOpen();
    await this.db.query('DELETE FROM agent_memory_embeddings WHERE record_id = $1', [recordId]);
  }

  async contains(recordId: MemoryRecordId): Promise<boolean> {
    this.requireOpen();
    const { provider, model } = this.embeddings.descriptor;
    const rows = await this.db.query(
      `SELECT 1 AS one FROM agent_memory_embeddings
       WHERE record_id = $1 AND provider = $2 AND model = $3`,
      [recordId, provider, model],
    );
    return rows.length > 0;
  }

  async search(
    text: string,
    limit: number,
    options: SemanticSearchOptions = {},
  ): Promise<readonly SemanticMatch[]> {
    this.requireOpen();
    if (limit <= 0 || text.trim() === '') return [];
    if (options.within !== undefined && options.within.length === 0) return [];

    const { provider, model } = this.embeddings.descriptor;
    const within = options.within === undefined ? null : [...new Set(options.within)];
    const rows = await this.db.query<VectorRow>(
      `SELECT record_id, dimensions, vector
       FROM agent_memory_embeddings
       WHERE provider = $1 AND model = $2
         AND ($3::text[] IS NULL OR record_id = ANY($3::text[]))
       ORDER BY seq DESC
       LIMIT $4`,
      [provider, model, within, this.maxCandidates],
    );
    if (rows.length === 0) return [];

    const response = await this.embeddings.embed({ purpose: 'query_memory', texts: [text] });
    const query = response.vectors[0];
    if (!query) return [];

    const matches: SemanticMatch[] = [];
    for (const row of rows) {
      const bytes = toBytes(row.vector, row.record_id);
      if (Number(row.dimensions) !== query.length) continue;
      if (bytes.byteLength !== query.length * 4) continue;
      matches.push({
        recordId: row.record_id as MemoryRecordId,
        score: cosineSimilarity(query, decode(bytes)),
      });
    }
    matches.sort(
      (a, b) =>
        b.score - a.score || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
    );
    return matches.slice(0, Math.floor(limit));
  }

  private requireOpen(): void {
    if (!this.open) {
      throw new MemoryStoreError('Neon semantic index is closed', 'unavailable');
    }
  }
}

interface VectorRow extends Record<string, unknown> {
  record_id: string;
  dimensions: number | string;
  vector: unknown;
}

function encode(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function decode(blob: Buffer): Float32Array {
  const bytes = Uint8Array.from(blob);
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

function toBytes(value: unknown, recordId: string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') {
    const hex = value.startsWith('\\x') ? value.slice(2) : value;
    return Buffer.from(hex, 'hex');
  }
  throw new MemoryStoreError(
    `Stored embedding for ${recordId} is not a byte vector`,
    'corrupt_record',
    recordId,
  );
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
