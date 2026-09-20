import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFail, parseOk } from '../../src/domain/parse.js';
import { ModelProviderError } from '../../src/models/errors.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from '../../src/models/openai-compatible/provider.js';
import { describeTool } from '../../src/tools/contracts.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import { FakeOpenAIServer, completion } from '../support/fake-openai-server.js';
import { echoTool, writeFileTool } from '../support/tools.js';

/**
 * Integration tests over a real local HTTP server speaking the wire format.
 * They prove transport, headers, error mapping and timeouts on the actual
 * `fetch` path — everything except what only a real model can prove.
 */
const API_KEY = 'sk-test-0123456789abcdef0123456789abcdef';
const REFERER = 'https://example.test/attribution-secret-value';

let server: FakeOpenAIServer;

beforeEach(async () => {
  server = await new FakeOpenAIServer().start();
});
afterEach(async () => {
  await server.stop();
});

function provider(overrides: Partial<OpenAICompatibleConfig> = {}) {
  return new OpenAICompatibleProvider(
    {
      baseUrl: server.baseUrl,
      model: 'test-model',
      apiKey: API_KEY,
      providerLabel: 'fake-endpoint',
      timeoutMs: 2_000,
      extraHeaders: { 'http-referer': REFERER },
      ...overrides,
    },
    { clock: new FixedClock(), ids: new SequentialIdGenerator() },
  );
}

async function failure(promise: Promise<unknown>): Promise<ModelProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelProviderError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('OpenAICompatibleProvider — transport', () => {
  it('POSTs to <baseUrl>/chat/completions with the bearer key and extra headers, and returns text', async () => {
    server.enqueue({
      kind: 'json',
      body: completion({
        content: 'hello there',
        usage: { prompt_tokens: 9, completion_tokens: 2 },
      }),
    });
    const p = provider();

    const response = await p.generate({
      purpose: 'summarize',
      messages: [{ role: 'user', content: 'say hello' }],
      temperature: 0.1,
    });

    expect(response.text).toBe('hello there');
    expect(response.descriptor).toEqual({ provider: 'fake-endpoint', model: 'test-model' });
    expect(response.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
    expect(response.finishReason).toBe('stop');
    expect(response.modelCallId).toBe('mc-1');

    const sent = server.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(sent.headers['http-referer']).toBe(REFERER);
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.body).toEqual({
      model: 'test-model',
      messages: [{ role: 'user', content: 'say hello' }],
      temperature: 0.1,
    });
    // The key travels in the header only.
    expect(sent.url).not.toContain(API_KEY);
    expect(sent.rawBody).not.toContain(API_KEY);
  });

  it('works without a key for keyless local servers', async () => {
    server.enqueue({ kind: 'json', body: completion({ content: 'ok' }) });
    const keyless = new OpenAICompatibleProvider(
      { baseUrl: server.baseUrl, model: 'local-model' },
      { clock: new FixedClock(), ids: new SequentialIdGenerator() },
    );
    await keyless.generate({ purpose: 'other', messages: [] });
    expect(server.requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('tolerates a trailing slash on the base URL', async () => {
    server.enqueue({ kind: 'json', body: completion({ content: 'ok' }) });
    await provider({ baseUrl: `${server.baseUrl}/` }).generate({ purpose: 'other', messages: [] });
    expect(server.requests[0]?.url).toBe('/v1/chat/completions');
  });

  it('rejects an invalid configuration up front without touching the network', () => {
    expect(() => provider({ baseUrl: 'ftp://nope' })).toThrow(ModelProviderError);
    expect(() => provider({ model: '  ' })).toThrow(ModelProviderError);
    expect(server.requests).toHaveLength(0);
  });
});

describe('OpenAICompatibleProvider — structured output', () => {
  const request = {
    purpose: 'create_plan' as const,
    messages: [{ role: 'user' as const, content: 'plan' }],
    schema: {
      type: 'object' as const,
      properties: { steps: { type: 'array' as const } },
      required: ['steps'],
    },
    parse: (raw: unknown) => {
      const steps = (raw as { steps?: unknown })?.steps;
      return Array.isArray(steps)
        ? parseOk({ steps: steps as string[] })
        : parseFail('steps must be an array');
    },
  };

  it('requests json_schema output and returns the parsed value', async () => {
    server.enqueue({ kind: 'json', body: completion({ content: '{"steps":["a","b"]}' }) });
    const response = await provider().structuredGenerate(request);
    expect(response.parsed).toEqual({ ok: true, value: { steps: ['a', 'b'] } });
    expect(response.raw).toEqual({ steps: ['a', 'b'] });
    const body = server.requests[0]!.body as { response_format: unknown };
    expect(body.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('uses json_object / prompt modes when configured', async () => {
    server.enqueue({ kind: 'json', body: completion({ content: '{"steps":[]}' }) });
    await provider({ structuredMode: 'json_object' }).structuredGenerate(request);
    expect((server.requests[0]!.body as { response_format: unknown }).response_format).toEqual({
      type: 'json_object',
    });

    server.enqueue({ kind: 'json', body: completion({ content: '{"steps":[]}' }) });
    await provider({ structuredMode: 'prompt' }).structuredGenerate(request);
    expect(
      (server.requests[1]!.body as { response_format?: unknown }).response_format,
    ).toBeUndefined();
  });

  it('a schema-violating answer is a ParseResult failure with the raw value attached, not a throw', async () => {
    server.enqueue({
      kind: 'json',
      body: completion({ content: '```json\n{"steps":"one"}\n```' }),
    });
    const response = await provider().structuredGenerate(request);
    expect(response.parsed).toEqual({ ok: false, errors: ['steps must be an array'] });
    expect(response.raw).toEqual({ steps: 'one' });
  });

  it('prose with no JSON is a ParseResult failure carrying the text', async () => {
    server.enqueue({ kind: 'json', body: completion({ content: 'I cannot do that.' }) });
    const response = await provider().structuredGenerate(request);
    expect(response.parsed).toEqual({
      ok: false,
      errors: ['model output contained no JSON value'],
    });
    expect(response.raw).toBe('I cannot do that.');
  });

  it('truncated output is reported with finishReason length and still parsed honestly', async () => {
    server.enqueue({
      kind: 'json',
      body: completion({ content: '{"steps":["a"', finishReason: 'length' }),
    });
    const response = await provider().structuredGenerate(request);
    expect(response.finishReason).toBe('length');
    expect(response.parsed.ok).toBe(false);
  });
});

describe('OpenAICompatibleProvider — tool actions', () => {
  const tools = [describeTool(writeFileTool), describeTool(echoTool)];
  const request = {
    purpose: 'select_action' as const,
    messages: [{ role: 'user' as const, content: 'act' }],
    tools,
  };

  it('offers wrapped function tools with tool_choice required and translates the call back', async () => {
    server.enqueue({
      kind: 'json',
      body: completion({
        toolCalls: [
          {
            name: 'fs__write',
            arguments: {
              input: { path: '/workspace/r.md', content: 'x' },
              rationale: 'write it',
              confidence: 0.9,
            },
          },
        ],
      }),
    });

    const response = await provider().requestToolAction(request);

    expect(response.proposal).toEqual({
      kind: 'tool',
      toolName: 'fs.write',
      input: { path: '/workspace/r.md', content: 'x' },
      rationale: 'write it',
      confidence: 0.9,
    });
    expect(response.finishReason).toBe('tool_call');
    const body = server.requests[0]!.body as {
      tools: { function: { name: string } }[];
      tool_choice: string;
    };
    expect(body.tool_choice).toBe('required');
    expect(body.tools.map((t) => t.function.name)).toEqual([
      'fs__write',
      'echo',
      'finish',
      'give_up',
    ]);
  });

  it('maps finish and give_up calls', async () => {
    server.enqueue(
      {
        kind: 'json',
        body: completion({
          toolCalls: [{ name: 'finish', arguments: { summary: 's', rationale: 'r' } }],
        }),
      },
      {
        kind: 'json',
        body: completion({ toolCalls: [{ name: 'give_up', arguments: { reason: 'stuck' } }] }),
      },
    );
    const p = provider();
    expect((await p.requestToolAction(request)).proposal).toEqual({
      kind: 'finish',
      summary: 's',
      rationale: 'r',
    });
    expect((await p.requestToolAction(request)).proposal).toEqual({
      kind: 'give_up',
      reason: 'stuck',
    });
  });

  it('accepts a JSON proposal in text when the server ignores the tools', async () => {
    server.enqueue({
      kind: 'json',
      body: completion({
        content: '{"kind":"tool","toolName":"echo","input":{"message":"hi"},"rationale":"r"}',
      }),
    });
    const response = await provider().requestToolAction(request);
    expect(response.proposal).toMatchObject({ kind: 'tool', toolName: 'echo' });
  });

  it('a well-formed answer that is not a tool action is an invalid_response error (re-askable)', async () => {
    server.enqueue({
      kind: 'json',
      body: completion({ content: 'Let me think about which tool to use.' }),
    });
    const error = await failure(provider().requestToolAction(request));
    expect(error.kind).toBe('invalid_response');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/neither a tool call nor a JSON proposal/);
  });

  it('json tool mode asks for a JSON proposal with the tool catalogue in the prompt', async () => {
    server.enqueue({
      kind: 'json',
      body: completion({
        content:
          '{"kind":"tool","toolName":"fs.write","input":{"path":"/w/a","content":"c"},"rationale":"r"}',
      }),
    });
    const response = await provider({ toolMode: 'json' }).requestToolAction(request);
    expect(response.proposal).toMatchObject({ kind: 'tool', toolName: 'fs.write' });
    const body = server.requests[0]!.body as { tools?: unknown; messages: { content: string }[] };
    expect(body.tools).toBeUndefined();
    expect(body.messages.at(-1)?.content).toContain('AVAILABLE TOOLS');
    expect(body.messages.at(-1)?.content).toContain('fs.write');
  });
});

describe('OpenAICompatibleProvider — failure mapping', () => {
  const call = (p: OpenAICompatibleProvider) => p.generate({ purpose: 'other', messages: [] });

  it('401/403 → authentication (not retryable); the key never appears in the error even if echoed back', async () => {
    server.enqueue({
      kind: 'json',
      status: 401,
      body: { error: { message: `Invalid key ${API_KEY} for ${REFERER}` } },
    });
    const error = await failure(call(provider()));
    expect(error.kind).toBe('authentication');
    expect(error.status).toBe(401);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('HTTP 401');
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(REFERER);
    expect(error.message).toContain('[REDACTED]');
  });

  it('429 → rate_limited with Retry-After', async () => {
    server.enqueue({
      kind: 'text',
      status: 429,
      body: 'slow down',
      headers: { 'retry-after': '3' },
    });
    const error = await failure(call(provider()));
    expect(error.kind).toBe('rate_limited');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(3000);
  });

  it('5xx → server (retryable); 4xx → bad_request (not retryable); 504 → timeout', async () => {
    server.enqueue(
      { kind: 'text', status: 503, body: 'overloaded' },
      { kind: 'json', status: 400, body: { error: { message: 'unknown parameter' } } },
      { kind: 'text', status: 504, body: 'gateway timeout' },
    );
    const p = provider();
    expect((await failure(call(p))).kind).toBe('server');
    const bad = await failure(call(p));
    expect(bad.kind).toBe('bad_request');
    expect(bad.retryable).toBe(false);
    expect((await failure(call(p))).kind).toBe('timeout');
  });

  it('a 200 with a non-JSON or malformed body is a server error', async () => {
    server.enqueue(
      { kind: 'text', status: 200, body: '<html>proxy</html>' },
      { kind: 'json', body: { choices: [] } },
    );
    const p = provider();
    expect((await failure(call(p))).kind).toBe('server');
    expect((await failure(call(p))).kind).toBe('server');
  });

  it('a hanging server is a timeout after timeoutMs', async () => {
    server.enqueue({ kind: 'hang', ms: 5_000 });
    const error = await failure(call(provider({ timeoutMs: 80 })));
    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('80 ms');
  });

  it('a dropped connection or unreachable endpoint is a network error', async () => {
    server.enqueue({ kind: 'close' });
    expect((await failure(call(provider()))).kind).toBe('network');

    const unreachable = provider({ baseUrl: 'http://127.0.0.1:9/v1' });
    const error = await failure(call(unreachable));
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });
});

describe('OpenAICompatibleProvider — credential containment', () => {
  it('neither JSON serialisation nor inspection nor enumeration of the provider exposes the key', () => {
    const p = provider();
    expect(JSON.stringify(p)).toBe(
      JSON.stringify({ provider: 'fake-endpoint', model: 'test-model' }),
    );
    expect(inspect(p, { depth: 10, showHidden: true })).not.toContain(API_KEY);
    expect(JSON.stringify(Object.entries(p))).not.toContain(API_KEY);
    expect(
      JSON.stringify(
        Object.getOwnPropertyNames(p).map((k) => (p as unknown as Record<string, unknown>)[k]),
      ),
    ).not.toContain(API_KEY);
  });

  it('responses never carry the key or the raw request', async () => {
    server.enqueue({ kind: 'json', body: completion({ content: 'ok' }) });
    const response = await provider().generate({
      purpose: 'other',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(JSON.stringify(response)).not.toContain(API_KEY);
  });
});
