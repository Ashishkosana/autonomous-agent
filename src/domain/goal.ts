import type { GoalId, IsoTimestamp, RunId } from './ids.js';

/**
 * The single high-level instruction supplied by the human.
 * The agent derives all intermediate steps itself; the goal never
 * contains the plan.
 */
export interface Goal {
  readonly goalId: GoalId;
  readonly runId: RunId;
  readonly statement: string;
  /** Hard constraints the human stated explicitly (e.g. "use Python"). */
  readonly constraints: readonly string[];
  /** Human-stated success criteria, if any. The evaluator may add its own. */
  readonly successCriteria: readonly string[];
  readonly receivedAt: IsoTimestamp;
}
