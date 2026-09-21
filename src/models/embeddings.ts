import type { ModelCallId } from '../domain/ids.js';
import type { ModelDescriptor, ModelUsage } from './contracts.js';

/**
 * Meaning as numbers. An `EmbeddingProvider` turns text into fixed-size
 * vectors that the semantic index compares; it is the second kind of model
 * the agent talks to and lives behind the same discipline as `ModelProvider`:
 * vendor named only in `descriptor.provider`, credential never a property,
 * every failure a `ModelProviderError`, every call observable.
 *
 * Why `query_memory` and `index_memory` are distinct purposes: some
 * embedding models are asymmetric (documents and queries are embedded
 * differently); a provider may use the purpose to pick a prefix or a mode,
 * and telemetry can tell indexing cost from retrieval cost.
 */
export type EmbeddingPurpose = 'index_memory' | 'query_memory';

export interface EmbeddingRequest {
  readonly purpose: EmbeddingPurpose;
  /** One vector is returned per text, in order. Empty input is a caller bug and is rejected. */
  readonly texts: readonly string[];
  /** Telemetry only: 1 for the first attempt; the retry layer increments it. */
  readonly attempt?: number;
}

export interface EmbeddingResponse {
  readonly modelCallId: ModelCallId;
  readonly descriptor: ModelDescriptor;
  /** `vectors[i]` embeds `texts[i]`; all have `dimensions` entries. */
  readonly vectors: readonly Float32Array[];
  readonly dimensions: number;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
}

export interface EmbeddingProvider {
  readonly descriptor: ModelDescriptor;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

/** Cosine similarity in [-1, 1]; 0 when either vector has no magnitude. Same-length inputs only. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(`vector dimensions differ: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
