import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEmbeddingProvider,
  describeEmbeddingConfig,
  resolveEmbeddingConfig,
} from '../../src/models/config.js';
import type {
  ModelCallFailure,
  ModelCallRecord,
  ModelCallStart,
} from '../../src/models/contracts.js';
import { cosineSimilarity, type EmbeddingProvider } from '../../src/models/embeddings.js';
import { ModelProviderError } from '../../src/models/errors.js';
import { InstrumentedEmbeddingProvider } from '../../src/models/instrumented-embedding-provider.js';
import {
  OpenAICompatibleEmbeddingProvider,
  parseEmbeddings,
  type OpenAICompatibleEmbeddingConfig,
} from '../../src/models/openai-compatible/embedding-provider.js';
import { FixedClock, SequentialIdGenerator } from '../support/deterministic.js';
import { FakeOpenAIServer, embeddingsEnvelope } from '../support/fake-openai-server.js';

const API_KEY = 'sk-embed-0123456789abcdef0123456789abcdef';

let server: FakeOpenAIServer;
beforeEach(async () => {
  server = await new FakeOpenAIServer().start();
});
afterEach(async () => {
  await server.stop();
});

function provider(overrides: Partial<OpenAICompatibleEmbeddingConfig> = {}) {
  return new OpenAICompatibleEmbeddingProvider(
    {
      baseUrl: server.baseUrl,
      model: 'test-embedding-model',
      apiKey: API_KEY,
      providerLabel: 'fake-embeddings',
      timeoutMs: 2_000,
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

describe('OpenAICompatibleEmbeddingProvider — wire', () => {
  it('POSTs { model, input[] } to <baseUrl>/embeddings with the bearer key and returns one Float32Array per text, in order', async () => {
    server.enqueue({
      kind: 'json',
      body: embeddingsEnvelope(
        [
          [0, 1, 0],
          [1, 0, 0],
        ],
        { indices: [1, 0], promptTokens: 9 },
      ),
    });
    const response = await provider().embed({
      purpose: 'index_memory',
      texts: ['first', 'second'],
    });

    const request = server.requests[0]!;
    expect(request.url).toBe('/v1/embeddings');
    expect(request.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(request.body).toEqual({ model: 'test-embedding-model', input: ['first', 'second'] });

    expect(response.dimensions).toBe(3);
    // index 1 → second text, index 0 → first text: re-ordered by index, not by position
    expect(Array.from(response.vectors[0]!)).toEqual([1, 0, 0]);
    expect(Array.from(response.vectors[1]!)).toEqual([0, 1, 0]);
    expect(response.usage).toEqual({ inputTokens: 9, outputTokens: 0 });
    expect(response.descriptor).toEqual({
      provider: 'fake-embeddings',
      model: 'test-embedding-model',
    });
    expect(response.modelCallId).toBe('mc-1');
  });

  it('passes a requested dimensions value through and refuses vectors of another size', async () => {
    server.enqueue({ kind: 'json', body: embeddingsEnvelope([[0.1, 0.2, 0.3, 0.4]]) });
    const error = await failure(
      provider({ dimensions: 2 }).embed({ purpose: 'query_memory', texts: ['x'] }),
    );
    expect(error.kind).toBe('server');
    expect(error.message).toMatch(/4-dimensional vectors, expected 2/);
    expect(server.requests[0]!.body).toMatchObject({ dimensions: 2 });
  });

  it("learns the model's native size from the first response and refuses a later change", async () => {
    const p = provider();
    server.enqueue({ kind: 'json', body: embeddingsEnvelope([[1, 0]]) });
    await p.embed({ purpose: 'index_memory', texts: ['a'] });
    server.enqueue({ kind: 'json', body: embeddingsEnvelope([[1, 0, 0]]) });
    const error = await failure(p.embed({ purpose: 'index_memory', texts: ['b'] }));
    expect(error.kind).toBe('server');
    expect(error.message).toMatch(/3-dimensional vectors, expected 2/);
  });

  it('splits more than 64 texts into batches and re-joins the vectors in order', async () => {
    const texts = Array.from({ length: 70 }, (_, i) => `text ${i}`);
    server.respondWith((request) => {
      const input = (request.body as { input: string[] }).input;
      return {
        kind: 'json',
        body: embeddingsEnvelope(input.map((t) => [Number(t.slice(5)), 1])),
      };
    });
    const response = await provider().embed({ purpose: 'index_memory', texts });
    expect(server.requests).toHaveLength(2);
    expect((server.requests[0]!.body as { input: string[] }).input).toHaveLength(64);
    expect((server.requests[1]!.body as { input: string[] }).input).toHaveLength(6);
    expect(response.vectors).toHaveLength(70);
    expect(response.vectors[69]![0]).toBe(69);
    expect(response.usage.inputTokens).toBe(24);
  });

  it('rejects empty input before touching the network', async () => {
    expect((await failure(provider().embed({ purpose: 'index_memory', texts: [] }))).kind).toBe(
      'bad_request',
    );
    expect(
      (await failure(provider().embed({ purpose: 'index_memory', texts: ['ok', '  '] }))).kind,
    ).toBe('bad_request');
    expect(server.requests).toHaveLength(0);
  });

  it('maps HTTP failures onto the shared error vocabulary and never echoes the key', async () => {
    server.enqueue({
      kind: 'json',
      status: 401,
      body: { error: { message: `bad key ${API_KEY}` } },
    });
    const error = await failure(provider().embed({ purpose: 'query_memory', texts: ['x'] }));
    expect(error.kind).toBe('authentication');
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('[REDACTED]');
  });

  it('refuses a malformed envelope as a server error: wrong count, missing embedding, non-numeric entry, bad index', () => {
    const cases: [unknown, RegExp][] = [
      [{ data: [] }, /0 vectors for 1 inputs/],
      [{ data: [{ index: 0 }] }, /no embedding array/],
      [{ data: [{ index: 0, embedding: [1, 'x'] }] }, /non-numeric entry at 1/],
      [{ data: [{ index: 0, embedding: [1, Number.NaN] }] }, /non-numeric entry at 1/],
      [{ data: [{ index: 7, embedding: [1] }] }, /bad index/],
      [{ data: [{ index: 0, embedding: [] }] }, /is empty/],
      [{ nope: true }, /no data array/],
    ];
    for (const [body, pattern] of cases) {
      expect(() => parseEmbeddings(body, 1)).toThrow(pattern);
    }
    expect(() =>
      parseEmbeddings(
        {
          data: [
            { index: 0, embedding: [1] },
            { index: 0, embedding: [2] },
          ],
        },
        2,
      ),
    ).toThrow(/bad index/);
  });

  it('reports usage as unreported when the server sends none', async () => {
    server.enqueue({ kind: 'json', body: embeddingsEnvelope([[1, 1]], { promptTokens: null }) });
    const response = await provider().embed({ purpose: 'index_memory', texts: ['a'] });
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0, reported: false });
  });

  it('never exposes the credential through the instance, inspect() or JSON', () => {
    const p = provider();
    const surface = `${inspect(p, { depth: 6 })}${JSON.stringify(p)}${Object.values(p).join(' ')}`;
    expect(surface).not.toContain(API_KEY);
    expect(JSON.parse(JSON.stringify(p))).toEqual({
      provider: 'fake-embeddings',
      model: 'test-embedding-model',
    });
  });

  it('rejects an empty model, a bad dimensions value and a non-http base URL at construction', () => {
    expect(() => provider({ model: ' ' })).toThrow(/model must not be empty/);
    expect(() => provider({ dimensions: 0 })).toThrow(/positive integer/);
    expect(() => provider({ baseUrl: 'ftp://x' })).toThrow(/http\(s\)/);
  });
});

describe('resolveEmbeddingConfig / describeEmbeddingConfig / createEmbeddingProvider', () => {
  it('is "none" when the provider variable is unset and names the missing variables otherwise', () => {
    expect(resolveEmbeddingConfig({})).toEqual({ kind: 'none' });
    expect(() => resolveEmbeddingConfig({ AGENT_EMBEDDING_PROVIDER: 'openai-compatible' })).toThrow(
      /AGENT_EMBEDDING_BASE_URL, AGENT_EMBEDDING_MODEL/,
    );
    expect(() => resolveEmbeddingConfig({ AGENT_EMBEDDING_PROVIDER: 'other' })).toThrow(
      /not a known provider kind/,
    );
  });

  it('does not fall back to the chat model endpoint: AGENT_MODEL_* alone configures no embeddings', () => {
    expect(
      resolveEmbeddingConfig({
        AGENT_MODEL_PROVIDER: 'openai-compatible',
        AGENT_MODEL_BASE_URL: 'http://localhost:11434/v1',
        AGENT_MODEL_NAME: 'x',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('resolves a full configuration; the summary says a key exists but never what it is', () => {
    const config = resolveEmbeddingConfig({
      AGENT_EMBEDDING_PROVIDER: 'openai-compatible',
      AGENT_EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1',
      AGENT_EMBEDDING_MODEL: 'nomic-embed-text',
      AGENT_EMBEDDING_API_KEY: API_KEY,
      AGENT_EMBEDDING_LABEL: 'local',
      AGENT_EMBEDDING_TIMEOUT_MS: '5000',
      AGENT_EMBEDDING_DIMENSIONS: '256',
    });
    expect(config).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'nomic-embed-text',
      apiKey: API_KEY,
      providerLabel: 'local',
      timeoutMs: 5000,
      dimensions: 256,
    });
    const summary = describeEmbeddingConfig(config);
    expect(summary).toEqual({
      kind: 'openai-compatible',
      providerLabel: 'local',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'nomic-embed-text',
      apiKeyConfigured: true,
      dimensions: 256,
      timeoutMs: 5000,
    });
    expect(JSON.stringify(summary)).not.toContain(API_KEY);
    expect(
      createEmbeddingProvider(config, { clock: new FixedClock(), ids: new SequentialIdGenerator() })
        .descriptor,
    ).toEqual({ provider: 'local', model: 'nomic-embed-text' });
    expect(() =>
      createEmbeddingProvider(
        { kind: 'none' },
        { clock: new FixedClock(), ids: new SequentialIdGenerator() },
      ),
    ).toThrow(/no embedding provider configured/);
  });
});

describe('InstrumentedEmbeddingProvider', () => {
  function harness(inner: EmbeddingProvider) {
    const started: ModelCallStart[] = [];
    const calls: ModelCallRecord[] = [];
    const failed: ModelCallFailure[] = [];
    const instrumented = new InstrumentedEmbeddingProvider(inner, {
      runId: 'run-1' as never,
      goalId: 'goal-1' as never,
      clock: new FixedClock(),
      ids: new SequentialIdGenerator(),
      onStarted: (r) => started.push(r),
      onCall: (r) => calls.push(r),
      onFailed: (r) => failed.push(r),
    });
    return { instrumented, started, calls, failed };
  }

  it('reports a completed embedding as a model call with purpose embed_query / embed_memory and the response usage', async () => {
    server.enqueue({ kind: 'json', body: embeddingsEnvelope([[1, 0]], { promptTokens: 5 }) });
    server.enqueue({ kind: 'json', body: embeddingsEnvelope([[0, 1]], { promptTokens: 6 }) });
    const { instrumented, started, calls, failed } = harness(provider());

    const first = await instrumented.embed({ purpose: 'query_memory', texts: ['q'] });
    await instrumented.embed({ purpose: 'index_memory', texts: ['d'], attempt: 2 });

    expect(started.map((s) => s.purpose)).toEqual(['embed_query', 'embed_memory']);
    expect(calls.map((c) => c.usage.inputTokens)).toEqual([5, 6]);
    expect(calls[0]).toMatchObject({
      finishReason: 'stop',
      attempt: 1,
      runId: 'run-1',
      goalId: 'goal-1',
    });
    expect(calls[1]!.attempt).toBe(2);
    expect(first.modelCallId).toBe(started[0]!.modelCallId);
    expect(failed).toHaveLength(0);
  });

  it('reports a failed embedding with its error kind and retryability, then rethrows', async () => {
    server.enqueue({ kind: 'json', status: 503, body: { error: 'busy' } });
    const { instrumented, started, calls, failed } = harness(provider());
    await expect(instrumented.embed({ purpose: 'query_memory', texts: ['q'] })).rejects.toThrow();
    expect(started).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(failed[0]).toMatchObject({
      errorKind: 'server',
      retryable: true,
      purpose: 'embed_query',
    });
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for parallel, 0 for orthogonal, -1 for opposite vectors, and 0 when a vector is all zeros', () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, new Float32Array([2, 4, 6]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
    expect(cosineSimilarity(a, new Float32Array([-1, -2, -3]))).toBeCloseTo(-1, 6);
    expect(cosineSimilarity(a, new Float32Array([0, 0, 0]))).toBe(0);
    expect(() => cosineSimilarity(a, new Float32Array([1]))).toThrow(RangeError);
  });
});
