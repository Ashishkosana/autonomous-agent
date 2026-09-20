import type { Clock, IdGenerator } from '../../src/domain/ids.js';

/** Produces `prefix-1`, `prefix-2`, ... so test expectations can name ids. */
export class SequentialIdGenerator implements IdGenerator {
  private readonly counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

/** A clock that only moves when the test says so. */
export class FixedClock implements Clock {
  private epochMs: number;

  constructor(startIso = '2026-01-01T00:00:00.000Z') {
    this.epochMs = Date.parse(startIso);
  }

  now(): string {
    return new Date(this.epochMs).toISOString();
  }

  monotonicMs(): number {
    return this.epochMs;
  }

  advance(ms: number): void {
    this.epochMs += ms;
  }
}
