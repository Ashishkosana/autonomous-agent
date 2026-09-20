import type { Clock } from '../../domain/ids.js';
import { ZERO_USAGE, type RunLimitName, type RunLimits, type RunUsage } from '../../domain/run.js';

export interface LimitBreach {
  readonly limit: RunLimitName;
  readonly value: number;
  readonly max: number;
}

type Counter = Exclude<keyof RunUsage, 'inputTokens' | 'outputTokens'>;

/**
 * Tracks resource usage for one run and answers "has any configured limit
 * been reached?". The runtime consults it before every iteration so that the
 * loop always has an explicit termination condition independent of what the
 * model proposes.
 */
export class RunUsageTracker {
  private usage: RunUsage = ZERO_USAGE;
  private readonly startedMs: number;

  constructor(
    readonly limits: RunLimits,
    private readonly clock: Clock,
  ) {
    this.startedMs = clock.monotonicMs();
  }

  get snapshot(): RunUsage {
    return this.usage;
  }

  increment(counter: Counter, by = 1): void {
    this.usage = { ...this.usage, [counter]: this.usage[counter] + by };
  }

  addTokens(inputTokens: number, outputTokens: number): void {
    this.usage = {
      ...this.usage,
      inputTokens: this.usage.inputTokens + inputTokens,
      outputTokens: this.usage.outputTokens + outputTokens,
    };
  }

  elapsedMs(): number {
    return this.clock.monotonicMs() - this.startedMs;
  }

  /** The first limit that has been reached, or undefined if the run may continue. */
  breach(): LimitBreach | undefined {
    const { limits, usage } = this;
    const checks: readonly LimitBreach[] = [
      { limit: 'maxIterations', value: usage.iterations, max: limits.maxIterations },
      { limit: 'maxToolCalls', value: usage.toolCalls, max: limits.maxToolCalls },
      { limit: 'maxModelCalls', value: usage.modelCalls, max: limits.maxModelCalls },
      {
        limit: 'maxTotalTokens',
        value: usage.inputTokens + usage.outputTokens,
        max: limits.maxTotalTokens,
      },
      { limit: 'maxDurationMs', value: this.elapsedMs(), max: limits.maxDurationMs },
    ];
    return checks.find((check) => check.value >= check.max);
  }
}
