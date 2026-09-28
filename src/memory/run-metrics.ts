/**
 * One run's measured cost and retrieval, stored so a later run can be
 * compared with it. These are counters from the event log and the run
 * state. They are not a score, and they do not say that memory caused
 * the difference.
 */
export interface RunMetricsRecord {
  readonly runId: string;
  readonly goalStatement: string;
  readonly status: string;
  readonly succeeded: boolean;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Wall-clock time from run start to finish, in milliseconds. */
  readonly durationMs: number;
  /**
   * Fraction of retrievals that returned at least one record.
   * `null` when retrieval did not run (memory off, or no retrieval event).
   * A single run retrieves once, on the goal, so the value is 0 or 1.
   */
  readonly retrievalHitRate: number | null;
  readonly retrievalHitCount: number;
  readonly signalsUsed: readonly string[];
  readonly citedRecordIds: readonly string[];
  readonly retrievedRecordIds: readonly string[];
}
