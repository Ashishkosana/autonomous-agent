import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asMemoryRecordId } from '../../src/domain/ids.js';
import { MemoryStoreError } from '../../src/memory/errors.js';
import { IndexedMemoryStore } from '../../src/memory/indexed-memory-store.js';
import { searchableText } from '../../src/memory/searchable-text.js';
import { SqliteMemoryStore } from '../../src/memory/sqlite/sqlite-memory-store.js';
import { SqliteSemanticIndex } from '../../src/memory/sqlite/sqlite-semantic-index.js';
import { ModelProviderError } from '../../src/models/errors.js';
import { FakeEmbeddingProvider } from '../support/fake-embedding-provider.js';
import { InMemoryMemoryStore } from '../support/in-memory-memory-store.js';
import {
  ALL_RECORDS,
  decision,
  experience,
  knowledge,
  lesson,
} from '../support/memory-store-contract.js';

const id = asMemoryRecordId;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-semantic-'));
  dirs.push(dir);
  return dir;
}

describe('SqliteSemanticIndex', () => {
  it('indexes text and finds the closest records by cosine similarity, highest first, ids stable on ties', async () => {
    const embeddings = new FakeEmbeddingProvider();
    const index = SqliteSemanticIndex.open({ path: ':memory:', embeddings });
    await index.index(id('a'), 'a research report with a sources section');
    await index.index(id('b'), 'the weather forecast says rain');
    await index.index(id('c'), 'bake a recipe in the oven');

    // Paraphrase: no word in common with record a, but the same concepts.
    const matches = await index.search('a document with citations', 3);
    expect(matches.map((m) => m.recordId)).toEqual(['a', 'b', 'c']);
    expect(matches[0]!.score).toBeGreaterThan(0.9);
    expect(matches[1]!.score).toBeLessThan(0.2);
    expect(await index.count()).toBe(3);
    expect(await index.contains(id('a'))).toBe(true);
    expect(await index.contains(id('zzz'))).toBe(false);
    index.close();
  });

  it('restricts search to the given candidate ids, returns nothing for an empty candidate set, and honours the limit', async () => {
    const index = SqliteSemanticIndex.open({
      path: ':memory:',
      embeddings: new FakeEmbeddingProvider(),
    });
    await index.index(id('a'), 'report with sources');
    await index.index(id('b'), 'report with citations');
    await index.index(id('c'), 'weather');
    expect(
      (await index.search('document references', 5, { within: [id('c'), id('b')] })).map(
        (m) => m.recordId,
      ),
    ).toEqual(['b', 'c']);
    expect(await index.search('document references', 5, { within: [] })).toEqual([]);
    expect(await index.search('document references', 1)).toHaveLength(1);
    expect(await index.search('document references', 0)).toEqual([]);
    expect(await index.search('   ', 5)).toEqual([]);
    index.close();
  });

  it('does not re-embed unchanged text (hash match) but does re-embed changed text', async () => {
    const embeddings = new FakeEmbeddingProvider();
    const index = SqliteSemanticIndex.open({ path: ':memory:', embeddings });
    await index.index(id('a'), 'same text');
    await index.index(id('a'), 'same text');
    expect(embeddings.callCount).toBe(1);
    await index.index(id('a'), 'different text');
    expect(embeddings.callCount).toBe(2);
    expect(await index.count()).toBe(1);
    index.close();
  });

  it('survives close and reopen on a real file: vectors persist, search works in a new handle', async () => {
    const path = join(tempDir(), 'semantic.sqlite');
    const first = SqliteSemanticIndex.open({ path, embeddings: new FakeEmbeddingProvider() });
    await first.index(id('a'), 'python interpreter failure');
    first.close();

    const second = SqliteSemanticIndex.open({ path, embeddings: new FakeEmbeddingProvider() });
    expect(await second.count()).toBe(1);
    const matches = await second.search('the python3 script is broken', 1);
    expect(matches[0]?.recordId).toBe('a');
    expect(matches[0]!.score).toBeGreaterThan(0.8);
    second.close();
  });

  it("shares the memory store's database file without interfering with its tables", async () => {
    const path = join(tempDir(), 'memory.sqlite');
    const store = SqliteMemoryStore.open({ path });
    const index = SqliteSemanticIndex.open({ path, embeddings: new FakeEmbeddingProvider() });
    for (const record of ALL_RECORDS) {
      await store.put(record);
      await index.index(record.recordId, searchableText(record));
    }
    expect(await store.count()).toBe(4);
    expect(await index.count()).toBe(4);
    store.close();
    index.close();
    // Both reopen against the same file with their own schema versions intact.
    const store2 = SqliteMemoryStore.open({ path });
    const index2 = SqliteSemanticIndex.open({ path, embeddings: new FakeEmbeddingProvider() });
    expect(await store2.count()).toBe(4);
    expect(await index2.count()).toBe(4);
    store2.close();
    index2.close();
  });

  it('ignores vectors written by another embedding model instead of comparing incompatible spaces', async () => {
    const path = join(tempDir(), 'semantic.sqlite');
    const oldModel = SqliteSemanticIndex.open({
      path,
      embeddings: new FakeEmbeddingProvider('old'),
    });
    await oldModel.index(id('a'), 'report with sources');
    oldModel.close();

    const newModel = SqliteSemanticIndex.open({
      path,
      embeddings: new FakeEmbeddingProvider('new'),
    });
    expect(await newModel.count()).toBe(0);
    expect(await newModel.contains(id('a'))).toBe(false);
    expect(await newModel.search('document with citations', 5)).toEqual([]);
    // Re-indexing under the new model replaces the row.
    await newModel.index(id('a'), 'report with sources');
    expect(await newModel.count()).toBe(1);
    expect((await newModel.search('document with citations', 5))[0]?.recordId).toBe('a');
    newModel.close();
  });

  it('propagates embedding failures unchanged and refuses empty text or a closed handle', async () => {
    const embeddings = new FakeEmbeddingProvider().failNext(
      new ModelProviderError('down', 'network'),
    );
    const index = SqliteSemanticIndex.open({ path: ':memory:', embeddings });
    await expect(index.index(id('a'), 'text')).rejects.toMatchObject({ kind: 'network' });
    await expect(index.index(id('a'), '   ')).rejects.toMatchObject({
      kind: 'invalid_record',
    } satisfies Partial<MemoryStoreError>);
    expect(await index.count()).toBe(0);
    index.close();
    await expect(index.search('x', 1)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(index.isOpen).toBe(false);
  });

  it('refuses an unopenable path as a configuration error and a foreign schema version', () => {
    expect(() =>
      SqliteSemanticIndex.open({
        path: join(tempDir(), 'missing', 'dir', 'x.sqlite'),
        embeddings: new FakeEmbeddingProvider(),
      }),
    ).toThrow(/Cannot open semantic index/);
    const path = join(tempDir(), 'semantic.sqlite');
    const index = SqliteSemanticIndex.open({ path, embeddings: new FakeEmbeddingProvider() });
    index.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE schema_meta SET value = '99' WHERE key = 'semantic_schema_version'");
    db.close();
    expect(() =>
      SqliteSemanticIndex.open({ path, embeddings: new FakeEmbeddingProvider() }),
    ).toThrow(/schema version 99/);
  });
});

describe('IndexedMemoryStore', () => {
  it('stores first, then indexes the searchable text of every put; reads pass through', async () => {
    const embeddings = new FakeEmbeddingProvider();
    const index = SqliteSemanticIndex.open({ path: ':memory:', embeddings });
    const store = new IndexedMemoryStore(new InMemoryMemoryStore(), index);
    for (const record of ALL_RECORDS) await store.put(record);

    expect(await store.count()).toBe(4);
    expect(await index.count()).toBe(4);
    expect(embeddings.requests.map((r) => r.purpose)).toEqual(Array(4).fill('index_memory'));
    expect(embeddings.requests[0]!.texts[0]).toBe(searchableText(knowledge));
    expect(await store.get(lesson.recordId)).toEqual(lesson);
    expect(await store.getOfKind('decision', decision.recordId)).toEqual(decision);
    expect((await store.query({ kinds: ['experience'] })).map((r) => r.recordId)).toEqual([
      experience.recordId,
    ]);
    expect(store.failures).toEqual([]);
    index.close();
  });

  it('keeps the record when embedding fails, reports the failure, and backfills it later', async () => {
    const embeddings = new FakeEmbeddingProvider().failNext(
      new ModelProviderError('down', 'network'),
    );
    const index = SqliteSemanticIndex.open({ path: ':memory:', embeddings });
    const reported: string[] = [];
    const store = new IndexedMemoryStore(new InMemoryMemoryStore(), index, {
      onIndexFailure: (f) => reported.push(`${f.kind}:${f.recordId}`),
    });

    await store.put(knowledge); // embedding fails
    await store.put(lesson); // embedding works
    expect(await store.get(knowledge.recordId)).toEqual(knowledge);
    expect(await index.contains(knowledge.recordId)).toBe(false);
    expect(await index.contains(lesson.recordId)).toBe(true);
    expect(reported).toEqual(['knowledge:kn-1']);
    expect(store.failures).toHaveLength(1);
    expect(store.failures[0]!.error).toBeInstanceOf(ModelProviderError);

    const result = await store.backfill();
    expect(result).toEqual({ examined: 2, indexed: 1, failed: 0 });
    expect(await index.contains(knowledge.recordId)).toBe(true);
    expect(await store.backfill()).toEqual({ examined: 2, indexed: 0, failed: 0 });
    index.close();
  });

  it('a store write failure is not masked by indexing: nothing is indexed when put throws', async () => {
    const embeddings = new FakeEmbeddingProvider();
    const index = SqliteSemanticIndex.open({ path: ':memory:', embeddings });
    const store = new IndexedMemoryStore(new InMemoryMemoryStore(), index);
    await store.put(knowledge);
    await expect(store.put({ ...knowledge, runId: 'run-other' as never })).rejects.toMatchObject({
      kind: 'conflict',
    });
    expect(embeddings.callCount).toBe(1);
    index.close();
  });
});
