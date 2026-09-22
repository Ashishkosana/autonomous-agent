import type { IsoTimestamp, MemoryRecordId, RetrievalId } from '../domain/ids.js';
import type { RunCorrelation } from '../domain/provenance.js';
import type { ApplicabilityReport } from './applicability.js';
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

/**
 * The numbers that produced `score`. Hybrid retrieval uses keyword coverage
 * in [0, 1] and cosine in [-1, 1]. The lexical retriever's `lexical` field
 * is an overlap count, and `semantic` is null. Absent on hand-built test hits.
 */
export interface ScoreBreakdown {
  readonly lexical: number;
  readonly semantic: number | null;
  readonly semanticAdmitted: boolean;
  readonly semanticThreshold: number | null;
  readonly lexicalWeight: number;
  readonly semanticWeight: number;
  readonly combined: number;
}

export interface RetrievalHit {
  readonly record: PersistentMemoryRecord;
  /** Higher is more relevant; scale is retriever-specific but monotonic. */
  readonly score: number;
  readonly matchedBy: readonly RetrievalSignal[];
  readonly breakdown?: ScoreBreakdown;
  /** 1-based position in score order, before kind-diversity selection. */
  readonly rankBeforeSelection?: number;
  /** True when kind diversity kept a hit that plain top-k would have dropped. */
  readonly keptByDiversity?: boolean;
  /** 1-based position in the returned list, after re-sorting by score. */
  readonly finalRank?: number;
  /**
   * Filled by the runtime after retrieval, from `record.preconditions`.
   * Not part of the score.
   */
  readonly applicability?: ApplicabilityReport;
}

export type RetrievalDropReason = 'below_limit' | 'displaced_by_diversity';

/** A scored hit that was not returned. Unscored candidates are counted, not listed. */
export interface RetrievalDrop {
  readonly recordId: MemoryRecordId;
  readonly kind: PersistentMemoryKind;
  readonly score: number;
  readonly breakdown?: ScoreBreakdown;
  readonly rankBeforeSelection: number;
  readonly reason: RetrievalDropReason;
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
  /** Scored hits that lost the top-k or were displaced by kind diversity. */
  readonly dropped?: readonly RetrievalDrop[];
  /** Metadata-filtered candidates considered. */
  readonly candidateCount?: number;
  /** Candidates with neither a keyword hit nor an admitted semantic hit. */
  readonly unmatchedCount?: number;
  /** Set when retrieval was deliberately not run (memory-off arm of a comparison). */
  readonly suppressed?: 'memory_off';
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
