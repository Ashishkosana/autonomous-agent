import type { RunLimits } from '../domain/run.js';

/**
 * Bounds for one CLI run. They stop a runaway loop; they do not judge the goal.
 * The runtime already enforces the same `RunLimits` shape. Composition applies
 * these when the caller does not pass its own limits.
 */
export const DEFAULT_CLI_LIMITS: RunLimits = {
  maxIterations: 12,
  maxToolCalls: 16,
  maxModelCalls: 40,
  maxTotalTokens: 500_000,
  maxDurationMs: 20 * 60_000,
};
