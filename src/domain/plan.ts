import type { GoalId, IsoTimestamp, PlanId, RunId, StrategyId, TaskId } from './ids.js';
import type { Provenance } from './provenance.js';

export type PlanTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface PlanTask {
  readonly taskId: TaskId;
  readonly description: string;
  readonly status: PlanTaskStatus;
  readonly dependsOn: readonly TaskId[];
  /** What evidence would convince the evaluator that this task is done. */
  readonly expectedEvidence: readonly string[];
}

/**
 * A strategy is the *approach* behind a plan. It is versioned separately so
 * that a STRATEGY_CHANGED event can point at a concrete before/after pair
 * rather than being a label with nothing behind it.
 */
export interface Strategy {
  readonly strategyId: StrategyId;
  readonly summary: string;
  readonly version: number;
  /** The strategy this one replaced, if it is the result of an adaptation. */
  readonly supersedes?: StrategyId;
  /** Why the previous strategy was abandoned. Required when `supersedes` is set. */
  readonly changeReason?: string;
}

export interface Plan {
  readonly planId: PlanId;
  readonly runId: RunId;
  readonly goalId: GoalId;
  /** Monotonic per goal; a revised plan increments this. */
  readonly version: number;
  readonly strategy: Strategy;
  readonly tasks: readonly PlanTask[];
  /**
   * Which retrievals / memory records / evaluations shaped this plan.
   * This is what lets us later show "previous experience affected the new run".
   */
  readonly informedBy: Provenance;
  readonly createdAt: IsoTimestamp;
  /** Present on revisions: why the previous plan version was replaced. */
  readonly revisionReason?: string;
}
