import type { ArtifactRef } from '../domain/artifact.js';
import type { ActionId, Clock, IdGenerator, IsoTimestamp } from '../domain/ids.js';
import type { JsonSchema, ParseResult } from '../domain/parse.js';
import type { RunCorrelation } from '../domain/provenance.js';
import type { AgentEventPayloads, AgentEventType } from '../events/contracts.js';
import type { ExecutionEnvironment } from '../sandbox/execution-environment.js';

/**
 * Event types a tool may emit about its own work. Everything else in the
 * schema belongs to the runtime (planning, selection, evaluation, learning).
 */
export type ToolEventType = Extract<
  AgentEventType,
  | 'COMMAND_STARTED'
  | 'COMMAND_OUTPUT'
  | 'COMMAND_FINISHED'
  | 'FILE_CREATED'
  | 'FILE_CHANGED'
  | 'FILE_DELETED'
  | 'BROWSER_NAVIGATION'
>;

/**
 * Stamps and sequences an event on behalf of the tool. The runtime owns run
 * ids, sequence numbers and the action's correlation; a tool only supplies
 * the observable fact.
 */
export type ToolEventEmitter = <TType extends ToolEventType>(
  type: TType,
  payload: AgentEventPayloads[TType],
) => void;

export type ToolFamily =
  | 'web'
  | 'http'
  | 'browser'
  | 'filesystem'
  | 'terminal'
  | 'code'
  | 'git'
  | 'github'
  | 'memory'
  | 'introspection';

/**
 * Everything a tool is allowed to touch. Tools receive capabilities through
 * this context rather than importing them, so a tool cannot reach outside the
 * environment the runtime handed it.
 */
export interface ToolContext {
  readonly correlation: RunCorrelation;
  readonly actionId: ActionId;
  readonly environment: ExecutionEnvironment;
  readonly emit: ToolEventEmitter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly family: ToolFamily;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  /** Validate untrusted (model-proposed) input before execution. */
  parseInput(input: unknown): ParseResult<TInput>;
  /**
   * Perform the action. May throw; the runtime converts throws into a
   * structured `ToolResult` with status "error".
   */
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
  /**
   * Artifacts the call produced or modified, derived from its input/output.
   * Optional: tools that only read or compute produce none.
   */
  artifacts?(input: TInput, output: TOutput, context: ToolContext): readonly ArtifactRef[];
}

/** The portion of a tool a model provider is shown when asked to pick an action. */
export interface ToolDescriptor {
  readonly name: string;
  readonly family: ToolFamily;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export type ToolErrorCode =
  | 'unknown_tool'
  | 'invalid_input'
  | 'execution_failed'
  | 'not_found'
  | 'permission_denied'
  | 'timeout'
  | 'unavailable';

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
}

interface ToolResultBase {
  readonly toolName: string;
  readonly actionId: ActionId;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly durationMs: number;
}

/**
 * ToolResult records whether the *tool call* completed. It says nothing about
 * whether the *task* succeeded; that judgement is made by an Evaluator from
 * the resulting Observation.
 */
export type ToolResult<TOutput> =
  | (ToolResultBase & {
      readonly status: 'ok';
      readonly output: TOutput;
      readonly artifacts?: readonly ArtifactRef[];
    })
  | (ToolResultBase & { readonly status: 'error'; readonly error: ToolError });

export function describeTool(tool: Tool<unknown, unknown>): ToolDescriptor {
  return {
    name: tool.name,
    family: tool.family,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
