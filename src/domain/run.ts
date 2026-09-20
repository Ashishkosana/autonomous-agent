import type { GoalId, IsoTimestamp, RunId } from './ids.js';

/**
 * Hard limits for one autonomous run. The runtime (Phase 2) must stop when any
 * limit is reached, regardless of what the model wants to do next.
 */
export interface RunLimits {
  readonly maxIterations: number;
  readonly maxToolCalls: number;
  readonly maxModelCalls: number;
  readonly maxTotalTokens: number;
  readonly maxDurationMs: number;
}

/**
 * Terminal statuses are deliberately distinct:
 * - `completed`     — the evaluator confirmed every planned task.
 * - `gave_up`       — the agent itself decided continuation was not useful.
 * - `failed`        — an unrecoverable runtime/model error stopped the run.
 * - `limit_reached` — a configured RunLimit stopped the run; says nothing about the goal.
 * - `stopped`       — a human stopped the run externally.
 */
export type RunStatus =
  'created' | 'running' | 'completed' | 'gave_up' | 'failed' | 'limit_reached' | 'stopped';

export type RunLimitName = keyof RunLimits;

/** Counters that the dashboard reports as "resource usage". */
export interface RunUsage {
  readonly iterations: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly memoryReads: number;
  readonly memoryWrites: number;
  readonly retries: number;
  readonly strategyChanges: number;
}

export interface RunState {
  readonly runId: RunId;
  readonly goalId: GoalId;
  readonly status: RunStatus;
  readonly limits: RunLimits;
  readonly usage: RunUsage;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  /** Populated when status is failed / limit_reached / stopped. */
  readonly terminationReason?: string;
}

export const ZERO_USAGE: RunUsage = Object.freeze({
  iterations: 0,
  toolCalls: 0,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  memoryReads: 0,
  memoryWrites: 0,
  retries: 0,
  strategyChanges: 0,
});
