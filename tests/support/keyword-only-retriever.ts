import { asRetrievalId, type Clock, type IdGenerator } from '../../src/domain/ids.js';
import type { PersistentMemoryRecord } from '../../src/memory/records.js';
import type {
  MemoryRetriever,
  RetrievalHit,
  RetrievalQuery,
  RetrievalResult,
} from '../../src/memory/retrieval.js';
import type { MemoryStore } from '../../src/memory/store.js';

/**
 * Deliberately naive retriever for tests: metadata filter via the store, then
 * keyword overlap scoring. It reports exactly which signals it used so that
 * tests can verify the honesty rule ("semantic" is never claimed here).
 */
export class KeywordOnlyRetriever implements MemoryRetriever {
  constructor(
    private readonly store: MemoryStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const startedAt = this.clock.now();
    const startedMs = this.clock.monotonicMs();

    const candidates = await this.store.query({
      kinds: query.kinds,
      ...(query.tags ? { tags: query.tags } : {}),
    });
    const terms = tokenize(query.text);
    const hits: RetrievalHit[] = [];
    for (const record of candidates) {
      const score = overlap(terms, tokenize(searchableText(record)));
      if (score > 0) hits.push({ record, score, matchedBy: ['metadata', 'keyword'] });
    }
    hits.sort((a, b) => b.score - a.score);

    return {
      retrievalId: asRetrievalId(this.ids.next('ret')),
      query,
      hits: hits.slice(0, query.limit),
      signalsUsed: ['metadata', 'keyword'],
      startedAt,
      finishedAt: this.clock.now(),
      durationMs: this.clock.monotonicMs() - startedMs,
    };
  }
}

function searchableText(record: PersistentMemoryRecord): string {
  switch (record.kind) {
    case 'knowledge':
      return `${record.title} ${record.summary} ${record.content} ${record.tags.join(' ')}`;
    case 'experience':
      return `${record.summary} ${record.toolName} ${record.inputSummary} ${record.tags.join(' ')}`;
    case 'decision':
      return `${record.summary} ${record.context} ${record.reason} ${record.tags.join(' ')}`;
    case 'lesson':
      return `${record.summary} ${record.statement} ${record.applicability.join(' ')} ${record.tags.join(' ')}`;
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}
