import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../models/embeddings.js';
import type { ModelDescriptor } from '../models/contracts.js';

/**
 * The semantic index is opened before the run session exists, but embedding
 * calls must be attributed to that session. The index holds this object;
 * `bind` installs the instrumented provider before `runtime.run()`.
 */
export class DeferredEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: ModelDescriptor;
  private bound: EmbeddingProvider | undefined;

  constructor(raw: EmbeddingProvider) {
    this.descriptor = raw.descriptor;
  }

  bind(provider: EmbeddingProvider): void {
    this.bound = provider;
  }

  embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    if (!this.bound) {
      return Promise.reject(new Error('embedding provider was used before the run was ready'));
    }
    return this.bound.embed(request);
  }
}
