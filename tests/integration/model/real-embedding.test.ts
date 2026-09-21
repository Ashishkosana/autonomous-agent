import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  asGoalId,
  asLessonId,
  asMemoryRecordId,
  asRetrievalId,
  asRunId,
} from '../../../src/domain/ids.js';
import { SystemClock } from '../../../src/domain/system-clock.js';
import { HybridRetriever } from '../../../src/memory/hybrid-retriever.js';
import { IndexedMemoryStore } from '../../../src/memory/indexed-memory-store.js';
import { LexicalRetriever, lexicalTerms } from '../../../src/memory/lexical-retriever.js';
import {
  UNVALIDATED,
  type KnowledgeRecord,
  type LessonRecord,
} from '../../../src/memory/records.js';
import type { RetrievalQuery, RetrievalResult } from '../../../src/memory/retrieval.js';
import { searchableText } from '../../../src/memory/searchable-text.js';
import { SqliteMemoryStore } from '../../../src/memory/sqlite/sqlite-memory-store.js';
import { SqliteSemanticIndex } from '../../../src/memory/sqlite/sqlite-semantic-index.js';
import {
  createEmbeddingProvider,
  type EmbeddingProviderConfig,
} from '../../../src/models/config.js';
import type { EmbeddingProvider } from '../../../src/models/embeddings.js';
import { cosineSimilarity } from '../../../src/models/embeddings.js';
import { InstrumentedEmbeddingProvider } from '../../../src/models/instrumented-embedding-provider.js';
import type {
  ModelCallFailure,
  ModelCallRecord,
  ModelCallStart,
} from '../../../src/models/contracts.js';
import { SequentialIdGenerator } from '../../support/deterministic.js';
import { recordEvidence } from '../../support/evidence.js';
import { EMBEDDING_CONFIG, EMBEDDING_SUMMARY, describeRealEmbedding } from './embedding-gate.js';

/**
 * E-008 — A REAL EMBEDDING MODEL FINDS WHAT KEYWORDS CANNOT (Phase 7, ADR-006).
 *
 * Hypothesis: with a real embedding endpoint behind the unchanged
 * `EmbeddingProvider` → `SqliteSemanticIndex` → `HybridRetriever` path, a
 * query that shares NO indexable term with a stored record still retrieves
 * that record — and the retrieval says `semantic` did it. The lexical
 * retriever over the same store is the control and must miss.
 *
 * Also measured, not assumed: vector dimensions, per-call latency, that an
 * unrelated record is not pulled in, that keyword and semantic agree when
 * both apply, and that a broken endpoint degrades visibly instead of
 * silently returning a lexical result labelled semantic.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const clock = new SystemClock();
const RUN = asRunId('run-e008-seed');
const GOAL = asGoalId('goal-e008-seed');
const correlation = { runId: asRunId('run-e008-query'), goalId: asGoalId('goal-e008-query') };

/** The record we want found: a sandbox lesson about a missing Python interpreter. */
const pythonLesson: LessonRecord = {
  recordId: asMemoryRecordId('e008-python'),
  kind: 'lesson',
  lessonId: asLessonId('e008-python-lesson'),
  runId: RUN,
  goalId: GOAL,
  createdAt: '2026-01-01T00:00:01.000Z',
  summary: 'python3 absent: apt-get install before running',
  statement:
    'python3: command not found — the sandbox image ships without Python; run apt-get install -y python3 first.',
  applicability: ['shell.run', 'code.run'],
  tags: ['contrast', 'shell.run'],
  confidence: 0.6,
  validation: UNVALIDATED,
  provenance: {},
};

/** Paraphrase of the same situation with, by construction, no indexable term in common. */
const PARAPHRASE_QUERY =
  'the interpreter needed to execute .py programs is unavailable in the container';

const reportKnowledge: KnowledgeRecord = {
  recordId: asMemoryRecordId('e008-report'),
  kind: 'knowledge',
  runId: RUN,
  goalId: GOAL,
  createdAt: '2026-01-01T00:00:02.000Z',
  summary: 'Report format: a Sources section is required',
  tags: ['ingested', 'web.fetch', 'example.test'],
  provenance: {},
  title: 'Research report format',
  content: 'A research report must end with a "## Sources" section listing every source used.',
  sources: [{ url: 'https://example.test/report-style', retrievedAt: '2026-01-01T00:00:00.000Z' }],
  confidence: 0.5,
};

const gitLesson: LessonRecord = {
  ...pythonLesson,
  recordId: asMemoryRecordId('e008-git'),
  lessonId: asLessonId('e008-git-lesson'),
  createdAt: '2026-01-01T00:00:03.000Z',
  summary: 'git commit needs an identity',
  statement:
    'git commit fails with "Author identity unknown" until user.name and user.email are configured.',
  applicability: ['git'],
  tags: ['contrast', 'git'],
};

const weather: KnowledgeRecord = {
  ...reportKnowledge,
  recordId: asMemoryRecordId('e008-weather'),
  createdAt: '2026-01-01T00:00:04.000Z',
  summary: 'Weather forecast says rain',
  tags: ['weather'],
  title: 'Forecast',
  content: 'Rain expected tomorrow afternoon; temperature around 12 degrees with light wind.',
};

const CORPUS = [pythonLesson, reportKnowledge, gitLesson, weather];

const query = (text: string, extra: Partial<RetrievalQuery> = {}): RetrievalQuery => ({
  retrievalId: asRetrievalId('ret-e008'),
  text,
  kinds: ['knowledge', 'experience', 'decision', 'lesson'],
  limit: 5,
  correlation,
  ...extra,
});

interface Telemetry {
  readonly started: ModelCallStart[];
  readonly completed: ModelCallRecord[];
  readonly failed: ModelCallFailure[];
}

function realEmbeddings(
  telemetry: Telemetry,
  override: Partial<Extract<EmbeddingProviderConfig, { kind: 'openai-compatible' }>> = {},
): EmbeddingProvider {
  if (!EMBEDDING_CONFIG || EMBEDDING_CONFIG.kind === 'none') {
    throw new Error('gate should have skipped this file');
  }
  const config = { ...EMBEDDING_CONFIG, ...override };
  return new InstrumentedEmbeddingProvider(
    createEmbeddingProvider(config, { clock, ids: new SequentialIdGenerator() }),
    {
      runId: correlation.runId,
      goalId: correlation.goalId,
      clock,
      ids: new SequentialIdGenerator(),
      onStarted: (r) => telemetry.started.push(r),
      onCall: (r) => telemetry.completed.push(r),
      onFailed: (r) => telemetry.failed.push(r),
    },
  );
}

const hits = (result: RetrievalResult) =>
  result.hits.map((h) => ({
    recordId: h.record.recordId,
    score: Number(h.score.toFixed(4)),
    matchedBy: [...h.matchedBy],
  }));

describeRealEmbedding('E-008 · a real embedding model finds what keywords cannot', () => {
  const telemetry: Telemetry = { started: [], completed: [], failed: [] };
  const evidence: Record<string, unknown> = { embedding: EMBEDDING_SUMMARY };
  let dir: string;
  let indexPath: string;
  let inner: SqliteMemoryStore;
  let index: SqliteSemanticIndex;
  let store: IndexedMemoryStore;
  let hybrid: HybridRetriever;
  let lexical: LexicalRetriever;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-e008-'));
    indexPath = join(dir, 'semantic.sqlite');
    inner = SqliteMemoryStore.open({ path: ':memory:' });
    index = SqliteSemanticIndex.open({ path: indexPath, embeddings: realEmbeddings(telemetry) });
    store = new IndexedMemoryStore(inner, index, {
      onIndexFailure: (f) => {
        throw new Error(`indexing ${f.recordId} failed: ${String(f.error)}`);
      },
    });
    for (const record of CORPUS) await store.put(record);
    hybrid = new HybridRetriever(store, index, clock);
    lexical = new LexicalRetriever(store, clock);
  });

  afterAll(() => {
    evidence['telemetry'] = {
      calls: telemetry.completed.length,
      failures: telemetry.failed.length,
      purposes: [...new Set(telemetry.completed.map((c) => c.purpose))],
      latenciesMs: telemetry.completed.map((c) => c.latencyMs),
      inputTokens: telemetry.completed.map((c) => c.usage.inputTokens),
    };
    recordEvidence('model-e008-real-embedding', evidence);
    index.close();
    inner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the paraphrase shares no indexable term with the target record (the control is fair)', () => {
    const queryTerms = lexicalTerms(PARAPHRASE_QUERY);
    const recordTerms = lexicalTerms(searchableText(pythonLesson));
    const overlap = [...queryTerms].filter((t) => recordTerms.has(t));
    evidence['paraphrase'] = {
      query: PARAPHRASE_QUERY,
      queryTerms: [...queryTerms],
      overlapWithTarget: overlap,
    };
    expect(overlap).toEqual([]);
  });

  it('every record was embedded by the real model, one instrumented call each', async () => {
    for (const record of CORPUS) expect(await index.contains(record.recordId)).toBe(true);
    expect(telemetry.completed.map((c) => c.purpose)).toEqual(CORPUS.map(() => 'embed_memory'));
    expect(telemetry.failed).toEqual([]);
    evidence['indexing'] = {
      records: CORPUS.length,
      embedCalls: telemetry.completed.length,
      latenciesMs: telemetry.completed.map((c) => c.latencyMs),
      inputTokens: telemetry.completed.map((c) => c.usage.inputTokens),
    };
  });

  it('the lexical control misses the target for the paraphrase', async () => {
    const result = await lexical.retrieve(query(PARAPHRASE_QUERY));
    evidence['lexicalControl'] = { signalsUsed: result.signalsUsed, hits: hits(result) };
    expect(result.signalsUsed).not.toContain('semantic');
    expect(result.hits.map((h) => h.record.recordId)).not.toContain(pythonLesson.recordId);
  });

  it('the hybrid retriever finds the target for the paraphrase, by semantic similarity alone', async () => {
    const result = await hybrid.retrieve(query(PARAPHRASE_QUERY));
    evidence['hybridParaphrase'] = {
      signalsUsed: result.signalsUsed,
      degraded: result.degraded ?? [],
      durationMs: result.durationMs,
      hits: hits(result),
    };
    expect(result.signalsUsed).toContain('semantic');
    expect(result.degraded ?? []).toEqual([]);
    const top = result.hits[0];
    expect(top?.record.recordId).toBe(pythonLesson.recordId);
    expect(top?.matchedBy).toEqual(['metadata', 'semantic']);
    expect(result.hits.map((h) => h.record.recordId)).not.toContain(weather.recordId);
  });

  it('the raw similarities agree: target above threshold, unrelated record below it', async () => {
    const embeddings = realEmbeddings(telemetry);
    const { vectors } = await embeddings.embed({
      texts: [PARAPHRASE_QUERY, searchableText(pythonLesson), searchableText(weather)],
      purpose: 'query_memory',
    });
    const toTarget = cosineSimilarity(vectors[0]!, vectors[1]!);
    const toWeather = cosineSimilarity(vectors[0]!, vectors[2]!);
    evidence['rawSimilarity'] = {
      dimensions: vectors[0]!.length,
      paraphraseToTarget: Number(toTarget.toFixed(4)),
      paraphraseToWeather: Number(toWeather.toFixed(4)),
      threshold: 0.5,
    };
    expect(vectors[0]!.length).toBeGreaterThan(0);
    expect(toTarget).toBeGreaterThan(0.5);
    expect(toWeather).toBeLessThan(0.5);
    expect(toTarget).toBeGreaterThan(toWeather);
  });

  it('when keywords and meaning both point at a record, the hit says so', async () => {
    const result = await hybrid.retrieve(query('what format does a research report need'));
    evidence['hybridAgreeing'] = { signalsUsed: result.signalsUsed, hits: hits(result) };
    const top = result.hits[0];
    expect(top?.record.recordId).toBe(reportKnowledge.recordId);
    expect(top?.matchedBy).toEqual(['metadata', 'keyword', 'semantic']);
  });

  it('an unreachable endpoint degrades the retrieval visibly and the lexical stage still answers', async () => {
    // Same vectors, same provider label and model — only the endpoint is dead. A fresh
    // empty index would be the wrong control: it answers "nothing embedded" without a
    // network call, which is a truthful semantic result, not a failure.
    const broken: Telemetry = { started: [], completed: [], failed: [] };
    const brokenIndex = SqliteSemanticIndex.open({
      path: indexPath,
      embeddings: realEmbeddings(broken, { baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 5_000 }),
    });
    try {
      const degradedHybrid = new HybridRetriever(inner, brokenIndex, clock);
      const result = await degradedHybrid.retrieve(query('research report Sources section'));
      evidence['brokenEndpoint'] = {
        signalsUsed: result.signalsUsed,
        degraded: result.degraded ?? [],
        hits: hits(result),
        failureKinds: broken.failed.map((f) => f.errorKind),
      };
      expect(result.signalsUsed).not.toContain('semantic');
      expect(result.degraded?.map((d) => d.signal)).toEqual(['semantic']);
      expect(result.hits[0]?.record.recordId).toBe(reportKnowledge.recordId);
      expect(result.hits[0]?.matchedBy).toEqual(['metadata', 'keyword']);
      expect(broken.failed.length).toBeGreaterThan(0);
      expect(await brokenIndex.contains(reportKnowledge.recordId)).toBe(true);
      expect(JSON.stringify(result.degraded)).not.toContain('Bearer');
    } finally {
      brokenIndex.close();
    }
  });
});
