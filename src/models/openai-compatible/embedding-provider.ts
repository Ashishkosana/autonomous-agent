import { asModelCallId, type Clock, type IdGenerator } from '../../domain/ids.js';
import type { ModelDescriptor } from '../contracts.js';
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from '../embeddings.js';
import { ModelProviderError } from '../errors.js';
import { OpenAICompatibleTransport, type TransportConfig } from './transport.js';
import { toUsage } from './wire.js';

export interface OpenAICompatibleEmbeddingConfig extends TransportConfig {
  readonly model: string;
  /** Label reported in `descriptor.provider` and telemetry. */
  readonly providerLabel?: string;
  /**
   * Ask the server for vectors of this size (Matryoshka-style models honour it;
   * others reject it). Unset means the model's native size, learned from the
   * first response and enforced thereafter.
   */
  readonly dimensions?: number;
}

export interface OpenAICompatibleEmbeddingDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly fetch?: typeof fetch;
}

/** Largest batch sent in one request; longer inputs are split and the vectors re-joined in order. */
const MAX_BATCH = 64;

/**
 * `EmbeddingProvider` over the OpenAI `/embeddings` wire format
 * (`{ model, input: string[] }` → `{ data: [{ index, embedding }], usage }`),
 * which Ollama, vLLM, llama.cpp, OpenRouter and the hosted vendors all speak.
 *
 * The response is validated strictly: one vector per input, numeric entries,
 * identical dimensions. A server that returns anything else produces a
 * `server` error — a half-parsed vector must never reach the index.
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: ModelDescriptor;
  private readonly transport: OpenAICompatibleTransport;
  private readonly model: string;
  private readonly requestedDimensions: number | undefined;
  private observedDimensions: number | undefined;
  private readonly ids: IdGenerator;

  constructor(config: OpenAICompatibleEmbeddingConfig, deps: OpenAICompatibleEmbeddingDeps) {
    if (config.model.trim() === '') {
      throw new ModelProviderError('embedding model must not be empty', 'configuration');
    }
    if (
      config.dimensions !== undefined &&
      (!Number.isInteger(config.dimensions) || config.dimensions <= 0)
    ) {
      throw new ModelProviderError('dimensions must be a positive integer', 'configuration');
    }
    this.transport = new OpenAICompatibleTransport(config, {
      clock: deps.clock,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    this.descriptor = {
      provider: config.providerLabel ?? 'openai-compatible',
      model: config.model,
    };
    this.model = config.model;
    this.requestedDimensions = config.dimensions;
    this.ids = deps.ids;
  }

  toJSON(): ModelDescriptor {
    return this.descriptor;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (request.texts.length === 0) {
      throw new ModelProviderError('embed() needs at least one text', 'bad_request');
    }
    for (const [i, text] of request.texts.entries()) {
      if (text.trim() === '') {
        throw new ModelProviderError(`embed() text #${i} is empty`, 'bad_request');
      }
    }

    const vectors: Float32Array[] = [];
    let inputTokens = 0;
    let reported = true;
    let latencyMs = 0;
    for (let start = 0; start < request.texts.length; start += MAX_BATCH) {
      const batch = request.texts.slice(start, start + MAX_BATCH);
      const { json, latencyMs: batchLatency } = await this.transport.postJson('embeddings', {
        model: this.model,
        input: batch,
        ...(this.requestedDimensions !== undefined ? { dimensions: this.requestedDimensions } : {}),
      });
      latencyMs += batchLatency;
      let parsed: { vectors: Float32Array[]; inputTokens: number; reported: boolean };
      try {
        parsed = parseEmbeddings(json, batch.length);
      } catch (error: unknown) {
        throw this.transport.redactError(error);
      }
      vectors.push(...parsed.vectors);
      inputTokens += parsed.inputTokens;
      reported = reported && parsed.reported;
    }

    const dimensions = this.checkDimensions(vectors);
    return {
      modelCallId: asModelCallId(this.ids.next('mc')),
      descriptor: this.descriptor,
      vectors,
      dimensions,
      usage: { inputTokens, outputTokens: 0, ...(reported ? {} : { reported: false }) },
      latencyMs,
    };
  }

  private checkDimensions(vectors: readonly Float32Array[]): number {
    const dimensions = vectors[0]?.length ?? 0;
    for (const [i, v] of vectors.entries()) {
      if (v.length !== dimensions) {
        throw new ModelProviderError(
          `embedding #${i} has ${v.length} dimensions, expected ${dimensions}`,
          'server',
        );
      }
    }
    const expected = this.requestedDimensions ?? this.observedDimensions;
    if (expected !== undefined && dimensions !== expected) {
      throw new ModelProviderError(
        `embedding model returned ${dimensions}-dimensional vectors, expected ${expected}`,
        'server',
      );
    }
    this.observedDimensions = dimensions;
    return dimensions;
  }
}

/** Strict parse of an OpenAI-format embeddings envelope for exactly `expectedCount` inputs. */
export function parseEmbeddings(
  body: unknown,
  expectedCount: number,
): { vectors: Float32Array[]; inputTokens: number; reported: boolean } {
  if (!isRecord(body) || !Array.isArray(body['data'])) {
    throw new ModelProviderError('embeddings response has no data array', 'server');
  }
  const data = body['data'] as unknown[];
  if (data.length !== expectedCount) {
    throw new ModelProviderError(
      `embeddings response has ${data.length} vectors for ${expectedCount} inputs`,
      'server',
    );
  }
  const vectors: Float32Array[] = new Array<Float32Array>(expectedCount);
  data.forEach((item, position) => {
    if (!isRecord(item) || !Array.isArray(item['embedding'])) {
      throw new ModelProviderError(`embeddings data #${position} has no embedding array`, 'server');
    }
    const index = typeof item['index'] === 'number' ? item['index'] : position;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount || vectors[index]) {
      throw new ModelProviderError(`embeddings data #${position} has a bad index`, 'server');
    }
    const raw = item['embedding'] as unknown[];
    if (raw.length === 0) {
      throw new ModelProviderError(`embeddings data #${position} is empty`, 'server');
    }
    const vector = new Float32Array(raw.length);
    raw.forEach((value, i) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ModelProviderError(
          `embeddings data #${position} has a non-numeric entry at ${i}`,
          'server',
        );
      }
      vector[i] = value;
    });
    vectors[index] = vector;
  });
  const usage = toUsage(
    isRecord(body['usage']) ? { ...body['usage'], completion_tokens: 0 } : undefined,
  );
  return {
    vectors,
    inputTokens: usage.inputTokens,
    reported: usage.reported !== false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
