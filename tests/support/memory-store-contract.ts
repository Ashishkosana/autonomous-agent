import { describe, expect, it } from 'vitest';
import {
  asActionId,
  asDecisionId,
  asEvaluationId,
  asGoalId,
  asLessonId,
  asMemoryRecordId,
  asObservationId,
  asPlanId,
  asRunId,
  asTaskId,
} from '../../src/domain/ids.js';
import { MemoryStoreError } from '../../src/memory/errors.js';
import {
  UNVALIDATED,
  type DecisionRecord,
  type ExperienceRecord,
  type KnowledgeRecord,
  type LessonRecord,
  type PersistentMemoryRecord,
} from '../../src/memory/records.js';
import type { MemoryStore } from '../../src/memory/store.js';

/**
 * Behaviour every MemoryStore must exhibit, independent of backend. Run over
 * the test store and over every real one so that the runtime cannot observe
 * a difference between them except durability.
 */
export interface MemoryStoreHarness {
  readonly store: MemoryStore;
  close(): Promise<void> | void;
}

const RUN_A = asRunId('run-a');
const RUN_B = asRunId('run-b');
const GOAL_A = asGoalId('goal-a');
const GOAL_B = asGoalId('goal-b');

export const knowledge: KnowledgeRecord = {
  recordId: asMemoryRecordId('kn-1'),
  kind: 'knowledge',
  runId: RUN_A,
  goalId: GOAL_A,
  createdAt: '2026-01-01T00:00:01.000Z',
  summary: 'Report format needs a Sources section',
  tags: ['report', 'format'],
  provenance: { actionIds: [asActionId('act-0')], observationIds: [asObservationId('obs-0')] },
  title: 'Research report format',
  content: 'A research report must end with a "## Sources" section. Unicode ✓ and "quotes".',
  sources: [{ url: 'https://example.test/style', retrievedAt: '2026-01-01T00:00:00.000Z' }],
  confidence: 0.9,
};

export const experience: ExperienceRecord = {
  recordId: asMemoryRecordId('exp-1'),
  kind: 'experience',
  runId: RUN_A,
  goalId: GOAL_A,
  taskId: asTaskId('task-1'),
  createdAt: '2026-01-01T00:00:02.000Z',
  summary: 'fs.write → failure',
  tags: ['fs.write', 'failure'],
  provenance: { planIds: [asPlanId('plan-1')] },
  actionId: asActionId('act-1'),
  toolName: 'fs.write',
  inputSummary: 'write the report without sources',
  observationId: asObservationId('obs-1'),
  evaluationId: asEvaluationId('eval-1'),
  outcome: 'failure',
  attempt: 1,
  changedApproach: false,
};

export const decision: DecisionRecord = {
  recordId: asMemoryRecordId('dec-1'),
  kind: 'decision',
  runId: RUN_A,
  goalId: GOAL_A,
  taskId: asTaskId('task-1'),
  createdAt: '2026-01-01T00:00:02.000Z',
  summary: 'Chose fs.write over shell.run',
  tags: ['fs.write'],
  provenance: {},
  decisionId: asDecisionId('dec-1'),
  context: 'Need to produce the report file',
  optionsConsidered: [
    { optionId: 'a', description: 'fs.write', assessment: 'direct' },
    { optionId: 'b', description: 'shell.run echo', assessment: 'indirect' },
  ],
  selectedOptionId: 'a',
  evidence: [{ description: 'knowledge record', memoryRecordId: knowledge.recordId }],
  reason: 'The file tool is the direct way to write a file',
  actionId: asActionId('act-1'),
  outcome: 'failure',
  lessonIds: [],
};

export const lesson: LessonRecord = {
  recordId: asMemoryRecordId('les-1'),
  kind: 'lesson',
  lessonId: asLessonId('lesson-1'),
  runId: RUN_B,
  goalId: GOAL_B,
  createdAt: '2026-01-01T00:00:03.000Z',
  summary: 'Include the Sources section on the first attempt',
  statement:
    'For report tasks, include a Sources section; the evaluator rejects reports without one.',
  applicability: ['fs.write', 'report'],
  tags: ['contrast', 'fs.write', 'report'],
  confidence: 0.6,
  validation: UNVALIDATED,
  provenance: { memoryRecordIds: [experience.recordId], evaluationIds: [asEvaluationId('eval-2')] },
};

export const ALL_RECORDS: readonly PersistentMemoryRecord[] = [
  knowledge,
  experience,
  decision,
  lesson,
];

export function describeMemoryStoreContract(
  name: string,
  open: () => Promise<MemoryStoreHarness> | MemoryStoreHarness,
): void {
  async function seeded(): Promise<MemoryStoreHarness> {
    const harness = await open();
    for (const record of ALL_RECORDS) await harness.store.put(record);
    return harness;
  }

  describe(`MemoryStore contract · ${name}`, () => {
    it('round-trips every persistent kind with full fidelity', async () => {
      const h = await seeded();
      try {
        for (const record of ALL_RECORDS) {
          expect(await h.store.get(record.recordId)).toEqual(record);
        }
        expect(await h.store.count()).toBe(ALL_RECORDS.length);
      } finally {
        await h.close();
      }
    });

    it('returns undefined for unknown ids and for the wrong kind', async () => {
      const h = await seeded();
      try {
        expect(await h.store.get(asMemoryRecordId('nope'))).toBeUndefined();
        expect(await h.store.getOfKind('lesson', lesson.recordId)).toEqual(lesson);
        expect(await h.store.getOfKind('knowledge', lesson.recordId)).toBeUndefined();
      } finally {
        await h.close();
      }
    });

    it('put is an upsert by recordId: content and tags replaced, position kept, count unchanged', async () => {
      const h = await seeded();
      try {
        const updated: LessonRecord = {
          ...lesson,
          summary: 'Updated summary',
          tags: ['contrast', 'updated'],
          validation: { ...UNVALIDATED, timesRetrieved: 3 },
        };
        await h.store.put(updated);
        expect(await h.store.count()).toBe(ALL_RECORDS.length);
        expect(await h.store.get(lesson.recordId)).toEqual(updated);
        expect(await h.store.query({ tags: ['report'] })).not.toContainEqual(updated);
        expect((await h.store.query({ tags: ['updated'] })).map((r) => r.recordId)).toEqual([
          lesson.recordId,
        ]);
      } finally {
        await h.close();
      }
    });

    it('refuses to let a different run overwrite an existing record id (cross-run id collision)', async () => {
      const h = await seeded();
      try {
        const collision = { ...lesson, runId: RUN_A, summary: 'from another run' };
        const error = await h.store
          .put(collision)
          .then(() => undefined)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MemoryStoreError);
        expect((error as MemoryStoreError).kind).toBe('conflict');
        expect((error as MemoryStoreError).recordId).toBe(lesson.recordId);
        expect(await h.store.get(lesson.recordId)).toEqual(lesson);
        expect(await h.store.count()).toBe(ALL_RECORDS.length);
        // The owning run may still revise it (e.g. lesson validation counters later on).
        await h.store.put({ ...lesson, summary: 'revised by its own run' });
        expect((await h.store.get(lesson.recordId))?.summary).toBe('revised by its own run');
      } finally {
        await h.close();
      }
    });

    it('filters by kinds, run, goal, tags (all-of) and createdAfter (strict)', async () => {
      const h = await seeded();
      try {
        const ids = async (q: Parameters<MemoryStore['query']>[0]) =>
          (await h.store.query(q)).map((r) => r.recordId);

        expect(await ids({ kinds: ['experience', 'decision'] })).toEqual(['exp-1', 'dec-1']);
        expect(await ids({ kinds: [] })).toEqual([]);
        expect(await ids({ runId: RUN_B })).toEqual(['les-1']);
        expect(await ids({ goalId: GOAL_A })).toEqual(['kn-1', 'exp-1', 'dec-1']);
        expect(await ids({ tags: ['fs.write'] })).toEqual(['exp-1', 'dec-1', 'les-1']);
        expect(await ids({ tags: ['fs.write', 'report'] })).toEqual(['les-1']);
        expect(await ids({ tags: ['fs.write', 'missing'] })).toEqual([]);
        expect(await ids({ tags: [] })).toHaveLength(ALL_RECORDS.length);
        expect(await ids({ createdAfter: '2026-01-01T00:00:02.000Z' })).toEqual(['les-1']);
        expect(await ids({ kinds: ['lesson'], runId: RUN_A })).toEqual([]);
      } finally {
        await h.close();
      }
    });

    it('orders oldest-first by createdAt with stable ties, honours limit, and count ignores limit', async () => {
      const h = await open();
      try {
        // Insert out of chronological order; two records share a timestamp.
        await h.store.put(lesson);
        await h.store.put(decision);
        await h.store.put(knowledge);
        await h.store.put(experience);
        const all = (await h.store.query({})).map((r) => r.recordId);
        expect(all).toEqual(['kn-1', 'dec-1', 'exp-1', 'les-1']);
        expect((await h.store.query({ limit: 2 })).map((r) => r.recordId)).toEqual([
          'kn-1',
          'dec-1',
        ]);
        expect((await h.store.query({ limit: 0 })).map((r) => r.recordId)).toEqual([]);
        expect(await h.store.count({ limit: 1 })).toBe(4);
      } finally {
        await h.close();
      }
    });

    it('refuses records that break the shared base shape', async () => {
      const h = await open();
      try {
        const bad = [
          { ...knowledge, recordId: '' },
          { ...knowledge, kind: 'memo' },
          { ...knowledge, runId: undefined },
          { ...knowledge, createdAt: 'yesterday' },
          { ...knowledge, tags: ['ok', 3] },
          { ...knowledge, provenance: null },
          'not a record',
        ];
        for (const record of bad) {
          const error = await h.store
            .put(record as unknown as PersistentMemoryRecord)
            .then(() => undefined)
            .catch((e: unknown) => e);
          expect(error, JSON.stringify(record)).toBeInstanceOf(MemoryStoreError);
          expect((error as MemoryStoreError).kind).toBe('invalid_record');
        }
        expect(await h.store.count()).toBe(0);
      } finally {
        await h.close();
      }
    });

    it('a stored record is not aliased to the caller: later mutation of the input does not change the store', async () => {
      const h = await open();
      try {
        const mutable = structuredClone(knowledge) as unknown as {
          tags: string[];
          summary: string;
        };
        await h.store.put(mutable as unknown as KnowledgeRecord);
        mutable.tags.push('mutated');
        mutable.summary = 'mutated';
        expect(await h.store.get(knowledge.recordId)).toEqual(knowledge);
      } finally {
        await h.close();
      }
    });
  });
}
