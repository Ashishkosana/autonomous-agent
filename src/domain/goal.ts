import type { VerifiableCriterion } from './criteria.js';
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
  /**
   * Human-stated success criteria. Strings matching the criterion grammar in
   * `domain/criteria.ts` are mechanically checkable; other prose is not
   * treated as passed or failed.
   */
  readonly successCriteria: readonly string[];
  /** Structured criteria. Combined with any grammar-matching `successCriteria` strings. */
  readonly verifiableCriteria?: readonly VerifiableCriterion[];
  readonly receivedAt: IsoTimestamp;
}
