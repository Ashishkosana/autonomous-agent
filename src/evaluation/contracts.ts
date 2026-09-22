import type { Action } from '../domain/action.js';
import type { Goal } from '../domain/goal.js';
import type { EvaluationId, IsoTimestamp } from '../domain/ids.js';
import type { Observation } from '../domain/observation.js';
import type { OutcomeVerdict } from '../domain/outcome.js';
import type { PlanTask } from '../domain/plan.js';
import type { Provenance, RunCorrelation } from '../domain/provenance.js';
import type { ExecutionEnvironment } from '../sandbox/execution-environment.js';

/**
 * Evaluation answers "did the task actually progress?" — independently of
 * whether a tool call returned. A tool may return `ok` and the task may still
 * have failed (file empty, tests red, research thin).
 *
 * `EvaluationVerdict` is the canonical outcome vocabulary (`OutcomeVerdict`).
 * `partial` and `inconclusive` are not aliases of `failure`.
 * `DeterministicEvaluator` is the production implementation. A model judge
 * can implement this same interface later; it must not replace a check that
 * has mechanical ground truth.
 */
export type EvaluationVerdict = OutcomeVerdict;

/** How a check obtained its evidence. Lets the dashboard weight claims honestly. */
export type EvidenceMethod =
  'tool_result' | 'artifact_inspection' | 'command_check' | 'rule' | 'model_judgement';

export interface EvaluationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly method: EvidenceMethod;
  /**
   * False for diagnostic checks (the raw tool status). They are recorded and
   * do not decide the verdict. Absent means the check is decisive.
   */
  readonly decisive?: boolean;
  /** Human-readable evidence for the dashboard, e.g. "file /workspace/report.md has 1,204 bytes". */
  readonly evidence: string;
  readonly details?: unknown;
}

export interface EvaluationScope {
  readonly goal: Goal;
  readonly task?: PlanTask;
  readonly action?: Action;
  readonly observations: readonly Observation[];
  readonly correlation: RunCorrelation;
  /** Present when the evaluator may inspect the workspace for evidence. */
  readonly environment?: ExecutionEnvironment;
}

export interface EvaluationResult {
  readonly evaluationId: EvaluationId;
  readonly correlation: RunCorrelation;
  readonly verdict: EvaluationVerdict;
  /** Which evaluator produced this result. Absent on results written before the field existed. */
  readonly evaluatorName?: string;
  readonly checks: readonly EvaluationCheck[];
  /** What is still missing for the task/goal to be considered done. */
  readonly gaps: readonly string[];
  readonly summary: string;
  /**
   * The tool-level status of the action that was evaluated, recorded
   * separately so that "tool ok, task failed" is visible in the data.
   */
  readonly toolStatus: 'ok' | 'error' | 'none';
  readonly derivedFrom: Provenance;
  readonly evaluatedAt: IsoTimestamp;
}

export interface Evaluator {
  readonly name: string;
  evaluate(scope: EvaluationScope): Promise<EvaluationResult>;
}
