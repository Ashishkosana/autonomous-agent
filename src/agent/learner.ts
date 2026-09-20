import { asLessonId, asMemoryRecordId, type Clock, type IdGenerator } from '../domain/ids.js';
import { mergeProvenance, type Provenance } from '../domain/provenance.js';
import type { EvaluationVerdict } from '../evaluation/contracts.js';
import {
  UNVALIDATED,
  type ExperienceOutcome,
  type ExperienceRecord,
  type LessonRecord,
} from '../memory/records.js';
import type { Learner, LearningInput, LearningOutput, TaskAttempt } from './contracts.js';

/**
 * Rule-based learner for the minimal loop.
 *
 * - Every evaluated attempt becomes an ExperienceRecord (what was tried, what
 *   the evaluator concluded, whether the approach differed from the last try).
 * - A LessonRecord is derived only when there is a real contrast to learn
 *   from: a task succeeded after at least one failed attempt. The lesson
 *   links every attempt, evaluation and decision that produced it.
 *
 * No model call is involved; a model-assisted learner can replace this behind
 * the same `Learner` contract once a provider is chosen.
 */
export class OutcomeLearner implements Learner {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async learn(input: LearningInput): Promise<LearningOutput> {
    const { attempt, previousAttempts, task, correlation } = input;
    const previous = previousAttempts.at(-1);
    const now = this.clock.now();

    const experience: ExperienceRecord = {
      recordId: asMemoryRecordId(this.ids.next('mem')),
      kind: 'experience',
      runId: correlation.runId,
      goalId: correlation.goalId,
      taskId: task.taskId,
      createdAt: now,
      summary: `${attempt.action.toolName} for "${task.description}" → ${attempt.evaluation.verdict}`,
      tags: [attempt.action.toolName, attempt.evaluation.verdict],
      provenance: attemptProvenance(attempt),
      actionId: attempt.action.actionId,
      toolName: attempt.action.toolName,
      inputSummary: attempt.action.intent,
      observationId: attempt.observation.observationId,
      evaluationId: attempt.evaluation.evaluationId,
      outcome: toOutcome(attempt.evaluation.verdict),
      attempt: attempt.action.attempt,
      changedApproach: previous ? approachDiffers(previous, attempt) : false,
      ...(attempt.action.retryOf ? { retryOf: attempt.action.retryOf } : {}),
    };

    const failedBefore = previousAttempts.filter((a) => a.evaluation.verdict !== 'success');
    const lessons: LessonRecord[] =
      attempt.evaluation.verdict === 'success' && failedBefore.length > 0
        ? [this.contrastLesson(input, failedBefore, experience)]
        : [];

    return { experience, lessons };
  }

  private contrastLesson(
    input: LearningInput,
    failed: readonly TaskAttempt[],
    experience: ExperienceRecord,
  ): LessonRecord {
    const { attempt, task, correlation } = input;
    const failedSummaries = failed.map(
      (f) =>
        `"${f.action.intent}" (${f.action.toolName}) → ${f.evaluation.verdict}: ${
          f.evaluation.gaps.join('; ') || f.evaluation.summary
        }`,
    );
    const statement = [
      `For tasks like "${task.description}":`,
      ...failedSummaries.map((s) => `failed approach ${s};`),
      `succeeded with "${attempt.action.intent}" (${attempt.action.toolName}).`,
    ].join(' ');

    return {
      recordId: asMemoryRecordId(this.ids.next('mem')),
      kind: 'lesson',
      lessonId: asLessonId(this.ids.next('lesson')),
      runId: correlation.runId,
      goalId: correlation.goalId,
      taskId: task.taskId,
      createdAt: this.clock.now(),
      summary: `Succeeded after ${failed.length} failed attempt(s): ${attempt.action.intent}`,
      statement,
      applicability: [attempt.action.toolName, ...failed.map((f) => f.action.toolName)].filter(
        (value, index, all) => all.indexOf(value) === index,
      ),
      tags: ['contrast', attempt.action.toolName],
      // One confirmation only; later runs raise this through LessonValidation.
      confidence: 0.6,
      validation: UNVALIDATED,
      provenance: mergeProvenance(
        { memoryRecordIds: [experience.recordId] },
        ...failed.map(attemptProvenance),
        attemptProvenance(attempt),
      ),
    };
  }
}

function attemptProvenance(attempt: TaskAttempt): Provenance {
  return mergeProvenance(
    {
      actionIds: [attempt.action.actionId],
      observationIds: [attempt.observation.observationId],
      evaluationIds: [attempt.evaluation.evaluationId],
      planIds: [attempt.action.planId],
    },
    attempt.action.decisionId ? { decisionIds: [attempt.action.decisionId] } : {},
    attempt.decision?.provenance ?? {},
  );
}

function approachDiffers(previous: TaskAttempt, current: TaskAttempt): boolean {
  return (
    previous.action.toolName !== current.action.toolName ||
    JSON.stringify(previous.action.input) !== JSON.stringify(current.action.input)
  );
}

function toOutcome(verdict: EvaluationVerdict): ExperienceOutcome {
  switch (verdict) {
    case 'success':
      return 'success';
    case 'partial':
      return 'partial';
    case 'failure':
    case 'inconclusive':
      return 'failure';
  }
}
