import type { GoalId, MemoryRecordId, RunId } from '../domain/ids.js';
import type {
  MemoryRecordOfKind,
  PersistentMemoryKind,
  PersistentMemoryRecord,
} from './records.js';

/**
 * Structured storage for persistent memory records. Backs the "metadata
 * filtering" stage of retrieval and is the source of truth for every record.
 *
 * V1 backend: SQLite through `node:sqlite` (`./sqlite/`, ADR-005). The
 * contract below is what every backend — including the test store — must
 * satisfy; `tests/support/memory-store-contract.ts` enforces it.
 *
 * Ordering: `query` returns records oldest-first by `createdAt`; records with
 * the same timestamp keep the order in which they were first stored. `limit`
 * therefore means "the earliest N matches". `count` ignores `limit`.
 *
 * `put` is an upsert keyed on `recordId`: storing a record again replaces its
 * content and tags but keeps its original position in the order.
 */
export interface MemoryQuery {
  readonly kinds?: readonly PersistentMemoryKind[];
  readonly runId?: RunId;
  readonly goalId?: GoalId;
  /** All listed tags must be present on the record. */
  readonly tags?: readonly string[];
  /** Strictly after this ISO timestamp. */
  readonly createdAfter?: string;
  readonly limit?: number;
}

export interface MemoryStore {
  /** Rejects records that violate the shared base shape with `MemoryStoreError('invalid_record')`. */
  put(record: PersistentMemoryRecord): Promise<void>;
  get(recordId: MemoryRecordId): Promise<PersistentMemoryRecord | undefined>;
  getOfKind<K extends PersistentMemoryKind>(
    kind: K,
    recordId: MemoryRecordId,
  ): Promise<MemoryRecordOfKind<K> | undefined>;
  query(query: MemoryQuery): Promise<readonly PersistentMemoryRecord[]>;
  count(query?: MemoryQuery): Promise<number>;
}
