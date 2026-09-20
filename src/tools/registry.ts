import type { Clock } from '../domain/ids.js';
import { ExecutionEnvironmentError } from '../sandbox/execution-environment.js';
import type { ToolError, ToolResult } from './contracts.js';
import { describeTool, type Tool, type ToolContext, type ToolDescriptor } from './contracts.js';

type AnyTool = Tool<unknown, unknown>;

/**
 * The runtime's catalogue of capabilities. Registration is explicit; nothing
 * is discovered by magic. The model is shown `describeAll()`; the runtime
 * dispatches via `invokeTool`.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as AnyTool);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): readonly string[] {
    return [...this.tools.keys()];
  }

  describeAll(): readonly ToolDescriptor[] {
    return [...this.tools.values()].map(describeTool);
  }
}

interface InvocationTiming {
  readonly startedAt: string;
  readonly startedMs: number;
}

function beginTiming(clock: Clock): InvocationTiming {
  return { startedAt: clock.now(), startedMs: clock.monotonicMs() };
}

function finishTiming(clock: Clock, timing: InvocationTiming) {
  return {
    startedAt: timing.startedAt,
    finishedAt: clock.now(),
    durationMs: Math.max(0, clock.monotonicMs() - timing.startedMs),
  };
}

/**
 * Validate, execute, and wrap a tool call into a structured ToolResult.
 * This function never throws for tool-level failures: unknown tools, invalid
 * input, and exceptions from `execute` all become `status: "error"` results
 * so the runtime can observe and evaluate them like any other outcome.
 */
export async function invokeTool(
  registry: ToolRegistry,
  toolName: string,
  rawInput: unknown,
  context: ToolContext,
): Promise<ToolResult<unknown>> {
  const timing = beginTiming(context.clock);
  const base = { toolName, actionId: context.actionId };

  const tool = registry.get(toolName);
  if (!tool) {
    return {
      ...base,
      ...finishTiming(context.clock, timing),
      status: 'error',
      error: {
        code: 'unknown_tool',
        message: `No tool named "${toolName}" is registered`,
        retryable: false,
      },
    };
  }

  const parsed = tool.parseInput(rawInput);
  if (!parsed.ok) {
    return {
      ...base,
      ...finishTiming(context.clock, timing),
      status: 'error',
      error: {
        code: 'invalid_input',
        message: `Input for tool "${toolName}" was rejected`,
        retryable: true,
        details: parsed.errors,
      },
    };
  }

  try {
    const output = await tool.execute(parsed.value, context);
    const artifacts = tool.artifacts?.(parsed.value, output, context) ?? [];
    return {
      ...base,
      ...finishTiming(context.clock, timing),
      status: 'ok',
      output,
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  } catch (cause: unknown) {
    return {
      ...base,
      ...finishTiming(context.clock, timing),
      status: 'error',
      error: describeFailure(cause),
    };
  }
}

/**
 * Environment-level failures carry a code that says whether trying again can
 * help; everything else is an unexpected exception and stays retryable.
 */
function describeFailure(cause: unknown): ToolError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof ExecutionEnvironmentError) {
    switch (cause.code) {
      case 'not_found':
        return { code: 'not_found', message, retryable: false, details: cause };
      case 'permission_denied':
        return { code: 'permission_denied', message, retryable: false, details: cause };
      case 'unavailable':
        return { code: 'unavailable', message, retryable: true, details: cause };
      case 'internal':
        return { code: 'execution_failed', message, retryable: true, details: cause };
    }
  }
  return { code: 'execution_failed', message, retryable: true, details: cause };
}
