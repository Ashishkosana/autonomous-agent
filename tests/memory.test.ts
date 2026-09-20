import { describe, expect, it } from 'vitest';
import {
  asActionId,
  asLessonId,
  asMemoryRecordId,
  asObservationId,
  asRunId,
  asGoalId,
} from '../src/domain/ids.js';
import type { Plan } from '../src/domain/plan.js';
import type {
  PersistentMemoryRecord,
  ExperienceRecord,
  LessonRecord,
} from '../src/memory/records.js';
import { PERSISTENT_MEMORY_KINDS, UNVALIDATED } from '../src/memory/records.js';
import { FixedClock, SequentialIdGenerator } from './support/deterministic.js';
import { makePlan } from './support/fixtures.js';
import { InMemoryMemoryStore } from './support/in-memory-memory-store.js';
import { KeywordOnlyRetriever } from './support/keyword-only-retriever.js';

const PREVIOUS_RUN = asRunId('run-0');
const PREVIOUS_GOAL = asGoalId('goal-0');

function experience(
  id: string,
  summary: string,
  outcome: ExperienceRecord['outcome'],
  tags: string[],
): ExperienceRecord {
  return {
    recordId: asMemoryRecordId(id),
    kind: 'experience',
    runId: PREVIOUS_RUN,
    goalId: PREVIOUS_GOAL,
    createdAt: '2025-12-31T00:00:00.000Z',
    summary,
    tags,
    provenance: {},
    actionId: asActionId(`${id}-action`),
    toolName: 'terminal',
    inputSummary: summary,
    observationId: asObservationId(`${id}-obs`),
    outcome,
    attempt: 1,
    changedApproach: false,
  };
}

const failedApproachA = experience(
  'exp-a',
  'Installed the pdf parsing library with pip at system level; install failed with permission error',
  'failure',
  ['pdf', 'python', 'install'],
);

const succeededApproachB = experience(
  'exp-b',
  'Installed the pdf parsing library inside a python virtualenv; install succeeded and script ran',
  'success',
  ['pdf', 'python', 'install'],
);

const lesson: LessonRecord = {
  recordId: asMemoryRecordId('les-1'),
  kind: 'lesson',
  lessonId: asLessonId('lesson-1'),
  runId: PREVIOUS_RUN,
  goalId: PREVIOUS_GOAL,
  createdAt: '2025-12-31T00:00:01.000Z',
  summary: 'Use a virtualenv for python installs in the sandbox',
  statement:
    'When installing python packages in the sandbox, create a virtualenv first; system-level pip installs fail.',
  applicability: ['python', 'install', 'sandbox'],
  tags: ['python', 'install'],
  confidence: 0.8,
  provenance: { memoryRecordIds: [failedApproachA.recordId, succeededApproachB.recordId] },
  validation: UNVALIDATED,
};

const unrelatedKnowledge: PersistentMemoryRecord = {
  recordId: asMemoryRecordId('kn-1'),
  kind: 'knowledge',
  runId: PREVIOUS_RUN,
  createdAt: '2025-12-31T00:00:00.000Z',
  summary: 'Notes on CSS grid layout',
  tags: ['css'],
  provenance: {},
  title: 'CSS grid',
  content: 'grid-template-columns defines column tracks',
  sources: [{ url: 'https://example.test/css-grid', retrievedAt: '2025-12-31T00:00:00.000Z' }],
  confidence: 0.9,
};

async function seededStore(): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  for (const record of [failedApproachA, succeededApproachB, lesson, unrelatedKnowledge]) {
    await store.put(record);
  }
  return store;
}

describe('memory records and store', () => {
  it('keeps the persistent memory kinds distinguishable', async () => {
    const store = await seededStore();
    expect(PERSISTENT_MEMORY_KINDS).toEqual(['knowledge', 'experience', 'decision', 'lesson']);
    expect(await store.count({ kinds: ['experience'] })).toBe(2);
    expect(await store.count({ kinds: ['lesson'] })).toBe(1);
    expect(await store.count({ kinds: ['knowledge'] })).toBe(1);
    expect(await store.count({ kinds: ['decision'] })).toBe(0);
  });

  it('filters by metadata (kind, tags, run)', async () => {
    const store = await seededStore();
    const pythonInstalls = await store.query({
      kinds: ['experience'],
      tags: ['python', 'install'],
    });
    expect(pythonInstalls.map((r) => r.recordId).sort()).toEqual(['exp-a', 'exp-b']);
    expect(await store.query({ runId: asRunId('run-never') })).toEqual([]);
  });

  it('getOfKind refuses to return a record under the wrong kind', async () => {
    const store = await seededStore();
    expect(await store.getOfKind('lesson', lesson.recordId)).toBeDefined();
    expect(await store.getOfKind('knowledge', lesson.recordId)).toBeUndefined();
  });
});

describe('behavioral: previous experience is retrievable for a related problem', () => {
  it('retrieves the failed and successful approaches plus the lesson, not unrelated knowledge', async () => {
    const store = await seededStore();
    const retriever = new KeywordOnlyRetriever(
      store,
      new SequentialIdGenerator(),
      new FixedClock(),
    );

    const result = await retriever.retrieve({
      text: 'install a python library to parse pdf files in the sandbox',
      kinds: ['experience', 'decision', 'lesson'],
      limit: 5,
      correlation: { runId: asRunId('run-1'), goalId: asGoalId('goal-1') },
    });

    const ids = result.hits.map((h) => h.record.recordId);
    expect(ids).toContain(failedApproachA.recordId);
    expect(ids).toContain(succeededApproachB.recordId);
    expect(ids).toContain(lesson.recordId);
    expect(ids).not.toContain(unrelatedKnowledge.recordId);
    expect(result.retrievalId).toBe('ret-1');
    expect(result.signalsUsed).toEqual(['metadata', 'keyword']);
    expect(result.signalsUsed).not.toContain('semantic');
    for (const hit of result.hits) expect(hit.score).toBeGreaterThan(0);
  });

  it('a plan can cite the retrieval and records that shaped it', async () => {
    const store = await seededStore();
    const retriever = new KeywordOnlyRetriever(
      store,
      new SequentialIdGenerator(),
      new FixedClock(),
    );
    const retrieval = await retriever.retrieve({
      text: 'install python pdf library',
      kinds: ['experience', 'lesson'],
      limit: 3,
      correlation: { runId: asRunId('run-1'), goalId: asGoalId('goal-1') },
    });

    const usedLessons = retrieval.hits
      .map((h) => h.record)
      .filter((r): r is LessonRecord => r.kind === 'lesson');
    expect(usedLessons).toHaveLength(1);

    const plan: Plan = makePlan({
      strategy: {
        strategyId: makePlan().strategy.strategyId,
        summary: `Create a virtualenv before installing (per lesson ${usedLessons[0]?.lessonId})`,
        version: 1,
      },
      informedBy: {
        retrievalIds: [retrieval.retrievalId],
        memoryRecordIds: retrieval.hits.map((h) => h.record.recordId),
        lessonIds: usedLessons.map((l) => l.lessonId),
      },
    });

    expect(plan.informedBy.retrievalIds).toEqual([retrieval.retrievalId]);
    expect(plan.informedBy.lessonIds).toEqual([lesson.lessonId]);
    expect(plan.informedBy.memoryRecordIds).toContain(succeededApproachB.recordId);
  });
});
