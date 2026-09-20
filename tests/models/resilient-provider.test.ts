import { describe, expect, it } from 'vitest';
import { parseFail, parseOk } from '../../src/domain/parse.js';
import type {
  ModelProvider,
  ModelRequest,
  StructuredModelRequest,
  ToolActionRequest,
} from '../../src/models/contracts.js';
import { ModelProviderError } from '../../src/models/errors.js';
import { ResilientModelProvider } from '../../src/models/resilient-provider.js';
import { describeTool } from '../../src/tools/contracts.js';
import { echoTool } from '../support/tools.js';

/** Inner provider whose behaviour per attempt is scripted; records what it received. */
function scriptedInner(script: readonly (unknown | Error)[]) {
  const calls: ModelRequest[] = [];
  let index = 0;
  const next = () => {
    const step = script[index];
    index += 1;
    if (step === undefined) throw new Error('script exhausted');
    if (step instanceof Error) throw step;
    return step;
  };
  const base = () => ({
    modelCallId: `mc-${index}` as never,
    descriptor: { provider: 'inner', model: 'i0' },
    usage: { inputTokens: 1, outputTokens: 1 },
    latencyMs: 1,
    finishReason: 'stop' as const,
  });
  const provider: ModelProvider = {
    descriptor: { provider: 'inner', model: 'i0' },
    async generate(request) {
      calls.push(request);
      return { ...base(), text: String(next()) };
    },
    async structuredGenerate<T>(request: StructuredModelRequest<T>) {
      calls.push(request);
      const raw = next();
      return { ...base(), raw, parsed: request.parse(raw) };
    },
    async requestToolAction(request: ToolActionRequest) {
      calls.push(request);
      const step = next() as { toolName: string };
      return {
        ...base(),
        proposal: { kind: 'tool' as const, toolName: step.toolName, input: {}, rationale: 'r' },
      };
    },
  };
  return { provider, calls };
}

const rateLimited = (retryAfterMs?: number) =>
  new ModelProviderError('HTTP 429', 'rate_limited', {
    status: 429,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

function sleeper() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe('ResilientModelProvider — transient retries', () => {
  it('retries transient failures with exponential backoff, honouring Retry-After, up to maxRetries', async () => {
    const { provider: inner, calls } = scriptedInner([rateLimited(), rateLimited(250), 'ok']);
    const { slept, sleep } = sleeper();
    const provider = new ResilientModelProvider(inner, { maxRetries: 2, baseDelayMs: 100, sleep });

    const response = await provider.generate({ purpose: 'other', messages: [] });

    expect(response.text).toBe('ok');
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(slept).toEqual([100, 250]);
  });

  it('gives up after the retry budget and surfaces the last transient error', async () => {
    const { provider: inner, calls } = scriptedInner([
      new ModelProviderError('down', 'server'),
      new ModelProviderError('still down', 'server'),
      'never reached',
    ]);
    const provider = new ResilientModelProvider(inner, { maxRetries: 1, sleep: async () => {} });

    await expect(provider.generate({ purpose: 'other', messages: [] })).rejects.toThrow(
      'still down',
    );
    expect(calls).toHaveLength(2);
  });

  it('never retries authentication, configuration or bad-request failures', async () => {
    for (const kind of ['authentication', 'configuration', 'bad_request'] as const) {
      const { provider: inner, calls } = scriptedInner([new ModelProviderError('no', kind), 'ok']);
      const provider = new ResilientModelProvider(inner, { maxRetries: 3, sleep: async () => {} });
      await expect(provider.generate({ purpose: 'other', messages: [] })).rejects.toThrow('no');
      expect(calls).toHaveLength(1);
    }
  });

  it('caps delays at maxDelayMs', async () => {
    const { provider: inner } = scriptedInner([rateLimited(60_000), rateLimited(), 'ok']);
    const { slept, sleep } = sleeper();
    const provider = new ResilientModelProvider(inner, {
      maxRetries: 2,
      baseDelayMs: 5_000,
      maxDelayMs: 1_000,
      sleep,
    });
    await provider.generate({ purpose: 'other', messages: [] });
    expect(slept).toEqual([1_000, 1_000]);
  });
});

describe('ResilientModelProvider — re-asking after invalid output', () => {
  const request: StructuredModelRequest<{ n: number }> = {
    purpose: 'create_plan',
    messages: [{ role: 'user', content: 'give me n' }],
    schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    parse: (raw) => {
      const n = (raw as { n?: unknown })?.n;
      return typeof n === 'number' ? parseOk({ n }) : parseFail('n must be a number');
    },
  };

  it('appends the rejected answer and the validation errors, then returns the corrected result', async () => {
    const { provider: inner, calls } = scriptedInner([{ n: 'three' }, { n: 3 }]);
    const provider = new ResilientModelProvider(inner, { maxReasks: 1, sleep: async () => {} });

    const response = await provider.structuredGenerate(request);

    expect(response.parsed).toEqual({ ok: true, value: { n: 3 } });
    expect(calls).toHaveLength(2);
    const second = calls[1]!;
    expect(second.attempt).toBe(2);
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.messages[1]?.content).toBe('{"n":"three"}');
    expect(second.messages[2]?.content).toContain('n must be a number');
    // The original request is not mutated.
    expect(request.messages).toHaveLength(1);
  });

  it('returns the parse failure — never throws — once the re-ask budget is spent', async () => {
    const { provider: inner, calls } = scriptedInner([{ n: 'a' }, { n: 'b' }, { n: 3 }]);
    const provider = new ResilientModelProvider(inner, { maxReasks: 1, sleep: async () => {} });

    const response = await provider.structuredGenerate(request);

    expect(response.parsed).toEqual({ ok: false, errors: ['n must be a number'] });
    expect(response.raw).toEqual({ n: 'b' });
    expect(calls).toHaveLength(2);
  });

  it('with maxReasks 0 the first answer is final', async () => {
    const { provider: inner, calls } = scriptedInner([{ n: 'a' }, { n: 3 }]);
    const provider = new ResilientModelProvider(inner, { maxReasks: 0 });
    const response = await provider.structuredGenerate(request);
    expect(response.parsed.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('re-asks a tool action after an invalid_response error and rethrows when the budget is spent', async () => {
    const invalid = new ModelProviderError(
      'model did not return a valid tool action: no tool call',
      'invalid_response',
    );
    const toolRequest: ToolActionRequest = {
      purpose: 'select_action',
      messages: [{ role: 'user', content: 'act' }],
      tools: [describeTool(echoTool)],
    };

    const first = scriptedInner([invalid, { toolName: 'echo' }]);
    const recovered = new ResilientModelProvider(first.provider, {
      maxReasks: 1,
      sleep: async () => {},
    });
    const response = await recovered.requestToolAction(toolRequest);
    expect(response.proposal).toMatchObject({ kind: 'tool', toolName: 'echo' });
    expect(first.calls).toHaveLength(2);
    expect(first.calls[1]?.messages.at(-1)?.content).toContain('no tool call');
    expect(first.calls[1]?.attempt).toBe(2);

    const second = scriptedInner([invalid, invalid, { toolName: 'echo' }]);
    const exhausted = new ResilientModelProvider(second.provider, {
      maxReasks: 1,
      sleep: async () => {},
    });
    await expect(exhausted.requestToolAction(toolRequest)).rejects.toBe(invalid);
    expect(second.calls).toHaveLength(2);
  });

  it('combines a transient retry and a re-ask, numbering attempts continuously', async () => {
    const { provider: inner, calls } = scriptedInner([rateLimited(), { n: 'x' }, { n: 1 }]);
    const provider = new ResilientModelProvider(inner, {
      maxRetries: 1,
      maxReasks: 1,
      sleep: async () => {},
    });
    const response = await provider.structuredGenerate(request);
    expect(response.parsed).toEqual({ ok: true, value: { n: 1 } });
    expect(calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
  });
});
