import type { MemoryRecordId } from '../../src/domain/ids.js';
import type {
  MemoryRecordOfKind,
  PersistentMemoryKind,
  PersistentMemoryRecord,
} from '../../src/memory/records.js';
import type { MemoryQuery, MemoryStore } from '../../src/memory/store.js';

/** Map-backed MemoryStore for tests. Not a persistence design. */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<MemoryRecordId, PersistentMemoryRecord>();

  async put(record: PersistentMemoryRecord): Promise<void> {
    this.records.set(record.recordId, record);
  }

  async get(recordId: MemoryRecordId): Promise<PersistentMemoryRecord | undefined> {
    return this.records.get(recordId);
  }

  async getOfKind<K extends PersistentMemoryKind>(
    kind: K,
    recordId: MemoryRecordId,
  ): Promise<MemoryRecordOfKind<K> | undefined> {
    const record = this.records.get(recordId);
    return record && record.kind === kind ? (record as MemoryRecordOfKind<K>) : undefined;
  }

  async query(query: MemoryQuery): Promise<readonly PersistentMemoryRecord[]> {
    const matches = [...this.records.values()].filter((record) => matchesQuery(record, query));
    return query.limit === undefined ? matches : matches.slice(0, query.limit);
  }

  async count(query: MemoryQuery = {}): Promise<number> {
    const { limit: _ignored, ...unlimited } = query;
    return (await this.query(unlimited)).length;
  }
}

function matchesQuery(record: PersistentMemoryRecord, query: MemoryQuery): boolean {
  if (query.kinds && !query.kinds.includes(record.kind)) return false;
  if (query.runId && record.runId !== query.runId) return false;
  if (query.goalId && record.goalId !== query.goalId) return false;
  if (query.tags && !query.tags.every((tag) => record.tags.includes(tag))) return false;
  if (query.createdAfter && record.createdAt <= query.createdAfter) return false;
  return true;
}
