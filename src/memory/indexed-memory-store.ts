import type { MemoryRecordId } from '../domain/ids.js';
import type {
  MemoryRecordOfKind,
  PersistentMemoryKind,
  PersistentMemoryRecord,
} from './records.js';
import type { SemanticIndex } from './retrieval.js';
import { searchableText } from './searchable-text.js';
import type { MemoryQuery, MemoryStore } from './store.js';

export interface IndexFailure {
  readonly recordId: MemoryRecordId;
  readonly kind: PersistentMemoryKind;
  readonly error: unknown;
}

export interface IndexedMemoryStoreOptions {
  /**
   * Called when a record was stored but could not be embedded (endpoint
   * down, model misbehaving). The record is durable and lexically
   * retrievable; it is simply not semantically findable until `backfill()`.
   * Composition roots turn this into an event; leaving it unset still counts
   * the failure in `failures`.
   */
  readonly onIndexFailure?: (failure: IndexFailure) => void;
}

/**
 * A `MemoryStore` that keeps a `SemanticIndex` in step with every write.
 * The store is the source of truth; the index is derived from it. That order
 * matters: a record is never lost because an embedding server was down, and
 * a vector never exists for a record that was not stored.
 *
 * The runtime sees only `MemoryStore`, so the agent core does not know
 * whether a semantic index exists (architecture rule).
 */
export class IndexedMemoryStore implements MemoryStore {
  readonly failures: IndexFailure[] = [];

  constructor(
    private readonly inner: MemoryStore,
    private readonly index: SemanticIndex,
    private readonly options: IndexedMemoryStoreOptions = {},
  ) {}

  async put(record: PersistentMemoryRecord): Promise<void> {
    await this.inner.put(record);
    await this.tryIndex(record);
  }

  get(recordId: MemoryRecordId): Promise<PersistentMemoryRecord | undefined> {
    return this.inner.get(recordId);
  }

  getOfKind<K extends PersistentMemoryKind>(
    kind: K,
    recordId: MemoryRecordId,
  ): Promise<MemoryRecordOfKind<K> | undefined> {
    return this.inner.getOfKind(kind, recordId);
  }

  query(query: MemoryQuery): Promise<readonly PersistentMemoryRecord[]> {
    return this.inner.query(query);
  }

  count(query?: MemoryQuery): Promise<number> {
    return this.inner.count(query);
  }

  /**
   * Embeds every stored record the index does not yet hold for the current
   * model — after an outage, or after switching embedding models. Returns
   * what it did; failures are reported the same way as on `put`.
   */
  async backfill(query: MemoryQuery = {}): Promise<{
    readonly examined: number;
    readonly indexed: number;
    readonly failed: number;
  }> {
    let indexed = 0;
    let failed = 0;
    const records = await this.inner.query(query);
    for (const record of records) {
      if (await this.index.contains(record.recordId)) continue;
      if (await this.tryIndex(record)) indexed += 1;
      else failed += 1;
    }
    return { examined: records.length, indexed, failed };
  }

  private async tryIndex(record: PersistentMemoryRecord): Promise<boolean> {
    try {
      await this.index.index(record.recordId, searchableText(record));
      return true;
    } catch (error: unknown) {
      const failure: IndexFailure = { recordId: record.recordId, kind: record.kind, error };
      this.failures.push(failure);
      this.options.onIndexFailure?.(failure);
      return false;
    }
  }
}
