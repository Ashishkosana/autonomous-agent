/**
 * Branded identifier types.
 *
 * Every entity that participates in the provenance chain
 * (retrieval → plan/decision → action → observation → evaluation → lesson)
 * has its own identifier type so that correlation fields cannot be
 * accidentally mixed up at compile time. At runtime they are plain strings.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RunId = Brand<string, 'RunId'>;
export type GoalId = Brand<string, 'GoalId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type StrategyId = Brand<string, 'StrategyId'>;
export type DecisionId = Brand<string, 'DecisionId'>;
export type ActionId = Brand<string, 'ActionId'>;
export type ObservationId = Brand<string, 'ObservationId'>;
export type EvaluationId = Brand<string, 'EvaluationId'>;
export type LessonId = Brand<string, 'LessonId'>;
export type MemoryRecordId = Brand<string, 'MemoryRecordId'>;
export type RetrievalId = Brand<string, 'RetrievalId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type EventId = Brand<string, 'EventId'>;
export type ModelCallId = Brand<string, 'ModelCallId'>;

export const asRunId = (value: string): RunId => value as RunId;
export const asGoalId = (value: string): GoalId => value as GoalId;
export const asPlanId = (value: string): PlanId => value as PlanId;
export const asTaskId = (value: string): TaskId => value as TaskId;
export const asStrategyId = (value: string): StrategyId => value as StrategyId;
export const asDecisionId = (value: string): DecisionId => value as DecisionId;
export const asActionId = (value: string): ActionId => value as ActionId;
export const asObservationId = (value: string): ObservationId => value as ObservationId;
export const asEvaluationId = (value: string): EvaluationId => value as EvaluationId;
export const asLessonId = (value: string): LessonId => value as LessonId;
export const asMemoryRecordId = (value: string): MemoryRecordId => value as MemoryRecordId;
export const asRetrievalId = (value: string): RetrievalId => value as RetrievalId;
export const asArtifactId = (value: string): ArtifactId => value as ArtifactId;
export const asEventId = (value: string): EventId => value as EventId;
export const asModelCallId = (value: string): ModelCallId => value as ModelCallId;

/** ISO-8601 timestamp string (UTC). */
export type IsoTimestamp = string;

/**
 * Sources of identifiers and time are injected so that tests can be
 * deterministic and so that no module reaches for global state.
 */
export interface IdGenerator {
  next(prefix: string): string;
}

export interface Clock {
  now(): IsoTimestamp;
  /** Monotonic milliseconds, used for durations. */
  monotonicMs(): number;
}
