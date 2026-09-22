import type { Clock } from '../domain/ids.js';
import type { MemoryRetriever, RetrievalQuery, RetrievalResult } from './retrieval.js';

/**
 * Memory-off arm of a comparison. It does not call the inner retriever, so
 * it does not embed the query or read the store. The result says
 * `suppressed: 'memory_off'` so a trajectory can tell "nothing matched"
 * from "memory was held out".
 */
export class SuppressedRetriever implements MemoryRetriever {
  constructor(private readonly clock: Clock) {}

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const startedAt = this.clock.now();
    const startedMs = this.clock.monotonicMs();
    return {
      retrievalId: query.retrievalId,
      query,
      hits: [],
      signalsUsed: [],
      suppressed: 'memory_off',
      candidateCount: 0,
      unmatchedCount: 0,
      startedAt,
      finishedAt: this.clock.now(),
      durationMs: this.clock.monotonicMs() - startedMs,
    };
  }
}
