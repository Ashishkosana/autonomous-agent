import { describe, expect, it } from 'vitest';
import type {
  ModelCallFailure,
  ModelCallRecord,
  ModelCallStart,
  ModelProvider,
} from '../../src/models/contracts.js';
import { ModelProviderError } from '../../src/models/errors.js';
import { InstrumentedModelProvider } from '../../src/models/instrumented-provider.js';
import { RunSession } from '../../src/agent/runtime/run-session.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import { GOAL_ID, RUN_ID } from '../support/fixtures.js';
import { InMemoryEventBus } from '../support/in-memory-event-bus.js';
import { ScriptedModelProvider } from '../support/scripted-model-provider.js';
import { DEFAULT_LIMITS } from '../support/runtime-scenario.js';

function harness(inner: ModelProvider) {
  const started: ModelCallStart[] = [];
  const completed: ModelCallRecord[] = [];
  const failed: ModelCallFailure[] = [];
  const provider = new InstrumentedModelProvider(inner, {
    runId: RUN_ID,
    goalId: GOAL_ID,
    clock: new FixedClock(),
    ids: new SequentialIdGenerator(),
    onStarted: (r) => started.push(r),
    onCall: (r) => completed.push(r),
    onFailed: (r) => failed.push(r),
  });
  return { provider, started, completed, failed };
}

const failing = (error: unknown): ModelProvider => ({
  descriptor: { provider: 'broken', model: 'b0' },
  generate: async () => {
    throw error;
  },
  structuredGenerate: async () => {
    throw error;
  },
  requestToolAction: async () => {
    throw error;
  },
});

describe('InstrumentedModelProvider', () => {
  it('emits a start record before the call and a completion record after it, sharing one id', async () => {
    const inner = new ScriptedModelProvider(
      [{ text: 'hello', inputTokens: 11, outputTokens: 2 }],
      new SequentialIdGenerator(),
    );
    const { provider, started, completed, failed } = harness(inner);

    const response = await provider.generate({
      purpose: 'summarize',
      messages: [{ role: 'user', content: 'x' }],
      attempt: 3,
    });

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(started[0]?.modelCallId).toBe('mc-1');
    expect(completed[0]?.modelCallId).toBe('mc-1');
    expect(response.modelCallId).toBe('mc-1');
    expect(started[0]?.attempt).toBe(3);
    expect(completed[0]).toMatchObject({
      purpose: 'summarize',
      usage: { inputTokens: 11, outputTokens: 2 },
      finishReason: 'stop',
      runId: RUN_ID,
      goalId: GOAL_ID,
      attempt: 3,
    });
    expect(response.text).toBe('hello');
  });

  it('emits a failure record with the error kind and rethrows unchanged', async () => {
    const error = new ModelProviderError('HTTP 429 from model endpoint', 'rate_limited', {
      status: 429,
    });
    const { provider, started, completed, failed } = harness(failing(error));

    await expect(
      provider.requestToolAction({ purpose: 'select_action', messages: [], tools: [] }),
    ).rejects.toBe(error);

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(0);
    expect(failed).toEqual([
      expect.objectContaining({
        modelCallId: 'mc-1',
        purpose: 'select_action',
        errorKind: 'rate_limited',
        message: 'HTTP 429 from model endpoint',
        retryable: true,
        attempt: 1,
      }),
    ]);
  });

  it('classifies non-provider throwables as unknown and not retryable', async () => {
    const { provider, failed } = harness(failing(new TypeError('bug')));
    await expect(provider.generate({ purpose: 'other', messages: [] })).rejects.toThrow('bug');
    expect(failed[0]).toMatchObject({ errorKind: 'unknown', retryable: false, message: 'bug' });
  });
});

describe('RunSession model-call telemetry', () => {
  function session() {
    const events = new InMemoryEventBus();
    const s = new RunSession({
      goalStatement: 'g',
      limits: DEFAULT_LIMITS,
      ids: new SequentialIdGenerator(),
      clock: new FixedClock(),
      events,
    });
    return { s, events };
  }
  const descriptor = { provider: 'openrouter', model: 'some/model' };

  it('counts a model call when it starts, adds tokens when it completes, and flags unreported usage', () => {
    const { s, events } = session();
    s.recordModelCallStarted({
      modelCallId: 'mc-1' as never,
      runId: s.runId,
      purpose: 'create_plan',
      descriptor,
      startedAt: 't',
      attempt: 1,
    });
    expect(s.usage.snapshot.modelCalls).toBe(1);
    expect(s.usage.snapshot.inputTokens).toBe(0);

    s.recordModelCall({
      modelCallId: 'mc-1' as never,
      runId: s.runId,
      purpose: 'create_plan',
      descriptor,
      usage: { inputTokens: 0, outputTokens: 0, reported: false },
      latencyMs: 12,
      finishReason: 'stop',
      startedAt: 't',
      attempt: 1,
    });
    expect(s.usage.snapshot.modelCalls).toBe(1);
    const completed = events.ofType('MODEL_CALL_COMPLETED')[0];
    expect(completed?.payload).toEqual({
      modelCallId: 'mc-1',
      purpose: 'create_plan',
      provider: 'openrouter',
      model: 'some/model',
      inputTokens: 0,
      outputTokens: 0,
      usageReported: false,
      latencyMs: 12,
      finishReason: 'stop',
      attempt: 1,
    });
    expect(completed?.correlation).toEqual({ modelCallId: 'mc-1' });
    expect(events.ofType('MODEL_CALL_STARTED')[0]?.payload).toEqual({
      modelCallId: 'mc-1',
      purpose: 'create_plan',
      provider: 'openrouter',
      model: 'some/model',
      attempt: 1,
    });
  });

  it('records a failed call as an event with the redacted message and no tokens', () => {
    const { s, events } = session();
    s.recordModelCallFailed({
      modelCallId: 'mc-2' as never,
      runId: s.runId,
      purpose: 'select_action',
      descriptor,
      latencyMs: 5,
      startedAt: 't',
      errorKind: 'authentication',
      message: 'HTTP 401 from model endpoint: {"error":"Bearer [REDACTED]"}',
      retryable: false,
      attempt: 2,
    });
    expect(events.ofType('MODEL_CALL_FAILED')[0]?.payload).toMatchObject({
      errorKind: 'authentication',
      retryable: false,
      attempt: 2,
      provider: 'openrouter',
    });
    expect(s.usage.snapshot.inputTokens).toBe(0);
  });
});
