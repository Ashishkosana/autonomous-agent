import type { GoalId, MemoryRecordId, RunId } from '../domain/ids.js';
import type {
  MemoryRecordOfKind,
  PersistentMemoryKind,
  PersistentMemoryRecord,
} from './records.js';

/**
 * Structured storage for persistent memory records. Backs the "metadata
 * filtering" stage of retrieval and is the source of truth for every record.
 * The concrete database is an OPEN decision (ADR-004, Phase 6).
 */
export interface MemoryQuery {
  readonly kinds?: readonly PersistentMemoryKind[];
  readonly runId?: RunId;
  readonly goalId?: GoalId;
  /** All listed tags must be present on the record. */
  readonly tags?: readonly string[];
  readonly createdAfter?: string;
  readonly limit?: number;
}

export interface MemoryStore {
  put(record: PersistentMemoryRecord): Promise<void>;
  get(recordId: MemoryRecordId): Promise<PersistentMemoryRecord | undefined>;
  getOfKind<K extends PersistentMemoryKind>(
    kind: K,
    recordId: MemoryRecordId,
  ): Promise<MemoryRecordOfKind<K> | undefined>;
  query(query: MemoryQuery): Promise<readonly PersistentMemoryRecord[]>;
  count(query?: MemoryQuery): Promise<number>;
}
