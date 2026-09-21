import { describe, expect, it } from 'vitest';
import { asGoalId, asMemoryRecordId, asRetrievalId, asRunId } from '../../src/domain/ids.js';
import { HybridRetriever } from '../../src/memory/hybrid-retriever.js';
import { IndexedMemoryStore } from '../../src/memory/indexed-memory-store.js';
import { LexicalRetriever } from '../../src/memory/lexical-retriever.js';
import type { KnowledgeRecord } from '../../src/memory/records.js';
import type { RetrievalQuery, SemanticIndex } from '../../src/memory/retrieval.js';
import { SqliteMemoryStore } from '../../src/memory/sqlite/sqlite-memory-store.js';
import { SqliteSemanticIndex } from '../../src/memory/sqlite/sqlite-semantic-index.js';
import { ModelProviderError } from '../../src/models/errors.js';
import { FixedClock } from '../support/deterministic.js';
import { FakeEmbeddingProvider } from '../support/fake-embedding-provider.js';
import { InMemoryMemoryStore } from '../support/in-memory-memory-store.js';
import { ALL_RECORDS, knowledge, lesson } from '../support/memory-store-contract.js';

const correlation = { runId: asRunId('run-q'), goalId: asGoalId('goal-q') };
const ALL_KINDS = ['knowledge', 'experience', 'decision', 'lesson'] as const;
const query = (text: string, extra: Partial<RetrievalQuery> = {}): RetrievalQuery => ({
  retrievalId: asRetrievalId('ret-1'),
  text,
  kinds: ALL_KINDS,
  limit: 5,
  correlation,
  ...extra,
});

/** A record about a different topic, to prove unrelated text is not pulled in by the semantic stage. */
const weather: KnowledgeRecord = {
  ...knowledge,
  recordId: asMemoryRecordId('kn-weather'),
  createdAt: '2026-01-01T00:00:04.000Z',
  summary: 'Weather forecast says rain',
  tags: ['weather'],
  title: 'Forecast',
  content: 'Rain expected tomorrow; temperature 12 degrees.',
};

async function seeded(embeddings = new FakeEmbeddingProvider()) {
  const index = SqliteSemanticIndex.open({ path: ':memory:', embeddings });
  const inner = SqliteMemoryStore.open({ path: ':memory:' });
  const store = new IndexedMemoryStore(inner, index);
  for (const record of [...ALL_RECORDS, weather]) await store.put(record);
  const clock = new FixedClock();
  return {
    store,
    index,
    embeddings,
    hybrid: new HybridRetriever(store, index, clock),
    lexical: new LexicalRetriever(store, clock),
  };
}

describe('HybridRetriever', () => {
  it('finds a paraphrase with zero keyword overlap through the semantic stage, where the lexical retriever finds nothing', async () => {
    const { hybrid, lexical } = await seeded();
    // No word here appears in the knowledge record ("report", "sources", "section", ...).
    const text = 'a memo with a bibliography';

    const nothing = await lexical.retrieve(query(text));
    expect(nothing.hits).toEqual([]);

    const result = await hybrid.retrieve(query(text));
    expect(result.signalsUsed).toEqual(['metadata', 'keyword', 'semantic']);
    expect(result.degraded).toBeUndefined();
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.record.recordId).toBe(knowledge.recordId);
    expect(result.hits[0]!.matchedBy).toEqual(['metadata', 'semantic']);
    expect(result.hits.map((h) => h.record.recordId)).not.toContain(weather.recordId);
  });

  it('reports both signals on a hit when keywords and meaning agree, and scores them additively', async () => {
    const { hybrid } = await seeded();
    const result = await hybrid.retrieve(query('research report sources'));
    const top = result.hits[0]!;
    expect(top.record.recordId).toBe(knowledge.recordId);
    expect(top.matchedBy).toEqual(['metadata', 'keyword', 'semantic']);
    // all three terms present → keyword coverage 1; cosine adds up to 1 more
    expect(top.score).toBeGreaterThan(1);
    expect(top.score).toBeLessThanOrEqual(2);
  });

  it('lets the metadata stage decide eligibility: the semantic stage only ranks within the filtered candidates', async () => {
    const { hybrid, index } = await seeded();
    const seen: (readonly string[] | undefined)[] = [];
    const spy: SemanticIndex = {
      index: (id, text) => index.index(id, text),
      remove: (id) => index.remove(id),
      contains: (id) => index.contains(id),
      search: (text, limit, options) => {
        seen.push(options?.within);
        return index.search(text, limit, options);
      },
    };
    const retriever = new HybridRetriever((await seeded()).store, spy, new FixedClock());
    const result = await retriever.retrieve(
      query('a memo with a bibliography', { kinds: ['lesson'] }),
    );
    expect(seen).toEqual([[lesson.recordId]]);
    expect(result.hits.map((h) => h.record.recordId)).toEqual([lesson.recordId]);
    expect(result.hits[0]!.matchedBy).toEqual(['metadata', 'semantic']);
    void hybrid;
  });

  it('does not count weak similarity as a match: unrelated records stay out unless a keyword hits', async () => {
    const { hybrid } = await seeded();
    const result = await hybrid.retrieve(query('bake a recipe in the oven'));
    expect(result.hits).toEqual([]);
    expect(result.signalsUsed).toEqual(['metadata', 'keyword', 'semantic']);
  });

  it('degrades honestly when the embedding endpoint fails: lexical hits only, semantic not claimed, reason recorded', async () => {
    const embeddings = new FakeEmbeddingProvider();
    const { hybrid } = await seeded(embeddings);
    embeddings.failNext(new ModelProviderError('no response within 60000 ms', 'timeout'));

    const result = await hybrid.retrieve(query('research report sources'));
    expect(result.signalsUsed).toEqual(['metadata', 'keyword']);
    expect(result.degraded).toEqual([
      { signal: 'semantic', reason: 'no response within 60000 ms' },
    ]);
    expect(result.hits[0]!.record.recordId).toBe(knowledge.recordId);
    for (const hit of result.hits) expect(hit.matchedBy).toEqual(['metadata', 'keyword']);

    // A paraphrase finds nothing while degraded — the weaker retrieval is visible, not papered over.
    embeddings.failNext(new ModelProviderError('down', 'network'));
    const paraphrase = await hybrid.retrieve(query('a memo with a bibliography'));
    expect(paraphrase.hits).toEqual([]);
    expect(paraphrase.degraded?.[0]?.signal).toBe('semantic');
  });

  it('without an index it behaves like the lexical retriever and never mentions semantic', async () => {
    const store = new InMemoryMemoryStore();
    for (const record of ALL_RECORDS) await store.put(record);
    const clock = new FixedClock();
    const hybrid = new HybridRetriever(store, undefined, clock);
    const lexical = new LexicalRetriever(store, clock);
    const text = 'Produce a research report that has a Sources section';
    const a = await hybrid.retrieve(query(text));
    const b = await lexical.retrieve(query(text));
    expect(a.hits.map((h) => h.record.recordId)).toEqual(b.hits.map((h) => h.record.recordId));
    expect(a.signalsUsed).toEqual(['metadata', 'keyword']);
    expect(a.degraded).toBeUndefined();
    for (const hit of a.hits) expect(hit.matchedBy).toEqual(['metadata', 'keyword']);
  });

  it('still finds records that were never embedded through keywords, and ranks deterministically across stores', async () => {
    const embeddings = new FakeEmbeddingProvider().failNext(
      new ModelProviderError('down', 'network'),
    );
    const { hybrid, store, index } = await seeded(embeddings);
    // The first put (knowledge) failed to embed; it is still there lexically.
    expect(store.failures.map((f) => f.recordId)).toEqual([knowledge.recordId]);
    expect(await index.contains(knowledge.recordId)).toBe(false);

    const result = await hybrid.retrieve(query('research report sources section'));
    expect(result.signalsUsed).toContain('semantic'); // the stage ran for the others
    const kn = result.hits.find((h) => h.record.recordId === knowledge.recordId)!;
    expect(kn.matchedBy).toEqual(['metadata', 'keyword']);
    expect(kn.score).toBe(1); // full keyword coverage, no semantic boost available
    // An indexed record with partial keyword coverage plus meaning outranks it — the
    // missing embedding costs the unindexed record its semantic boost, visibly.
    expect(result.hits[0]!.record.recordId).toBe(lesson.recordId);
    expect(result.hits[0]!.matchedBy).toEqual(['metadata', 'keyword', 'semantic']);

    const again = await hybrid.retrieve(query('research report sources section'));
    expect(again.hits.map((h) => [h.record.recordId, h.score])).toEqual(
      result.hits.map((h) => [h.record.recordId, h.score]),
    );
  });

  it('returns nothing and runs no stage beyond metadata for an empty query, and respects the limit', async () => {
    const { hybrid, embeddings } = await seeded();
    const calls = embeddings.callCount;
    expect((await hybrid.retrieve(query('   '))).hits).toEqual([]);
    expect(embeddings.callCount).toBe(calls);
    const limited = await hybrid.retrieve(query('research report sources section', { limit: 1 }));
    expect(limited.hits).toHaveLength(1);
  });
});
