import type { MemoryRecordId } from '../../domain/ids.js';
import { MemoryStoreError } from '../../memory/errors.js';
import {
  type MemoryRecordOfKind,
  type PersistentMemoryKind,
  type PersistentMemoryRecord,
} from '../../memory/records.js';
import type { MemoryQuery, MemoryStore } from '../../memory/store.js';
import { assertStorableRecord, parseStoredRecord } from '../../memory/validate.js';
import type { PgClient } from './pg-client.js';

/**
 * `MemoryStore` on Postgres (Neon). The JSON body is the source of truth;
 * kind, run, goal, task, time, and tags are a query index derived on write.
 * `agent_memory_put` refuses a record id owned by a different run.
 */
export class NeonMemoryStore implements MemoryStore {
  constructor(private readonly db: PgClient) {}

  async put(record: PersistentMemoryRecord): Promise<void> {
    assertStorableRecord(record);
    await this.db.query('SELECT agent_memory_put($1, $2, $3, $4, $5, $6, $7, $8, $9::text[])', [
      record.recordId,
      record.kind,
      record.runId,
      record.goalId ?? null,
      record.taskId ?? null,
      record.createdAt,
      record.summary,
      JSON.stringify(record),
      [...record.tags],
    ]);
  }

  async get(recordId: MemoryRecordId): Promise<PersistentMemoryRecord | undefined> {
    const rows = await this.db.query<RecordRow>(
      'SELECT record_id, kind, body FROM agent_memory_records WHERE record_id = $1',
      [recordId],
    );
    const row = rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async getOfKind<K extends PersistentMemoryKind>(
    kind: K,
    recordId: MemoryRecordId,
  ): Promise<MemoryRecordOfKind<K> | undefined> {
    const record = await this.get(recordId);
    return record && record.kind === kind ? (record as MemoryRecordOfKind<K>) : undefined;
  }

  async query(query: MemoryQuery): Promise<readonly PersistentMemoryRecord[]> {
    const { where, params } = whereClause(query);
    let limit = '';
    if (query.limit !== undefined) {
      params.push(Math.max(0, Math.floor(query.limit)));
      limit = ` LIMIT $${params.length}`;
    }
    const rows = await this.db.query<RecordRow>(
      `SELECT record_id, kind, body FROM agent_memory_records${where} ORDER BY created_at, seq${limit}`,
      params,
    );
    return rows.map(rowToRecord);
  }

  async count(query: MemoryQuery = {}): Promise<number> {
    const { where, params } = whereClause(query);
    const rows = await this.db.query<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM agent_memory_records${where}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  }
}

interface RecordRow extends Record<string, unknown> {
  record_id: string;
  kind: string;
  body: string;
}

type SqlParam = string | number | null;

function whereClause(query: MemoryQuery): { where: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const add = (clause: string, value: SqlParam) => {
    params.push(value);
    clauses.push(clause.replace('?', `$${params.length}`));
  };
  if (query.kinds !== undefined) {
    if (query.kinds.length === 0) clauses.push('FALSE');
    else {
      const placeholders = query.kinds.map((kind) => {
        params.push(kind);
        return `$${params.length}`;
      });
      clauses.push(`kind IN (${placeholders.join(', ')})`);
    }
  }
  if (query.runId !== undefined) add('run_id = ?', query.runId);
  if (query.goalId !== undefined) add('goal_id = ?', query.goalId);
  if (query.tags !== undefined && query.tags.length > 0) {
    const distinct = [...new Set(query.tags)];
    const placeholders = distinct.map((tag) => {
      params.push(tag);
      return `$${params.length}`;
    });
    params.push(distinct.length);
    clauses.push(
      `record_id IN (SELECT record_id FROM agent_memory_record_tags WHERE tag IN (${placeholders.join(', ')}) GROUP BY record_id HAVING COUNT(DISTINCT tag) = $${params.length})`,
    );
  }
  if (query.createdAfter !== undefined) add('created_at > ?', query.createdAfter);
  return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

function rowToRecord(row: RecordRow): PersistentMemoryRecord {
  if (
    typeof row.body !== 'string' ||
    typeof row.record_id !== 'string' ||
    typeof row.kind !== 'string'
  ) {
    throw new MemoryStoreError(
      'Stored memory record row is missing its body',
      'corrupt_record',
      typeof row.record_id === 'string' ? row.record_id : undefined,
    );
  }
  return parseStoredRecord(row.body, row.record_id, row.kind);
}
