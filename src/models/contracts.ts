import type { GoalId, IsoTimestamp, ModelCallId, RunId } from '../domain/ids.js';
import type { JsonSchema, ParseResult } from '../domain/parse.js';
import type { ToolDescriptor } from '../tools/contracts.js';
import type { ModelErrorKind } from './errors.js';

/**
 * The model layer is the agent's *intelligence*: it proposes plans, actions,
 * judgements and lessons. It has no side effects; every proposal passes
 * through the runtime. The concrete provider is a composition-root choice
 * (ADR-003). Nothing in the runtime may depend on a vendor SDK.
 */

export type ModelRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  readonly role: ModelRole;
  readonly content: string;
  /** Present on `tool` messages: which tool call this content answers. */
  readonly toolCallId?: string;
}

/** Why the runtime is calling the model. Recorded on every ModelCallRecord. */
export type ModelCallPurpose =
  | 'understand_goal'
  | 'create_plan'
  | 'revise_plan'
  | 'select_action'
  | 'evaluate'
  | 'diagnose_failure'
  | 'extract_lesson'
  | 'summarize'
  | 'other';

export interface ModelRequest {
  readonly purpose: ModelCallPurpose;
  readonly messages: readonly ModelMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /**
   * Telemetry only: 1 for the first attempt at a logical call, incremented by
   * the retry/re-ask layer. Providers ignore it.
   */
  readonly attempt?: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * False when the provider returned no usage block and the counts are zeros
   * rather than measurements. Absent means reported.
   */
  readonly reported?: boolean;
}

export type FinishReason = 'stop' | 'length' | 'tool_call' | 'content_filter' | 'error';

export interface ModelDescriptor {
  readonly provider: string;
  readonly model: string;
}

interface ModelResponseBase {
  readonly modelCallId: ModelCallId;
  readonly descriptor: ModelDescriptor;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
  readonly finishReason: FinishReason;
}

export interface ModelResponse extends ModelResponseBase {
  readonly text: string;
}

export interface StructuredModelRequest<T> extends ModelRequest {
  readonly schema: JsonSchema;
  /** Runtime-owned validation of whatever the provider produced. */
  readonly parse: (raw: unknown) => ParseResult<T>;
}

export interface StructuredModelResponse<T> extends ModelResponseBase {
  readonly parsed: ParseResult<T>;
  /** The raw provider output, kept for diagnostics when parsing fails. */
  readonly raw: unknown;
}

export interface ToolActionRequest extends ModelRequest {
  readonly tools: readonly ToolDescriptor[];
}

/**
 * What the model proposes to do next. `rationale` is a concise, human-facing
 * justification suitable for the dashboard — it is not raw chain-of-thought.
 */
export interface ProposalAlternative {
  readonly description: string;
  readonly whyNot: string;
}

export type ToolActionProposal =
  | {
      readonly kind: 'tool';
      readonly toolName: string;
      readonly input: unknown;
      readonly rationale: string;
      /** Other options the model says it weighed. Optional: not every provider can report them. */
      readonly alternatives?: readonly ProposalAlternative[];
      /** 0..1, optional for the same reason. */
      readonly confidence?: number;
    }
  | { readonly kind: 'finish'; readonly summary: string; readonly rationale: string }
  | { readonly kind: 'give_up'; readonly reason: string };

export interface ToolActionResponse extends ModelResponseBase {
  readonly proposal: ToolActionProposal;
}

export interface ModelProvider {
  readonly descriptor: ModelDescriptor;
  generate(request: ModelRequest): Promise<ModelResponse>;
  structuredGenerate<T>(request: StructuredModelRequest<T>): Promise<StructuredModelResponse<T>>;
  requestToolAction(request: ToolActionRequest): Promise<ToolActionResponse>;
}

/** Telemetry row for one model call. Drives "Model Calls" and "Token Usage" on the dashboard. */
export interface ModelCallRecord {
  readonly modelCallId: ModelCallId;
  readonly runId: RunId;
  readonly goalId?: GoalId;
  readonly purpose: ModelCallPurpose;
  readonly descriptor: ModelDescriptor;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
  readonly finishReason: FinishReason;
  readonly startedAt: IsoTimestamp;
  readonly attempt: number;
}

/** Emitted before a call is made, so a hung provider is visible on the dashboard. */
export interface ModelCallStart {
  readonly modelCallId: ModelCallId;
  readonly runId: RunId;
  readonly goalId?: GoalId;
  readonly purpose: ModelCallPurpose;
  readonly descriptor: ModelDescriptor;
  readonly startedAt: IsoTimestamp;
  readonly attempt: number;
}

/** Telemetry row for a call that threw. `message` is already redacted by the provider. */
export interface ModelCallFailure {
  readonly modelCallId: ModelCallId;
  readonly runId: RunId;
  readonly goalId?: GoalId;
  readonly purpose: ModelCallPurpose;
  readonly descriptor: ModelDescriptor;
  readonly latencyMs: number;
  readonly startedAt: IsoTimestamp;
  readonly errorKind: ModelErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly attempt: number;
}
