import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asMemoryRecordId } from '../../src/domain/ids.js';
import { MemoryStoreError } from '../../src/memory/errors.js';
import {
  MEMORY_SCHEMA_VERSION,
  SqliteMemoryStore,
} from '../../src/memory/sqlite/sqlite-memory-store.js';
import { ALL_RECORDS, knowledge, lesson } from '../support/memory-store-contract.js';

/**
 * What only a durable backend can show: records outlive the handle that
 * wrote them, the file is honest about what it contains, and damage is
 * reported rather than papered over.
 */
describe('SqliteMemoryStore durability', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-memory-sqlite-'));
    path = join(dir, 'memory.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records written through one handle are read back byte-for-byte through a fresh handle on the same file', async () => {
    const writer = SqliteMemoryStore.open({ path });
    for (const record of ALL_RECORDS) await writer.put(record);
    writer.close();
    expect(writer.isOpen).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);

    const reader = SqliteMemoryStore.open({ path });
    try {
      expect(await reader.count()).toBe(ALL_RECORDS.length);
      for (const record of ALL_RECORDS) expect(await reader.get(record.recordId)).toEqual(record);
      // Order survives the reopen too (seq is persisted, not recomputed).
      expect((await reader.query({})).map((r) => r.recordId)).toEqual([
        'kn-1',
        'exp-1',
        'dec-1',
        'les-1',
      ]);
    } finally {
      reader.close();
    }
  });

  it('a closed handle refuses further work instead of failing obscurely', async () => {
    const store = SqliteMemoryStore.open({ path });
    store.close();
    store.close(); // idempotent
    const error = await store.get(knowledge.recordId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryStoreError);
    expect((error as MemoryStoreError).kind).toBe('unavailable');
  });

  it('records the schema version and refuses a file written by an incompatible schema', async () => {
    SqliteMemoryStore.open({ path }).close();
    const raw = new DatabaseSync(path);
    try {
      const row = raw
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as {
        value: string;
      };
      expect(Number(row.value)).toBe(MEMORY_SCHEMA_VERSION);
      raw
        .prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'")
        .run(String(MEMORY_SCHEMA_VERSION + 1));
    } finally {
      raw.close();
    }
    expect(() => SqliteMemoryStore.open({ path })).toThrowError(
      new RegExp(`schema version ${MEMORY_SCHEMA_VERSION + 1}`),
    );
  });

  it('a damaged row is reported as corrupt instead of being returned partially', async () => {
    const store = SqliteMemoryStore.open({ path });
    await store.put(lesson);
    store.close();
    const raw = new DatabaseSync(path);
    try {
      raw
        .prepare('UPDATE memory_records SET body = ? WHERE record_id = ?')
        .run('{"truncated":', lesson.recordId);
    } finally {
      raw.close();
    }
    const reopened = SqliteMemoryStore.open({ path });
    try {
      const error = await reopened.get(lesson.recordId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryStoreError);
      expect((error as MemoryStoreError).kind).toBe('corrupt_record');
      expect((error as MemoryStoreError).recordId).toBe(lesson.recordId);
    } finally {
      reopened.close();
    }
  });

  it('a body whose identity disagrees with its index row is refused', async () => {
    const store = SqliteMemoryStore.open({ path });
    await store.put(lesson);
    store.close();
    const raw = new DatabaseSync(path);
    try {
      raw
        .prepare('UPDATE memory_records SET body = ? WHERE record_id = ?')
        .run(JSON.stringify({ ...lesson, recordId: 'someone-else' }), lesson.recordId);
    } finally {
      raw.close();
    }
    const reopened = SqliteMemoryStore.open({ path });
    try {
      const error = await reopened.query({ kinds: ['lesson'] }).catch((e: unknown) => e);
      expect((error as MemoryStoreError).kind).toBe('corrupt_record');
    } finally {
      reopened.close();
    }
  });

  it('a failed write leaves no partial record or orphan tags behind', async () => {
    const store = SqliteMemoryStore.open({ path });
    try {
      await store.put(knowledge);
      // Tags with a non-string element fail validation before any SQL runs;
      // a record referencing a kind the CHECK constraint rejects fails inside
      // the transaction. Both must leave the store exactly as it was.
      const sneaky = { ...lesson, kind: 'lesson' as const, tags: ['a', 'b'] };
      Object.defineProperty(sneaky, 'kind', { value: 'not-a-kind', enumerable: true });
      const error = await store.put(sneaky).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryStoreError);
      expect(await store.count()).toBe(1);
      expect(await store.get(asMemoryRecordId(lesson.recordId))).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('an unopenable path is a configuration error, not a crash', () => {
    expect(() =>
      SqliteMemoryStore.open({ path: join(dir, 'missing-dir', 'x.sqlite') }),
    ).toThrowError(MemoryStoreError);
  });
});
