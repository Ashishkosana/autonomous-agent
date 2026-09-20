import type { Goal } from '../../domain/goal.js';
import {
  asGoalId,
  asRunId,
  type Clock,
  type GoalId,
  type IdGenerator,
  type RunId,
} from '../../domain/ids.js';
import type { RunCorrelation } from '../../domain/provenance.js';
import type { RunLimits, RunState, RunStatus } from '../../domain/run.js';
import type {
  AgentEvent,
  AgentEventPayloads,
  AgentEventType,
  AnyAgentEvent,
  EventCorrelation,
  EventSink,
} from '../../events/contracts.js';
import { RunEventFactory } from '../../events/factory.js';
import { RunWorkingMemory } from '../../memory/working.js';
import type { ModelCallRecord } from '../../models/contracts.js';
import { RunUsageTracker } from './run-usage.js';

export interface RunSessionOptions {
  readonly goalStatement: string;
  readonly constraints?: readonly string[];
  readonly successCriteria?: readonly string[];
  readonly limits: RunLimits;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly events: EventSink;
}

/**
 * Per-run identity, clock, telemetry and scratch state shared by every
 * runtime component. It owns *no* orchestration logic; it exists so that the
 * runtime, executor, planner and learner agree on ids, sequence numbers and
 * usage counters without reaching for globals.
 */
export class RunSession {
  readonly runId: RunId;
  readonly goal: Goal;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly events: EventSink;
  readonly usage: RunUsageTracker;
  readonly working: RunWorkingMemory;
  private readonly factory: RunEventFactory;
  private readonly startedAt: string;
  private status: RunStatus = 'created';
  private terminationReason: string | undefined;
  private finishedAt: string | undefined;

  constructor(options: RunSessionOptions) {
    this.ids = options.ids;
    this.clock = options.clock;
    this.events = options.events;
    this.runId = asRunId(this.ids.next('run'));
    const goalId: GoalId = asGoalId(this.ids.next('goal'));
    this.startedAt = this.clock.now();
    this.goal = {
      goalId,
      runId: this.runId,
      statement: options.goalStatement,
      constraints: options.constraints ?? [],
      successCriteria: options.successCriteria ?? [],
      receivedAt: this.startedAt,
    };
    this.usage = new RunUsageTracker(options.limits, this.clock);
    this.working = new RunWorkingMemory(this.goal);
    this.factory = new RunEventFactory(this.runId, goalId, this.ids, this.clock);
  }

  emit<TType extends AgentEventType>(
    type: TType,
    payload: AgentEventPayloads[TType],
    correlation: EventCorrelation = {},
  ): AgentEvent<TType> {
    const event = this.factory.create(type, payload, correlation);
    // A generic AgentEvent<TType> is one member of the AnyAgentEvent union by construction.
    this.events.emit(event as unknown as AnyAgentEvent);
    return event;
  }

  /** Correlation for the current point in the run (task included when one is active). */
  correlation(): RunCorrelation {
    const taskId = this.working.getCurrentTaskId();
    return {
      runId: this.runId,
      goalId: this.goal.goalId,
      ...(taskId ? { taskId } : {}),
    };
  }

  /** Hook for the instrumented model provider: account usage and make the call observable. */
  recordModelCall(record: ModelCallRecord): void {
    this.usage.increment('modelCalls');
    this.usage.addTokens(record.usage.inputTokens, record.usage.outputTokens);
    this.emit(
      'MODEL_CALL_COMPLETED',
      {
        modelCallId: record.modelCallId,
        purpose: record.purpose,
        provider: record.descriptor.provider,
        model: record.descriptor.model,
        inputTokens: record.usage.inputTokens,
        outputTokens: record.usage.outputTokens,
        latencyMs: record.latencyMs,
      },
      { modelCallId: record.modelCallId },
    );
  }

  markRunning(): void {
    this.status = 'running';
  }

  finish(status: Exclude<RunStatus, 'created' | 'running'>, reason?: string): void {
    this.status = status;
    this.finishedAt = this.clock.now();
    this.terminationReason = reason;
  }

  isFinished(): boolean {
    return this.status !== 'created' && this.status !== 'running';
  }

  state(): RunState {
    return {
      runId: this.runId,
      goalId: this.goal.goalId,
      status: this.status,
      limits: this.usage.limits,
      usage: this.usage.snapshot,
      startedAt: this.startedAt,
      ...(this.finishedAt ? { finishedAt: this.finishedAt } : {}),
      ...(this.terminationReason ? { terminationReason: this.terminationReason } : {}),
    };
  }
}
