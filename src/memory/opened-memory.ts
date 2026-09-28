import type { EmbeddingProvider } from '../models/embeddings.js';
import type { RunMetricsRecord } from './run-metrics.js';
import type { SemanticIndex } from './retrieval.js';
import type { MemoryStore } from './store.js';

/**
 * A memory backend opened by a composition root. The agent loop sees only
 * `store`. Semantic indexing and run-metric rows are optional capabilities
 * of the backend; SQLite has the index, Neon has the index and durable
 * run metrics.
 */
export interface OpenedMemory {
  readonly kind: 'sqlite' | 'neon';
  readonly store: MemoryStore;
  openSemanticIndex(embeddings: EmbeddingProvider): SemanticIndex & { close(): void };
  /** Present when the backend keeps run metrics beside the records. */
  recordEfficiency?(snapshot: RunMetricsRecord): Promise<void>;
  /** The latest stored metrics for this exact goal statement, if any. */
  latestEfficiency?(goalStatement: string): Promise<RunMetricsRecord | undefined>;
  close(): void | Promise<void>;
}
