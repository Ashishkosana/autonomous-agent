import type {
  ActionId,
  ArtifactId,
  DecisionId,
  EvaluationId,
  EventId,
  GoalId,
  IsoTimestamp,
  LessonId,
  MemoryRecordId,
  ModelCallId,
  ObservationId,
  PlanId,
  RetrievalId,
  RunId,
  StrategyId,
  TaskId,
} from '../domain/ids.js';
import type { EvaluationVerdict } from '../evaluation/contracts.js';
import type { PersistentMemoryKind } from '../memory/records.js';
import type { RetrievalSignal } from '../memory/retrieval.js';
import type { FinishReason, ModelCallPurpose } from '../models/contracts.js';
import type { ModelErrorKind } from '../models/errors.js';
import type { ToolErrorCode } from '../tools/contracts.js';

/** Bump when the envelope or a payload changes shape incompatibly. */
export const EVENT_SCHEMA_VERSION = 1 as const;

export const AGENT_EVENT_TYPES = [
  'GOAL_RECEIVED',
  'PLAN_CREATED',
  'PLAN_UPDATED',
  'MEMORY_SEARCH_STARTED',
  'MEMORY_RETRIEVED',
  'MEMORY_WRITTEN',
  'KNOWLEDGE_INGESTED',
  'DECISION_CREATED',
  'MODEL_CALL_STARTED',
  'MODEL_CALL_COMPLETED',
  'MODEL_CALL_FAILED',
  'TOOL_SELECTED',
  'TOOL_STARTED',
  'TOOL_COMPLETED',
  'TOOL_FAILED',
  'COMMAND_STARTED',
  'COMMAND_OUTPUT',
  'COMMAND_FINISHED',
  'FILE_CREATED',
  'FILE_CHANGED',
  'FILE_DELETED',
  'BROWSER_NAVIGATION',
  'ARTIFACT_STORED',
  'FAILURE_DETECTED',
  'RETRY_STARTED',
  'STRATEGY_CHANGED',
  'LESSON_CREATED',
  'EVALUATION_COMPLETED',
  'GOAL_COMPLETED',
  'GOAL_FAILED',
  'RUN_LIMIT_REACHED',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/**
 * Identifiers that place an event inside the provenance chain. Every field is
 * optional; emitters fill in whatever is known at that point in the loop.
 */
export interface EventCorrelation {
  readonly taskId?: TaskId;
  readonly planId?: PlanId;
  readonly strategyId?: StrategyId;
  readonly decisionId?: DecisionId;
  readonly actionId?: ActionId;
  readonly observationId?: ObservationId;
  readonly evaluationId?: EvaluationId;
  readonly retrievalId?: RetrievalId;
  readonly lessonId?: LessonId;
  readonly modelCallId?: ModelCallId;
  readonly memoryRecordIds?: readonly MemoryRecordId[];
}

/**
 * Payloads are the *observable* facts about each step. They are designed to
 * be sufficient for the dashboard and the Living Flame without ever carrying
 * raw model chain-of-thought.
 */
export interface AgentEventPayloads {
  GOAL_RECEIVED: { readonly statement: string };
  PLAN_CREATED: {
    readonly planId: PlanId;
    readonly version: number;
    readonly strategyId: StrategyId;
    readonly strategySummary: string;
    readonly taskCount: number;
    /** Retrievals/records that informed the plan — evidence that memory was used. */
    readonly informedByRetrievalIds: readonly RetrievalId[];
    readonly informedByMemoryRecordIds: readonly MemoryRecordId[];
  };
  PLAN_UPDATED: {
    readonly planId: PlanId;
    readonly previousPlanId: PlanId;
    readonly version: number;
    readonly reason: string;
    readonly taskCount: number;
  };
  MEMORY_SEARCH_STARTED: {
    readonly retrievalId: RetrievalId;
    readonly queryText: string;
    readonly kinds: readonly PersistentMemoryKind[];
  };
  MEMORY_RETRIEVED: {
    readonly retrievalId: RetrievalId;
    readonly hitCount: number;
    readonly recordIds: readonly MemoryRecordId[];
    readonly kinds: readonly PersistentMemoryKind[];
    readonly durationMs: number;
    /** Which retrieval stages actually ran — `semantic` appears only when the index answered. */
    readonly signalsUsed: readonly RetrievalSignal[];
    /** Stages that were configured but could not run this time (e.g. embedding endpoint down), with why. */
    readonly degraded: readonly { readonly signal: RetrievalSignal; readonly reason: string }[];
  };
  /**
   * Content an action brought back from the world became a knowledge record.
   * Emitted before the record's MEMORY_WRITTEN; says where the content came
   * from and how much of it was kept — never the content itself.
   */
  KNOWLEDGE_INGESTED: {
    readonly recordId: MemoryRecordId;
    readonly toolName: string;
    /** URL or path the content came from. */
    readonly source: string;
    readonly title: string;
    readonly keptChars: number;
    readonly truncated: boolean;
    readonly confidence: number;
  };
  MEMORY_WRITTEN: {
    readonly recordId: MemoryRecordId;
    readonly kind: PersistentMemoryKind;
    readonly summary: string;
  };
  DECISION_CREATED: {
    readonly decisionId: DecisionId;
    readonly summary: string;
    readonly optionCount: number;
    /** Only present when the model actually reported a confidence. */
    readonly confidence?: number;
  };
  /**
   * Model-call telemetry. Safe metadata only: provider, model, purpose,
   * timing, token usage, outcome. Never prompts, completions, or credentials.
   */
  MODEL_CALL_STARTED: {
    readonly modelCallId: ModelCallId;
    readonly purpose: ModelCallPurpose;
    readonly provider: string;
    readonly model: string;
    /** 1 for the first attempt at a logical call; higher after a retry or re-ask. */
    readonly attempt: number;
  };
  MODEL_CALL_COMPLETED: {
    readonly modelCallId: ModelCallId;
    readonly purpose: ModelCallPurpose;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** False when the provider returned no usage and the counts above are zeros, not measurements. */
    readonly usageReported: boolean;
    readonly latencyMs: number;
    readonly finishReason: FinishReason;
    readonly attempt: number;
  };
  MODEL_CALL_FAILED: {
    readonly modelCallId: ModelCallId;
    readonly purpose: ModelCallPurpose;
    readonly provider: string;
    readonly model: string;
    readonly latencyMs: number;
    readonly errorKind: ModelErrorKind;
    /** Redacted, human-readable. */
    readonly message: string;
    readonly retryable: boolean;
    readonly attempt: number;
  };
  TOOL_SELECTED: { readonly toolName: string; readonly intent: string; readonly attempt: number };
  TOOL_STARTED: { readonly toolName: string };
  TOOL_COMPLETED: {
    readonly toolName: string;
    readonly durationMs: number;
    readonly summary: string;
  };
  TOOL_FAILED: {
    readonly toolName: string;
    readonly durationMs: number;
    readonly errorCode: ToolErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
  COMMAND_STARTED: { readonly command: string; readonly cwd?: string };
  COMMAND_OUTPUT: { readonly stream: 'stdout' | 'stderr'; readonly chunk: string };
  COMMAND_FINISHED: {
    readonly command: string;
    readonly exitCode: number | null;
    readonly durationMs: number;
    readonly timedOut: boolean;
  };
  FILE_CREATED: { readonly path: string; readonly sizeBytes?: number };
  FILE_CHANGED: { readonly path: string; readonly sizeBytes?: number };
  FILE_DELETED: { readonly path: string };
  BROWSER_NAVIGATION: { readonly url: string; readonly title?: string; readonly status?: number };
  /** A sandbox artifact was copied into persistent storage, so it outlives the sandbox. */
  ARTIFACT_STORED: {
    readonly artifactId: ArtifactId;
    readonly sandboxPath: string;
    readonly storageProvider: string;
    readonly key: string;
    readonly sizeBytes: number;
  };
  FAILURE_DETECTED: {
    readonly summary: string;
    readonly source: 'tool' | 'evaluation' | 'runtime';
  };
  RETRY_STARTED: {
    readonly retryOfActionId: ActionId;
    readonly attempt: number;
    readonly changedApproach: boolean;
  };
  STRATEGY_CHANGED: {
    readonly previousStrategyId: StrategyId;
    readonly newStrategyId: StrategyId;
    readonly reason: string;
    readonly summary: string;
  };
  LESSON_CREATED: {
    readonly lessonId: LessonId;
    readonly statement: string;
    readonly confidence: number;
    readonly derivedFromEvaluationIds: readonly EvaluationId[];
  };
  EVALUATION_COMPLETED: {
    readonly evaluationId: EvaluationId;
    readonly verdict: EvaluationVerdict;
    readonly checksPassed: number;
    readonly checksTotal: number;
    readonly gapCount: number;
    readonly summary: string;
    /** Tool-level status of what was judged, so "tool ok, task failed" is visible in the stream. */
    readonly toolStatus: 'ok' | 'error' | 'none';
  };
  GOAL_COMPLETED: { readonly summary: string; readonly iterations: number };
  GOAL_FAILED: {
    readonly reason: string;
    readonly iterations: number;
    /** `gave_up`: the agent chose to stop. `unrecoverable`: a runtime/model error stopped it. */
    readonly cause: 'gave_up' | 'unrecoverable';
  };
  RUN_LIMIT_REACHED: { readonly limit: string; readonly value: number; readonly max: number };
}

/**
 * Compile-time guarantee that every declared event type has a payload shape.
 */
type _AssertAllPayloadsDeclared = {
  [K in AgentEventType]: AgentEventPayloads[K];
};
export type _EventPayloadCheck = _AssertAllPayloadsDeclared;

export interface AgentEvent<TType extends AgentEventType = AgentEventType> {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly eventId: EventId;
  /** Monotonic per run; lets consumers order and detect gaps regardless of transport. */
  readonly sequence: number;
  readonly timestamp: IsoTimestamp;
  readonly runId: RunId;
  readonly goalId?: GoalId;
  readonly type: TType;
  readonly correlation: EventCorrelation;
  readonly payload: AgentEventPayloads[TType];
}

export type AnyAgentEvent = { [K in AgentEventType]: AgentEvent<K> }[AgentEventType];

/** Where the runtime writes events. Transport is an OPEN decision. */
export interface EventSink {
  emit(event: AnyAgentEvent): void;
}

export type EventListener = (event: AnyAgentEvent) => void;
export type Unsubscribe = () => void;

/** What the dashboard reads from. */
export interface EventSource {
  subscribe(listener: EventListener): Unsubscribe;
}
