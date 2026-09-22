import { describe, expect, it } from 'vitest';
import { asGoalId, asMemoryRecordId, asRetrievalId, asRunId } from '../../src/domain/ids.js';
import { HybridRetriever, selectWithKindDiversity } from '../../src/memory/hybrid-retriever.js';
import { IndexedMemoryStore } from '../../src/memory/indexed-memory-store.js';
import type {
  DecisionRecord,
  ExperienceRecord,
  KnowledgeRecord,
  PersistentMemoryRecord,
} from '../../src/memory/records.js';
import type { RetrievalHit, RetrievalQuery } from '../../src/memory/retrieval.js';
import { SqliteMemoryStore } from '../../src/memory/sqlite/sqlite-memory-store.js';
import { SqliteSemanticIndex } from '../../src/memory/sqlite/sqlite-semantic-index.js';
import { FixedClock } from '../support/deterministic.js';
import { FakeEmbeddingProvider } from '../support/fake-embedding-provider.js';
import { decision, experience, knowledge } from '../support/memory-store-contract.js';

/**
 * Reproduces E-009's first batch deterministically: the agent's own
 * bookkeeping about a task is phrased in the goal's words and embeds close
 * to the goal, so a single score-ordered list can hold only bookkeeping and
 * drop the one record that came from the world.
 */
const correlation = { runId: asRunId('run-q'), goalId: asGoalId('goal-q') };
const query = (text: string, extra: Partial<RetrievalQuery> = {}): RetrievalQuery => ({
  retrievalId: asRetrievalId('ret-1'),
  text,
  kinds: ['knowledge', 'experience', 'decision', 'lesson'],
  limit: 5,
  correlation,
  ...extra,
});

/** Bookkeeping written while doing "write the report file", in those words. */
function bookkeeping(): PersistentMemoryRecord[] {
  const records: PersistentMemoryRecord[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const exp: ExperienceRecord = {
      ...experience,
      recordId: asMemoryRecordId(`exp-${i}`),
      createdAt: `2026-01-01T00:00:0${i}.000Z`,
      summary: `fs.write → ${i === 3 ? 'success' : 'failure'}`,
      inputSummary: 'write the report file',
      attempt: i,
    };
    records.push(exp);
  }
  for (let i = 1; i <= 2; i += 1) {
    const dec: DecisionRecord = {
      ...decision,
      recordId: asMemoryRecordId(`dec-${i}`),
      createdAt: `2026-01-01T00:00:1${i}.000Z`,
      summary: 'Chose fs.write to write the report file',
      context: 'write the report file',
      reason: 'fs.write writes the report file directly',
    };
    records.push(dec);
  }
  return records;
}

/** What the world said, in the world's words: no term in common with "write the report file". */
const stylePage: KnowledgeRecord = {
  ...knowledge,
  recordId: asMemoryRecordId('kn-style'),
  createdAt: '2026-01-01T00:00:20.000Z',
  summary: 'House style for documents',
  tags: ['ingested', 'web.fetch'],
  title: 'House style',
  content:
    'Every document, paper or memo ends with its citations listed one per line, otherwise the artifact is incomplete.',
};

async function seeded() {
  const embeddings = new FakeEmbeddingProvider();
  const index = SqliteSemanticIndex.open({ path: ':memory:', embeddings });
  const inner = SqliteMemoryStore.open({ path: ':memory:' });
  const store = new IndexedMemoryStore(inner, index);
  for (const record of [...bookkeeping(), stylePage]) await store.put(record);
  const clock = new FixedClock();
  return { store, index, clock };
}

describe('HybridRetriever · kind diversity', () => {
  const GOAL = 'write the report file';

  it('without diversity, a limit of 5 holds only the agent’s own bookkeeping and the ingested page is dropped', async () => {
    const { store, index, clock } = await seeded();
    const plain = new HybridRetriever(store, index, clock, { kindDiversity: false });
    const result = await plain.retrieve(query(GOAL));
    expect(result.hits).toHaveLength(5);
    expect(result.hits.map((h) => h.record.kind)).not.toContain('knowledge');
    // The page *was* a semantic match — it just ranked 6th of 6.
    const wide = await plain.retrieve(query(GOAL, { limit: 10 }));
    const page = wide.hits.find((h) => h.record.recordId === stylePage.recordId);
    expect(page?.matchedBy).toEqual(['metadata', 'semantic']);
    expect(wide.hits.indexOf(page!)).toBe(5);
  });

  it('with diversity (the default), the best hit of every kind that matched is kept, and the list stays score-ordered', async () => {
    const { store, index, clock } = await seeded();
    const result = await new HybridRetriever(store, index, clock).retrieve(query(GOAL));
    expect(result.hits).toHaveLength(5);
    const kinds = result.hits.map((h) => h.record.kind);
    expect(kinds).toContain('knowledge');
    expect(kinds).toContain('experience');
    expect(kinds).toContain('decision');
    expect(result.hits.at(-1)?.record.recordId).toBe(stylePage.recordId);
    for (let i = 1; i < result.hits.length; i += 1) {
      expect(result.hits[i - 1]!.score).toBeGreaterThanOrEqual(result.hits[i]!.score);
    }
    // Diversity never invents a hit: the page still carries exactly the signals that matched it.
    const page = result.hits.find((h) => h.record.recordId === stylePage.recordId);
    expect(page?.matchedBy).toEqual(['metadata', 'semantic']);
  });

  it('never includes a kind that had no hit, and changes nothing when everything fits', async () => {
    const { store, index, clock } = await seeded();
    const hybrid = new HybridRetriever(store, index, clock);
    const all = await hybrid.retrieve(query(GOAL, { limit: 10 }));
    expect(all.hits).toHaveLength(6);
    expect(all.hits.map((h) => h.record.kind)).not.toContain('lesson');
    const knowledgeOnly = await hybrid.retrieve(query(GOAL, { kinds: ['knowledge'], limit: 5 }));
    expect(knowledgeOnly.hits.map((h) => h.record.recordId)).toEqual([stylePage.recordId]);
  });
});

describe('selectWithKindDiversity', () => {
  const hit = (id: string, kind: PersistentMemoryRecord['kind'], score: number): RetrievalHit => ({
    record: { ...knowledge, recordId: asMemoryRecordId(id), kind } as PersistentMemoryRecord,
    score,
    matchedBy: ['metadata', 'keyword'],
  });
  const ranked = [
    hit('a', 'lesson', 1.0),
    hit('b', 'experience', 0.9),
    hit('c', 'experience', 0.85),
    hit('d', 'decision', 0.8),
    hit('e', 'decision', 0.75),
    hit('f', 'knowledge', 0.55),
  ];

  it('keeps the best of each kind first, then fills by rank, then re-sorts by score', () => {
    expect(selectWithKindDiversity(ranked, 5).map((h) => h.record.recordId)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'f',
    ]);
    expect(selectWithKindDiversity(ranked, 4).map((h) => h.record.recordId)).toEqual([
      'a',
      'b',
      'd',
      'f',
    ]);
  });

  it('with fewer slots than kinds, the globally best hits win — diversity never demotes the top result', () => {
    expect(selectWithKindDiversity(ranked, 2).map((h) => h.record.recordId)).toEqual(['a', 'b']);
    expect(selectWithKindDiversity(ranked, 1).map((h) => h.record.recordId)).toEqual(['a']);
    expect(selectWithKindDiversity(ranked, 0)).toEqual([]);
  });

  it('is the identity when the list already fits', () => {
    for (const limit of [6, 100]) {
      const selected = selectWithKindDiversity(ranked, limit);
      expect(selected.map((hit) => hit.record.recordId)).toEqual(
        ranked.map((hit) => hit.record.recordId),
      );
      expect(selected.map((hit) => hit.score)).toEqual(ranked.map((hit) => hit.score));
      expect(selected.every((hit) => hit.keptByDiversity === false)).toBe(true);
      expect(selected.map((hit) => hit.finalRank)).toEqual(ranked.map((_, index) => index + 1));
    }
  });
});
