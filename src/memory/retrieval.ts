import type { IsoTimestamp, MemoryRecordId, RetrievalId } from '../domain/ids.js';
import type { RunCorrelation } from '../domain/provenance.js';
import type { PersistentMemoryKind, PersistentMemoryRecord } from './records.js';

/**
 * Retrieval turns a question into a *small*, ranked set of memory records.
 * The retriever decides which stages to run (metadata filter, keyword,
 * semantic) and how to rank; the result records which signals matched so the
 * dashboard can honestly say how a memory was found.
 */
export type RetrievalSignal = 'metadata' | 'keyword' | 'semantic';

export interface RetrievalQuery {
  /** Assigned by the caller so start/finish events can be correlated before results exist. */
  readonly retrievalId: RetrievalId;
  readonly text: string;
  readonly kinds: readonly PersistentMemoryKind[];
  readonly tags?: readonly string[];
  readonly limit: number;
  readonly correlation: RunCorrelation;
}

export interface RetrievalDegradation {
  readonly signal: RetrievalSignal;
  /** Already redacted by the failing component; safe to put in an event. */
  readonly reason: string;
}

export interface RetrievalHit {
  readonly record: PersistentMemoryRecord;
  /** Higher is more relevant; scale is retriever-specific but monotonic. */
  readonly score: number;
  readonly matchedBy: readonly RetrievalSignal[];
}

export interface RetrievalResult {
  /** Echoes `query.retrievalId`. */
  readonly retrievalId: RetrievalId;
  readonly query: RetrievalQuery;
  readonly hits: readonly RetrievalHit[];
  /** Which stages actually ran, so "semantic retrieval" is never claimed if it did not. */
  readonly signalsUsed: readonly RetrievalSignal[];
  /**
   * Stages the retriever is configured for but could not run this time
   * (e.g. the embedding endpoint failed). Absent or empty means nothing was
   * skipped. A degraded retrieval is still a valid retrieval — it just says so.
   */
  readonly degraded?: readonly RetrievalDegradation[];
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly durationMs: number;
}

export interface MemoryRetriever {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
}

/**
 * Meaning-based lookup (ADR-006). The index stores one vector per record and
 * answers "which indexed records are closest to this text". Retrievers
 * compose it with the MemoryStore: the store's metadata filter decides what
 * is *eligible*, the index decides what is *similar*.
 */
export interface SemanticMatch {
  readonly recordId: MemoryRecordId;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  readonly score: number;
}

export interface SemanticSearchOptions {
  /** Only these records are candidates (the metadata-filtered set). Unset means every indexed record. */
  readonly within?: readonly MemoryRecordId[];
}

export interface SemanticIndex {
  index(recordId: MemoryRecordId, text: string): Promise<void>;
  remove(recordId: MemoryRecordId): Promise<void>;
  /** Whether a comparable vector exists for the record (same embedding model). */
  contains(recordId: MemoryRecordId): Promise<boolean>;
  search(
    text: string,
    limit: number,
    options?: SemanticSearchOptions,
  ): Promise<readonly SemanticMatch[]>;
}
