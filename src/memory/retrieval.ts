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
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly durationMs: number;
}

export interface MemoryRetriever {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
}

/**
 * Meaning-based lookup. Embedding model and vector store are OPEN
 * (ADR-005, Phase 7). Retrievers compose this with the MemoryStore.
 */
export interface SemanticMatch {
  readonly recordId: MemoryRecordId;
  readonly score: number;
}

export interface SemanticIndex {
  index(recordId: MemoryRecordId, text: string): Promise<void>;
  remove(recordId: MemoryRecordId): Promise<void>;
  search(text: string, limit: number): Promise<readonly SemanticMatch[]>;
}
