import type { Clock } from './ids.js';

/**
 * The production clock: wall time for timestamps, `performance.now()` for
 * durations so that latency and duration limits are immune to wall-clock
 * adjustments. Tests use `FixedClock` instead; nothing in `src/` instantiates
 * this — composition roots do.
 */
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }

  monotonicMs(): number {
    return performance.now();
  }
}
