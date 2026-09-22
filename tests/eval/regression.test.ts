import { describe, expect, it } from 'vitest';
import { trajectoryFromEvents } from '../../src/agent/runtime/trajectory.js';
import {
  comparisonMismatches,
  type ComparableRunSpec,
} from '../../src/agent/runtime/comparison.js';
import { exposureFromEvents } from '../../src/memory/exposure.js';
import { HybridRetriever, rankHits } from '../../src/memory/hybrid-retriever.js';
import type { RetrievalHit } from '../../src/memory/retrieval.js';
import { LexicalRetriever } from '../../src/memory/lexical-retriever.js';
import type { ExperienceRecord, PersistentMemoryRecord } from '../../src/memory/records.js';
import { SqliteSemanticIndex } from '../../src/memory/sqlite/sqlite-semantic-index.js';
import { InMemoryMemoryStore } from '../support/in-memory-memory-store.js';
import { IndexedMemoryStore } from '../../src/memory/indexed-memory-store.js';
import { asGoalId, asMemoryRecordId, asRetrievalId, asRunId } from '../../src/domain/ids.js';
import { DeterministicEvaluator } from '../../src/evaluation/deterministic-evaluator.js';
import { FakeEmbeddingProvider } from '../support/fake-embedding-provider.js';
import { FixedClock } from '../support/deterministic.js';
import {
  APPROACH_A_CONTENT,
  APPROACH_B_CONTENT,
  GOAL_STATEMENT,
  REPORT_PATH,
  REQUIRED_MARKER,
  buildScenario,
  planTurn,
  reviseTurnEchoingTask,
  SEED_KNOWLEDGE_ID,
  seedKnowledge,
  writeReport,
} from '../support/runtime-scenario.js';
import { experience, knowledge } from '../support/memory-store-contract.js';

const baseSpec = (memory: 'on' | 'off'): ComparableRunSpec => ({
  goalStatement: GOAL_STATEMENT,
  constraints: [],
  successCriteria: [`file_contains:${REPORT_PATH}|${REQUIRED_MARKER}`],
  verifiableCriteria: [],
  limits: {
    maxIterations: 4,
    maxToolCalls: 4,
    maxModelCalls: 12,
    maxTotalTokens: 1000,
    maxDurationMs: 60_000,
  },
  model: { provider: 'scripted', model: 'scripted-v0' },
  toolNames: ['fs.write'],
  evaluatorName: 'deterministic',
  retrieval: {
    limit: 5,
    semanticThreshold: 0.5,
    keywordWeight: 1,
    semanticWeight: 1,
    kindDiversity: true,
  },
  memory,
  memorySnapshotLabel: 'snapshot-a',
});

describe('run comparison hook', () => {
  it('accepts a pair that differs only by the memory arm', () => {
    expect(comparisonMismatches(baseSpec('off'), baseSpec('on'))).toEqual([]);
  });

  it('rejects a pair whose model or limits differ', () => {
    const other = { ...baseSpec('on'), model: { provider: 'scripted', model: 'other' } };
    expect(comparisonMismatches(baseSpec('off'), other).map((item) => item.field)).toEqual([
      'model',
    ]);
  });
});

describe('agent regression suite', () => {
  it('creates an artifact that meets a mechanical criterion', async () => {
    const scenario = await buildScenario({
      turns: [
        planTurn(),
        { proposal: writeReport(APPROACH_B_CONTENT, 'write the report with sources') },
      ],
      seed: [],
      successCriteria: [`file_contains:${REPORT_PATH}|${REQUIRED_MARKER}`],
      evaluator: (ids, clock) => new DeterministicEvaluator(ids, clock),
    });
    const outcome = await scenario.run();
    expect(outcome.state.status).toBe('completed');
    expect(await scenario.environment.readFile(REPORT_PATH)).toContain(REQUIRED_MARKER);
    const trajectory = trajectoryFromEvents(scenario.events.events);
    expect(trajectory.steps[0]?.toolName).toBe('fs.write');
    expect(trajectory.steps[0]?.verdict).toBe('success');
    expect(trajectory.steps[0]?.inputSummary).toContain(REQUIRED_MARKER);
    expect(trajectory.finalStatus).toBe('completed');
  });

  it('recovers after a tool-ok evaluation failure', async () => {
    const scenario = await buildScenario({
      turns: [
        planTurn(),
        { proposal: writeReport(APPROACH_A_CONTENT, 'write a draft') },
        reviseTurnEchoingTask({ strategyChanged: true }),
        { proposal: writeReport(APPROACH_B_CONTENT, 'add the sources section') },
      ],
      seed: [],
      successCriteria: [`file_contains:${REPORT_PATH}|${REQUIRED_MARKER}`],
      evaluator: (ids, clock) => new DeterministicEvaluator(ids, clock),
    });
    const outcome = await scenario.run();
    expect(outcome.state.status).toBe('completed');
    const trajectory = trajectoryFromEvents(scenario.events.events);
    expect(trajectory.steps.map((step) => step.verdict)).toEqual(['failure', 'success']);
    expect(trajectory.retries).toBe(1);
  });

  it('retrieves relevant memory and rejects an unrelated record', async () => {
    const scenario = await buildScenario({
      turns: [
        planTurn([SEED_KNOWLEDGE_ID]),
        { proposal: writeReport(APPROACH_B_CONTENT, 'write') },
      ],
      seed: [
        seedKnowledge,
        {
          ...knowledge,
          recordId: asMemoryRecordId('kn-weather'),
          summary: 'Weather forecast says rain',
          tags: ['weather'],
          title: 'Forecast',
          content: 'Rain tomorrow.',
        },
      ],
      successCriteria: [`file_contains:${REPORT_PATH}|${REQUIRED_MARKER}`],
      evaluator: (ids, clock) => new DeterministicEvaluator(ids, clock),
    });
    await scenario.run();
    const prompt = scenario.provider.requests
      .map((request) => request.messages.map((message) => message.content).join('\n'))
      .join('\n');
    expect(prompt).toContain(SEED_KNOWLEDGE_ID);
    expect(prompt).not.toContain('Weather forecast');
    const exposure = exposureFromEvents(scenario.events.events);
    expect(exposure.get(SEED_KNOWLEDGE_ID)?.retrieved).toBe(1);
    expect(exposure.get(SEED_KNOWLEDGE_ID)?.presented).toBe(1);
    expect(exposure.get(SEED_KNOWLEDGE_ID)?.cited).toBe(1);
  });

  it('memory off suppresses retrieval even when the store has a match', async () => {
    const scenario = await buildScenario({
      turns: [planTurn(), { proposal: writeReport(APPROACH_B_CONTENT, 'write') }],
      memory: 'off',
      successCriteria: [`file_contains:${REPORT_PATH}|${REQUIRED_MARKER}`],
      evaluator: (ids, clock) => new DeterministicEvaluator(ids, clock),
    });
    await scenario.run();
    const retrieved = scenario.events.ofType('MEMORY_RETRIEVED')[0];
    expect(retrieved?.payload.suppressed).toBe('memory_off');
    expect(retrieved?.payload.hitCount).toBe(0);
    const prompt = scenario.provider.requests[0]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(prompt).toContain('RELEVANT MEMORY: none retrieved');
  });

  it('flags an fs.read success from a previous sandbox when the file is absent', async () => {
    const stale: ExperienceRecord = {
      ...experience,
      recordId: asMemoryRecordId('exp-stale-read'),
      summary: 'fs.read for the research report succeeded',
      tags: ['fs.read', 'report', 'research'],
      toolName: 'fs.read',
      inputSummary: 'read the research report',
      outcome: 'success',
      preconditions: [{ kind: 'file_exists', path: REPORT_PATH }],
    };
    const scenario = await buildScenario({
      turns: [planTurn(), { proposal: writeReport(APPROACH_B_CONTENT, 'write') }],
      seed: [stale],
      goalStatement: 'Produce a research report at /workspace/report.md',
      successCriteria: [`file_contains:${REPORT_PATH}|${REQUIRED_MARKER}`],
      evaluator: (ids, clock) => new DeterministicEvaluator(ids, clock),
    });
    await scenario.run();
    const prompt = scenario.provider.requests
      .map((r) => r.messages.map((m) => m.content).join('\n'))
      .join('\n');
    expect(prompt).toContain('PRECONDITION VIOLATED');
    expect(prompt).toContain(`${REPORT_PATH} does not exist`);
    const presented = scenario.events.ofType('MEMORY_PRESENTED')[0];
    expect(presented?.payload.violatedRecordIds).toContain(stale.recordId);
  });
});

describe('retrieval regression', () => {
  const clock = new FixedClock();
  const correlation = { runId: asRunId('run-q'), goalId: asGoalId('goal-q') };

  it('lexical retrieval finds the overlapping record and not the unrelated one', async () => {
    const store = new InMemoryMemoryStore();
    await store.put(knowledge);
    await store.put({
      ...knowledge,
      recordId: asMemoryRecordId('kn-weather'),
      summary: 'Weather forecast says rain',
      tags: ['weather'],
      title: 'Forecast',
      content: 'Rain tomorrow.',
    });
    const result = await new LexicalRetriever(store, clock).retrieve({
      retrievalId: asRetrievalId('ret-1'),
      text: 'research report sources section',
      kinds: ['knowledge'],
      limit: 5,
      correlation,
    });
    expect(result.hits.map((hit) => hit.record.recordId)).toEqual([knowledge.recordId]);
    expect(result.hits[0]?.breakdown?.semantic).toBeNull();
    expect(result.hits[0]?.breakdown?.lexical).toBeGreaterThan(0);
  });

  it('semantic-only retrieval finds a paraphrase and records the threshold decision', async () => {
    const embeddings = new FakeEmbeddingProvider();
    const index = SqliteSemanticIndex.open({ path: ':memory:', embeddings });
    const store = new IndexedMemoryStore(new InMemoryMemoryStore(), index);
    await store.put(knowledge);
    const hybrid = new HybridRetriever(store, index, clock);
    const result = await hybrid.retrieve({
      retrievalId: asRetrievalId('ret-1'),
      text: 'a memo with a bibliography',
      kinds: ['knowledge', 'experience', 'decision', 'lesson'],
      limit: 5,
      correlation,
    });
    expect(result.hits[0]?.record.recordId).toBe(knowledge.recordId);
    expect(result.hits[0]?.matchedBy).toEqual(['metadata', 'semantic']);
    expect(result.hits[0]?.breakdown?.lexical).toBe(0);
    expect(result.hits[0]?.breakdown?.semanticAdmitted).toBe(true);
    expect(result.hits[0]?.breakdown?.semanticThreshold).toBe(0.5);
    expect(result.hits[0]?.finalRank).toBe(1);
  });

  it('kind diversity keeps a lower-scored knowledge hit and says so', () => {
    const hit = (
      id: string,
      kind: PersistentMemoryRecord['kind'],
      score: number,
    ): RetrievalHit => ({
      record: { ...knowledge, recordId: asMemoryRecordId(id), kind } as PersistentMemoryRecord,
      score,
      matchedBy: ['metadata', 'keyword'],
    });
    const ranked = [
      hit('a', 'lesson', 1),
      hit('b', 'experience', 0.9),
      hit('c', 'experience', 0.85),
      hit('d', 'decision', 0.8),
      hit('e', 'decision', 0.75),
      hit('f', 'knowledge', 0.55),
    ];
    const selected = rankHits(ranked, 5, true);
    expect(selected.hits.map((item) => item.record.recordId)).toEqual(['a', 'b', 'c', 'd', 'f']);
    const knowledgeHit = selected.hits.find((item) => item.record.recordId === 'f');
    expect(knowledgeHit?.keptByDiversity).toBe(true);
    expect(knowledgeHit?.rankBeforeSelection).toBe(6);
    expect(selected.dropped.map((drop) => drop.recordId)).toEqual(['e']);
    expect(selected.dropped[0]?.reason).toBe('displaced_by_diversity');
    const plain = rankHits(ranked, 5, false);
    expect(plain.hits.map((item) => item.record.recordId)).not.toContain('f');
  });
});
