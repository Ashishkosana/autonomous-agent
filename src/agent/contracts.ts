import type { Action } from '../domain/action.js';
import type { Goal } from '../domain/goal.js';
import type { Observation } from '../domain/observation.js';
import type { Plan, PlanTask } from '../domain/plan.js';
import type { RunCorrelation } from '../domain/provenance.js';
import type { EvaluationResult } from '../evaluation/contracts.js';
import type {
  DecisionRecord,
  ExperienceRecord,
  KnowledgeRecord,
  LessonRecord,
} from '../memory/records.js';
import type { RetrievalResult } from '../memory/retrieval.js';
import type { WorkingMemorySnapshot } from '../memory/working.js';
import type { ToolDescriptor } from '../tools/contracts.js';

/**
 * Contracts for the components the autonomous runtime (Phase 2) will
 * orchestrate. Each is independently replaceable and testable. The runtime
 * loop itself is intentionally absent from Phase 1.
 */

export interface PlanningInput {
  readonly goal: Goal;
  readonly working: WorkingMemorySnapshot;
  /** Memory retrieved for this planning step; the planner must cite what it used. */
  readonly retrievals: readonly RetrievalResult[];
  readonly availableTools: readonly ToolDescriptor[];
}

export interface RevisionInput extends PlanningInput {
  readonly previousPlan: Plan;
  /** The evaluation(s) that triggered re-planning. */
  readonly triggeringEvaluations: readonly EvaluationResult[];
}

export interface Planner {
  createPlan(input: PlanningInput): Promise<Plan>;
  revisePlan(input: RevisionInput): Promise<Plan>;
}

export interface ActionSelectionInput {
  readonly goal: Goal;
  readonly plan: Plan;
  /** The task the runtime wants progress on. */
  readonly task: PlanTask;
  /** Earlier attempts at this task, oldest first. Empty on a first attempt. */
  readonly previousAttempts: readonly TaskAttempt[];
  readonly working: WorkingMemorySnapshot;
  readonly retrievals: readonly RetrievalResult[];
  readonly availableTools: readonly ToolDescriptor[];
}

/** One evaluated attempt at a task: the unit the runtime retries and learns from. */
export interface TaskAttempt {
  readonly action: Action;
  readonly observation: Observation;
  readonly evaluation: EvaluationResult;
  readonly decision?: DecisionRecord;
}

export type ActionSelection =
  | { readonly kind: 'act'; readonly action: Action; readonly decision?: DecisionRecord }
  | { readonly kind: 'finish'; readonly summary: string }
  | { readonly kind: 'give_up'; readonly reason: string };

export interface ActionSelector {
  selectNext(input: ActionSelectionInput): Promise<ActionSelection>;
}

export interface Executor {
  execute(action: Action): Promise<Observation>;
}

export interface LearningInput {
  readonly correlation: RunCorrelation;
  readonly task: PlanTask;
  readonly attempt: TaskAttempt;
  /** Earlier attempts at the same task, oldest first. Lets the learner compare approaches. */
  readonly previousAttempts: readonly TaskAttempt[];
}

export interface LearningOutput {
  readonly experience: ExperienceRecord;
  readonly lessons: readonly LessonRecord[];
}

export interface Learner {
  learn(input: LearningInput): Promise<LearningOutput>;
}

export interface IngestionInput {
  readonly correlation: RunCorrelation;
  readonly goal: Goal;
  readonly task: PlanTask;
  readonly action: Action;
  readonly observation: Observation;
}

export interface IngestionOutput {
  /** Knowledge records to persist, oldest first. Empty when the observation carried nothing to keep. */
  readonly knowledge: readonly KnowledgeRecord[];
  /** Why nothing was ingested, when that is a decision rather than an absence (for the dashboard). */
  readonly skipped?: string;
}

/**
 * Turns what an action brought back from the world into Knowledge memory —
 * the only one of the four categories the loop did not write before Phase 7.
 * Distinct from the Learner (which records what the agent *did* and how it
 * went) so that "what the world said" and "what worked" stay separate records
 * with separate confidence.
 */
export interface KnowledgeIngestor {
  ingest(input: IngestionInput): Promise<IngestionOutput>;
}
