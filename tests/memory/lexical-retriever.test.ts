import { describe, expect, it } from 'vitest';
import { asGoalId, asRetrievalId, asRunId } from '../../src/domain/ids.js';
import { LexicalRetriever } from '../../src/memory/lexical-retriever.js';
import type { PersistentMemoryRecord } from '../../src/memory/records.js';
import { SqliteMemoryStore } from '../../src/memory/sqlite/sqlite-memory-store.js';
import { FixedClock } from '../support/deterministic.js';
import { InMemoryMemoryStore } from '../support/in-memory-memory-store.js';
import { decision, experience, knowledge, lesson } from '../support/memory-store-contract.js';

const correlation = { runId: asRunId('run-q'), goalId: asGoalId('goal-q') };
const query = (text: string, extra: Partial<Parameters<LexicalRetriever['retrieve']>[0]> = {}) => ({
  retrievalId: asRetrievalId('ret-1'),
  text,
  kinds: ['knowledge', 'experience', 'decision', 'lesson'] as const,
  limit: 5,
  correlation,
  ...extra,
});

async function seeded(store: InMemoryMemoryStore | SqliteMemoryStore) {
  for (const record of [knowledge, experience, decision, lesson]) await store.put(record);
  return new LexicalRetriever(store, new FixedClock());
}

describe('LexicalRetriever', () => {
  it('ranks by distinct-term overlap, ignores stopwords and short tokens, and never claims semantic', async () => {
    const retriever = await seeded(new InMemoryMemoryStore());
    const result = await retriever.retrieve(
      query('Produce a research report that has a Sources section'),
    );
    // knowledge: research, report, sources, section (4); lesson: report, sources, section (3);
    // experience: report, sources (2); decision: produce, report (2) — tie broken by record id.
    expect(result.hits.map((h) => [h.record.recordId, h.score])).toEqual([
      ['kn-1', 4],
      ['les-1', 3],
      ['dec-1', 2],
      ['exp-1', 2],
    ]);
    expect(result.signalsUsed).toEqual(['metadata', 'keyword']);
    for (const hit of result.hits) expect(hit.matchedBy).toEqual(['metadata', 'keyword']);
    expect(result.retrievalId).toBe('ret-1');
  });

  it('returns nothing rather than everything when the query has no usable terms', async () => {
    const retriever = await seeded(new InMemoryMemoryStore());
    expect((await retriever.retrieve(query('a to the of'))).hits).toEqual([]);
    expect((await retriever.retrieve(query(''))).hits).toEqual([]);
  });

  it('applies the metadata filter (kinds, tags) before scoring and honours the limit', async () => {
    const retriever = await seeded(new InMemoryMemoryStore());
    const onlyLessons = await retriever.retrieve(
      query('report sources section', { kinds: ['lesson'] }),
    );
    expect(onlyLessons.hits.map((h) => h.record.recordId)).toEqual(['les-1']);
    const tagged = await retriever.retrieve(query('fs.write report', { tags: ['contrast'] }));
    expect(tagged.hits.map((h) => h.record.recordId)).toEqual(['les-1']);
    const limited = await retriever.retrieve(
      query('research report sources section', { limit: 1 }),
    );
    expect(limited.hits).toHaveLength(1);
    expect(limited.hits[0]?.record.recordId).toBe('kn-1');
  });

  it('breaks ties deterministically: newer record first, then record id', async () => {
    const store = new InMemoryMemoryStore();
    const twin = (id: string, createdAt: string): PersistentMemoryRecord => ({
      ...knowledge,
      recordId: knowledge.recordId.replace('kn-1', id) as typeof knowledge.recordId,
      createdAt,
    });
    await store.put(twin('kn-old', '2026-01-01T00:00:00.000Z'));
    await store.put(twin('kn-new', '2026-01-02T00:00:00.000Z'));
    await store.put(twin('kn-also-new', '2026-01-02T00:00:00.000Z'));
    const retriever = new LexicalRetriever(store, new FixedClock());
    const result = await retriever.retrieve(query('report format'));
    expect(result.hits.map((h) => h.record.recordId)).toEqual(['kn-also-new', 'kn-new', 'kn-old']);
  });

  it('produces the same ranking over the SQLite store as over the test store', async () => {
    const sqlite = SqliteMemoryStore.open({ path: ':memory:' });
    try {
      const a = await seeded(new InMemoryMemoryStore());
      const b = await seeded(sqlite);
      const text = 'write the report file with fs.write and a Sources section';
      const ra = await a.retrieve(query(text));
      const rb = await b.retrieve(query(text));
      expect(rb.hits.map((h) => [h.record.recordId, h.score])).toEqual(
        ra.hits.map((h) => [h.record.recordId, h.score]),
      );
      expect(rb.hits.length).toBeGreaterThan(0);
    } finally {
      sqlite.close();
    }
  });
});
