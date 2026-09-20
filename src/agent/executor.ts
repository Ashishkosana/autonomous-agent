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
  if (result.status === 'ok') {
    return `${result.toolName} returned ok in ${result.durationMs}ms`;
  }
  return `${result.toolName} failed (${result.error.code}): ${result.error.message}`;
}
