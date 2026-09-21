import { asModelCallId } from '../../src/domain/ids.js';
import type { ModelDescriptor } from '../../src/models/contracts.js';
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../../src/models/embeddings.js';
import { ModelProviderError } from '../../src/models/errors.js';

/**
 * Deterministic "meaning" for tests: words are mapped to concept slots
 * through a small synonym table, so paraphrases land close together and
 * unrelated text does not — without a network or a model. Unknown words hash
 * into the remaining slots so distinct texts stay distinguishable.
 *
 * This is a test double for `EmbeddingProvider`; it makes semantic retrieval
 * *testable*, it does not make it *proven* (that is E-008, with a real model).
 */
const CONCEPTS: readonly (readonly string[])[] = [
  ['report', 'document', 'writeup', 'write-up', 'paper', 'memo'],
  ['sources', 'citations', 'references', 'bibliography', 'cite', 'cited'],
  ['python', 'py', 'python3', 'interpreter'],
  ['failure', 'failed', 'fail', 'error', 'broke', 'broken'],
  ['success', 'succeeded', 'worked', 'passed'],
  ['directory', 'folder', 'dir'],
  ['file', 'files', 'artifact'],
  ['network', 'internet', 'http', 'fetch', 'download', 'web'],
  ['sandbox', 'container', 'environment', 'linux'],
  ['memory', 'remember', 'recall', 'persist', 'persisted', 'stored'],
  ['plan', 'strategy', 'approach', 'steps'],
  ['test', 'tests', 'testing', 'verify', 'verified'],
  ['weather', 'forecast', 'rain', 'temperature', 'climate'],
  ['recipe', 'cooking', 'bake', 'ingredients', 'oven'],
];
const CONCEPT_SLOTS = CONCEPTS.length;
const HASH_SLOTS = 50;
export const FAKE_EMBEDDING_DIMENSIONS = CONCEPT_SLOTS + HASH_SLOTS;

const conceptOf = new Map<string, number>();
CONCEPTS.forEach((words, slot) => words.forEach((w) => conceptOf.set(w, slot)));

export function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(FAKE_EMBEDDING_DIMENSIONS);
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}-]+/u)) {
    if (raw.length < 3) continue;
    const slot = conceptOf.get(raw);
    if (slot !== undefined) v[slot] = (v[slot] ?? 0) + 1;
    else {
      const h = CONCEPT_SLOTS + (fnv1a(raw) % HASH_SLOTS);
      v[h] = (v[h] ?? 0) + 0.25;
    }
  }
  return v;
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: ModelDescriptor;
  readonly requests: EmbeddingRequest[] = [];
  private pendingFailures: ModelProviderError[] = [];
  private calls = 0;

  constructor(model = 'fake-concepts-v1') {
    this.descriptor = { provider: 'fake-embeddings', model };
  }

  /** The next `embed()` calls throw these errors, in order. */
  failNext(...errors: ModelProviderError[]): this {
    this.pendingFailures.push(...errors);
    return this;
  }

  get callCount(): number {
    return this.calls;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.requests.push(request);
    this.calls += 1;
    const failure = this.pendingFailures.shift();
    if (failure) throw failure;
    if (request.texts.length === 0) {
      throw new ModelProviderError('embed() needs at least one text', 'bad_request');
    }
    return {
      modelCallId: asModelCallId(`mc-fake-${this.calls}`),
      descriptor: this.descriptor,
      vectors: request.texts.map(fakeEmbed),
      dimensions: FAKE_EMBEDDING_DIMENSIONS,
      usage: { inputTokens: request.texts.join(' ').split(/\s+/).length, outputTokens: 0 },
      latencyMs: 1,
    };
  }
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
