import { describe, expect, it } from 'vitest';
import { asPlanId, asRetrievalId, asStrategyId } from '../src/domain/ids.js';
import { AGENT_EVENT_TYPES, EVENT_SCHEMA_VERSION } from '../src/events/contracts.js';
import { RunEventFactory } from '../src/events/factory.js';
import { FixedClock, SequentialIdGenerator } from './support/deterministic.js';
import { ACTION_ID, GOAL_ID, RUN_ID, TASK_ID } from './support/fixtures.js';
import { InMemoryEventBus } from './support/in-memory-event-bus.js';

describe('event contract', () => {
  it('declares every event type listed in the architecture brief', () => {
    const required = [
      'GOAL_RECEIVED',
      'PLAN_CREATED',
      'PLAN_UPDATED',
      'MEMORY_SEARCH_STARTED',
      'MEMORY_RETRIEVED',
      'MEMORY_WRITTEN',
      'DECISION_CREATED',
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
      'FAILURE_DETECTED',
      'RETRY_STARTED',
      'STRATEGY_CHANGED',
      'LESSON_CREATED',
      'EVALUATION_COMPLETED',
      'GOAL_COMPLETED',
      'GOAL_FAILED',
    ];
    for (const type of required) expect(AGENT_EVENT_TYPES).toContain(type);
  });

  it('stamps events with schema version, run/goal ids, ids and a monotonic sequence', () => {
    const factory = new RunEventFactory(
      RUN_ID,
      GOAL_ID,
      new SequentialIdGenerator(),
      new FixedClock(),
    );

    const first = factory.create('GOAL_RECEIVED', { statement: 'do X' });
    const second = factory.create(
      'TOOL_STARTED',
      { toolName: 'fs.write' },
      { taskId: TASK_ID, actionId: ACTION_ID },
    );

    expect(first.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(first.eventId).toBe('evt-1');
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.runId).toBe(RUN_ID);
    expect(first.goalId).toBe(GOAL_ID);
    expect(first.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(second.correlation).toEqual({ taskId: TASK_ID, actionId: ACTION_ID });
  });

  it('carries provenance identifiers so the dashboard can explain why something happened', () => {
    const factory = new RunEventFactory(
      RUN_ID,
      GOAL_ID,
      new SequentialIdGenerator(),
      new FixedClock(),
    );
    const retrievalId = asRetrievalId('ret-1');
    const planId = asPlanId('plan-2');

    const event = factory.create(
      'PLAN_CREATED',
      {
        planId,
        version: 2,
        strategyId: asStrategyId('strat-2'),
        strategySummary: 'Reuse the approach that worked last run',
        taskCount: 3,
        informedByRetrievalIds: [retrievalId],
        informedByMemoryRecordIds: [],
      },
      { planId, retrievalId },
    );

    expect(event.payload.informedByRetrievalIds).toEqual([retrievalId]);
    expect(event.correlation.retrievalId).toBe(retrievalId);
  });

  it('delivers events to live subscribers and stops after unsubscribe', () => {
    const bus = new InMemoryEventBus();
    const factory = new RunEventFactory(
      RUN_ID,
      GOAL_ID,
      new SequentialIdGenerator(),
      new FixedClock(),
    );
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((e) => seen.push(e.type));

    bus.emit(factory.create('GOAL_RECEIVED', { statement: 'do X' }));
    unsubscribe();
    bus.emit(factory.create('GOAL_COMPLETED', { summary: 'done', iterations: 1 }));

    expect(seen).toEqual(['GOAL_RECEIVED']);
    expect(bus.events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('a factory without a goal omits goalId rather than inventing one', () => {
    const factory = new RunEventFactory(
      RUN_ID,
      undefined,
      new SequentialIdGenerator(),
      new FixedClock(),
    );
    const event = factory.create('RUN_LIMIT_REACHED', { limit: 'maxIterations', value: 50 });
    expect('goalId' in event).toBe(false);
  });
});
