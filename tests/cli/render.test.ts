import { describe, expect, it } from 'vitest';
import { formatRunSummary, renderEvent } from '../../src/cli/render.js';
import {
  asActionId,
  asEvaluationId,
  asEventId,
  asGoalId,
  asMemoryRecordId,
  asRetrievalId,
  asRunId,
} from '../../src/domain/ids.js';
import { ZERO_USAGE, type RunState } from '../../src/domain/run.js';
import {
  EVENT_SCHEMA_VERSION,
  type AgentEventPayloads,
  type AgentEventType,
  type AgentEvent,
  type AnyAgentEvent,
} from '../../src/events/contracts.js';
import { SubscribableEventSink } from '../../src/events/subscriber.js';

function event<T extends AgentEventType>(type: T, payload: AgentEventPayloads[T]): AnyAgentEvent {
  const built: AgentEvent<T> = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: asEventId('evt-1'),
    sequence: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    runId: asRunId('run-1'),
    type,
    correlation: {},
    payload,
  };
  return built as AnyAgentEvent;
}

describe('event rendering', () => {
  it('prints retrieved memory, evaluation, and completion from the event payloads', () => {
    const lines = [
      ...renderEvent(event('GOAL_RECEIVED', { statement: 'Create /workspace/hello.txt' })),
      ...renderEvent(
        event('MEMORY_RETRIEVED', {
          retrievalId: asRetrievalId('ret-1'),
          hitCount: 1,
          recordIds: [asMemoryRecordId('mem-1')],
          kinds: ['lesson'],
          durationMs: 4,
          signalsUsed: ['metadata', 'keyword'],
          degraded: [],
          hits: [
            {
              recordId: asMemoryRecordId('mem-1'),
              score: 1,
              lexical: 1,
              semantic: null,
              semanticAdmitted: false,
              rankBeforeSelection: 1,
              keptByDiversity: false,
              finalRank: 1,
            },
          ],
        }),
      ),
      ...renderEvent(
        event('EVALUATION_COMPLETED', {
          evaluationId: asEvaluationId('eval-1'),
          verdict: 'failure',
          checksPassed: 1,
          checksTotal: 2,
          gapCount: 1,
          summary: '0/1 decisive checks passed',
          toolStatus: 'ok',
          evaluatorName: 'deterministic',
        }),
      ),
      ...renderEvent(event('GOAL_COMPLETED', { summary: 'done', iterations: 2 })),
    ];
    expect(lines.join('\n')).toContain('GOAL');
    expect(lines.join('\n')).toContain('Retrieved 1 records · lesson');
    expect(lines.join('\n')).toContain('failure — 0/1 decisive checks passed');
    expect(lines.join('\n')).toContain('Evaluator: deterministic');
    expect(lines.join('\n')).toContain('🔥 COMPLETED');
  });

  it('says when retrieval was suppressed and clips a huge command chunk', () => {
    const suppressed = renderEvent(
      event('MEMORY_RETRIEVED', {
        retrievalId: asRetrievalId('ret-2'),
        hitCount: 0,
        recordIds: [],
        kinds: [],
        durationMs: 0,
        signalsUsed: [],
        degraded: [],
        suppressed: 'memory_off',
      }),
    ).join('\n');
    expect(suppressed).toContain('memory off');
    const chunk = 'x'.repeat(500);
    const output = renderEvent(event('COMMAND_OUTPUT', { stream: 'stdout', chunk })).join('\n');
    expect(output.length).toBeLessThan(chunk.length);
    expect(output.endsWith('…')).toBe(true);
  });

  it('fans the same event out to two subscribers and isolates a throwing listener', () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const sink = new SubscribableEventSink((error) => errors.push(error));
    sink.subscribe(() => {
      throw new Error('renderer broke');
    });
    sink.subscribe((item) => seen.push(item.type));
    sink.emit(
      event('RETRY_STARTED', {
        retryOfActionId: asActionId('act-1'),
        attempt: 2,
        changedApproach: true,
      }),
    );
    expect(seen).toEqual(['RETRY_STARTED']);
    expect(errors).toHaveLength(1);
  });

  it('summarises usage from the run state', () => {
    const state: RunState = {
      runId: asRunId('run-1'),
      goalId: asGoalId('goal-1'),
      status: 'completed',
      limits: {
        maxIterations: 12,
        maxToolCalls: 16,
        maxModelCalls: 40,
        maxTotalTokens: 500_000,
        maxDurationMs: 1_200_000,
      },
      usage: {
        ...ZERO_USAGE,
        iterations: 2,
        modelCalls: 4,
        toolCalls: 1,
        inputTokens: 10,
        outputTokens: 5,
      },
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    };
    const text = formatRunSummary(state).join('\n');
    expect(text).toContain('Status: completed');
    expect(text).toContain('Iterations: 2');
    expect(text).toContain('Model calls: 4');
    expect(text).toContain('Tokens: 15 (10 in, 5 out)');
    expect(text).toContain('Duration: 1000 ms');
  });
});
