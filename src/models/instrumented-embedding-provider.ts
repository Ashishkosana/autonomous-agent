import { asModelCallId } from '../domain/ids.js';
import type { ModelDescriptor } from './contracts.js';
import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResponse } from './embeddings.js';
import { errorKindOf, isRetryableModelError } from './errors.js';
import type { InstrumentationContext } from './instrumented-provider.js';

/**
 * Embedding calls are model calls: they cost tokens and latency and can
 * fail. This decorator reports them through the same `MODEL_CALL_*` records
 * as chat calls, with purpose `embed_memory` / `embed_query`, so the run's
 * model-call count and token usage stay honest once a semantic index is in
 * the loop. `finishReason` is `stop`: an embedding either arrives whole or
 * fails.
 */
export class InstrumentedEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: ModelDescriptor;

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly context: InstrumentationContext,
  ) {
    this.descriptor = inner.descriptor;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const { clock, ids } = this.context;
    const modelCallId = asModelCallId(ids.next('mc'));
    const startedAt = clock.now();
    const startedMs = clock.monotonicMs();
    const common = {
      modelCallId,
      runId: this.context.runId,
      purpose:
        request.purpose === 'query_memory' ? ('embed_query' as const) : ('embed_memory' as const),
      descriptor: this.descriptor,
      startedAt,
      attempt: request.attempt ?? 1,
      ...(this.context.goalId ? { goalId: this.context.goalId } : {}),
    };

    this.context.onStarted(common);
    try {
      const response = await this.inner.embed(request);
      this.context.onCall({
        ...common,
        descriptor: response.descriptor,
        usage: response.usage,
        latencyMs: response.latencyMs,
        finishReason: 'stop',
      });
      return { ...response, modelCallId };
    } catch (error: unknown) {
      this.context.onFailed({
        ...common,
        latencyMs: Math.max(0, clock.monotonicMs() - startedMs),
        errorKind: errorKindOf(error),
        message: error instanceof Error ? error.message : String(error),
        retryable: isRetryableModelError(error),
      });
      throw error;
    }
  }
}
