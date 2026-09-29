import type { Action } from '../domain/action.js';
import { asObservationId } from '../domain/ids.js';
import type { Observation } from '../domain/observation.js';
import type { EventCorrelation } from '../events/contracts.js';
import type { ExecutionEnvironment } from '../sandbox/execution-environment.js';
import type { ToolResult } from '../tools/contracts.js';
import { invokeTool, type ToolRegistry } from '../tools/registry.js';
import type { Executor } from './contracts.js';
import type { RunSession } from './runtime/run-session.js';

/**
 * Executes one Action through the tool registry against the run's execution
 * environment and reports what happened as an Observation. Emits the
 * tool-level events; it never judges whether the task progressed.
 */
export class ToolExecutor implements Executor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly environment: ExecutionEnvironment,
    private readonly session: RunSession,
  ) {}

  async execute(action: Action): Promise<Observation> {
    const correlation: EventCorrelation = {
      planId: action.planId,
      actionId: action.actionId,
      ...(action.correlation.taskId ? { taskId: action.correlation.taskId } : {}),
      ...(action.decisionId ? { decisionId: action.decisionId } : {}),
    };
    this.session.emit('TOOL_STARTED', { toolName: action.toolName }, correlation);
    this.session.usage.increment('toolCalls');

    const result = await invokeTool(this.registry, action.toolName, action.input, {
      correlation: action.correlation,
      actionId: action.actionId,
      environment: this.environment,
      // Tool events are stamped by the run session and inherit the action's correlation.
      emit: (type, payload) => this.session.emit(type, payload, correlation),
      clock: this.session.clock,
      ids: this.session.ids,
    });

    const observation: Observation = {
      observationId: asObservationId(this.session.ids.next('obs')),
      actionId: action.actionId,
      correlation: action.correlation,
      toolResult: result,
      artifacts: result.status === 'ok' ? (result.artifacts ?? []) : [],
      summary: summarise(result),
      observedAt: this.session.clock.now(),
    };

    if (result.status === 'ok') {
      this.session.emit(
        'TOOL_COMPLETED',
        { toolName: action.toolName, durationMs: result.durationMs, summary: observation.summary },
        { ...correlation, observationId: observation.observationId },
      );
    } else {
      this.session.emit(
        'TOOL_FAILED',
        {
          toolName: action.toolName,
          durationMs: result.durationMs,
          errorCode: result.error.code,
          message: result.error.message,
          retryable: result.error.retryable,
        },
        { ...correlation, observationId: observation.observationId },
      );
    }
    return observation;
  }
}

function summarise(result: ToolResult<unknown>): string {
  if (result.status !== 'ok') {
    return `${result.toolName} failed (${result.error.code}): ${result.error.message}`;
  }
  const detail = outputExcerpt(result.toolName, result.output);
  const base = `${result.toolName} returned ok in ${result.durationMs}ms`;
  return detail === undefined ? base : `${base}. ${detail}`;
}

const OUTPUT_EXCERPT_CHARS = 500;

/**
 * The selector only sees this summary. A bare "returned ok" made the model
 * fetch example.com again instead of writing the lesson file.
 */
function outputExcerpt(toolName: string, output: unknown): string | undefined {
  if (!isPlainRecord(output)) return undefined;
  if (toolName === 'web.fetch' || toolName === 'http.request') {
    const url = stringField(output, 'finalUrl') ?? stringField(output, 'url');
    const title = stringField(output, 'title');
    const text = stringField(output, 'text') ?? stringField(output, 'body');
    const parts = [
      url === undefined ? undefined : `url ${url}`,
      title === undefined ? undefined : `title ${JSON.stringify(title)}`,
      text === undefined ? undefined : `text ${JSON.stringify(clip(text))}`,
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join('; ');
  }
  if (toolName === 'fs.write') {
    const path = stringField(output, 'path');
    return path === undefined ? undefined : `wrote ${path}`;
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > OUTPUT_EXCERPT_CHARS ? `${flat.slice(0, OUTPUT_EXCERPT_CHARS)}…` : flat;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
