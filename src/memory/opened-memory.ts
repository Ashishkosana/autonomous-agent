import type { EmbeddingProvider } from '../models/embeddings.js';
import type { RunMetricsRecord } from './run-metrics.js';
import type { SemanticIndex } from './retrieval.js';
import type { MemoryStore } from './store.js';

/**
 * A memory backend opened by a composition root. The agent loop sees only
 * `store`. Semantic indexing and run-metric rows sit beside it. SQLite and
 * Neon both keep those rows; Neon is the one that survives a host restart.
 */
export interface EfficiencyListQuery {
  /** Exact goal statement. Omit to list the newest runs of any goal. */
  readonly goalStatement?: string;
  /** Defaults to 20. Clamped to 1–50. */
  readonly limit?: number;
}

export interface OpenedMemory {
  readonly kind: 'sqlite' | 'neon';
  readonly store: MemoryStore;
  openSemanticIndex(embeddings: EmbeddingProvider): SemanticIndex & { close(): void };
  /** Present when the backend keeps run metrics beside the records. */
  recordEfficiency?(snapshot: RunMetricsRecord): Promise<void>;
  /** The latest stored metrics for this exact goal statement, if any. */
  latestEfficiency?(goalStatement: string): Promise<RunMetricsRecord | undefined>;
  /** Newest first. */
  listEfficiency?(query?: EfficiencyListQuery): Promise<readonly RunMetricsRecord[]>;
  /** Confirms the backend can answer a query. Throws when it cannot. */
  ping?(): Promise<void>;
  close(): void | Promise<void>;
}
