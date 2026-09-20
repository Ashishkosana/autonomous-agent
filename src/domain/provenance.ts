import type {
  ActionId,
  DecisionId,
  EvaluationId,
  GoalId,
  LessonId,
  MemoryRecordId,
  ObservationId,
  PlanId,
  RetrievalId,
  RunId,
  TaskId,
} from './ids.js';

/**
 * Provenance describes *what an entity was derived from*.
 *
 * Every derived record (plan, decision, action, observation, evaluation,
 * lesson, memory record) carries a `Provenance` so that the chain
 *
 *   retrieved memory → plan/decision → action → observation → evaluation → lesson
 *
 * can be reconstructed by following identifiers. All fields are optional
 * because different entities are derived from different things; an entity
 * with an empty provenance is a root cause (e.g. the human goal).
 */
export interface Provenance {
  readonly retrievalIds?: readonly RetrievalId[];
  readonly memoryRecordIds?: readonly MemoryRecordId[];
  readonly planIds?: readonly PlanId[];
  readonly decisionIds?: readonly DecisionId[];
  readonly actionIds?: readonly ActionId[];
  readonly observationIds?: readonly ObservationId[];
  readonly evaluationIds?: readonly EvaluationId[];
  readonly lessonIds?: readonly LessonId[];
}

export const EMPTY_PROVENANCE: Provenance = Object.freeze({});

type ProvenanceKey = keyof Provenance;

const PROVENANCE_KEYS: readonly ProvenanceKey[] = [
  'retrievalIds',
  'memoryRecordIds',
  'planIds',
  'decisionIds',
  'actionIds',
  'observationIds',
  'evaluationIds',
  'lessonIds',
];

/** Union of several provenance objects, de-duplicating identifiers per field. */
export function mergeProvenance(...parts: readonly Provenance[]): Provenance {
  const merged: Record<ProvenanceKey, string[]> = {
    retrievalIds: [],
    memoryRecordIds: [],
    planIds: [],
    decisionIds: [],
    actionIds: [],
    observationIds: [],
    evaluationIds: [],
    lessonIds: [],
  };
  for (const part of parts) {
    for (const key of PROVENANCE_KEYS) {
      const values = part[key];
      if (!values) continue;
      for (const value of values) {
        if (!merged[key].includes(value)) merged[key].push(value);
      }
    }
  }
  const result: Record<string, readonly string[]> = {};
  for (const key of PROVENANCE_KEYS) {
    if (merged[key].length > 0) result[key] = merged[key];
  }
  return result as Provenance;
}

export function isEmptyProvenance(provenance: Provenance): boolean {
  return PROVENANCE_KEYS.every((key) => (provenance[key]?.length ?? 0) === 0);
}

/**
 * Identifies *where in a run* something happened. Attached to actions,
 * observations, events, and memory writes so that any record can be placed
 * back into its run/goal/task context.
 */
export interface RunCorrelation {
  readonly runId: RunId;
  readonly goalId: GoalId;
  readonly taskId?: TaskId;
}
