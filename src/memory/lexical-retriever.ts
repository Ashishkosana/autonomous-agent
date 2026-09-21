import type { Clock } from '../domain/ids.js';
import type { PersistentMemoryRecord } from './records.js';
import type {
  MemoryRetriever,
  RetrievalHit,
  RetrievalQuery,
  RetrievalResult,
} from './retrieval.js';
import { searchableText } from './searchable-text.js';
import type { MemoryStore } from './store.js';

/**
 * The V1 retriever: metadata filtering through the store, then lexical
 * scoring — how many distinct query terms appear in the record's text. It
 * reports exactly those two signals; `semantic` is never claimed (ADR-006,
 * Phase 7, adds it behind `SemanticIndex`).
 *
 * Ranking is deterministic: score descending, then newer records first,
 * then record id — so two runs over the same store retrieve the same set.
 *
 * Scaling note: every candidate the store's metadata filter returns is
 * scored in memory. That is adequate for the record counts a single agent
 * accumulates in V1 and is the reason the semantic index exists as a seam.
 */
export interface LexicalRetrieverOptions {
  /** Terms shorter than this are ignored. Default 3. */
  readonly minTermLength?: number;
  /** Upper bound on candidates scored per retrieval. Default 2000. */
  readonly maxCandidates?: number;
}

export class LexicalRetriever implements MemoryRetriever {
  private readonly minTermLength: number;
  private readonly maxCandidates: number;

  constructor(
    private readonly store: MemoryStore,
    private readonly clock: Clock,
    options: LexicalRetrieverOptions = {},
  ) {
    this.minTermLength = options.minTermLength ?? 3;
    this.maxCandidates = options.maxCandidates ?? 2000;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const startedAt = this.clock.now();
    const startedMs = this.clock.monotonicMs();

    const terms = this.tokenize(query.text);
    const hits: RetrievalHit[] = [];
    if (terms.size > 0) {
      const candidates = await this.store.query({
        kinds: query.kinds,
        ...(query.tags ? { tags: query.tags } : {}),
        limit: this.maxCandidates,
      });
      for (const record of candidates) {
        const score = this.score(terms, record);
        if (score > 0) hits.push({ record, score, matchedBy: ['metadata', 'keyword'] });
      }
      hits.sort(compareHits);
    }

    return {
      retrievalId: query.retrievalId,
      query,
      hits: hits.slice(0, Math.max(0, query.limit)),
      signalsUsed: ['metadata', 'keyword'],
      startedAt,
      finishedAt: this.clock.now(),
      durationMs: this.clock.monotonicMs() - startedMs,
    };
  }

  private score(terms: ReadonlySet<string>, record: PersistentMemoryRecord): number {
    const words = this.tokenize(searchableText(record));
    let n = 0;
    for (const term of terms) if (words.has(term)) n += 1;
    return n;
  }

  private tokenize(text: string): Set<string> {
    return lexicalTerms(text, this.minTermLength);
  }
}

export { searchableText };

/** Distinct lower-cased terms of at least `minTermLength` characters, stopwords removed. */
export function lexicalTerms(text: string, minTermLength = 3): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= minTermLength && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** Deterministic order: score descending, newer first, then record id. */
export function compareHits(a: RetrievalHit, b: RetrievalHit): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.record.createdAt !== b.record.createdAt)
    return a.record.createdAt < b.record.createdAt ? 1 : -1;
  return a.record.recordId < b.record.recordId ? -1 : a.record.recordId > b.record.recordId ? 1 : 0;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'are',
  'was',
  'were',
  'from',
  'into',
  'then',
  'than',
  'not',
  'does',
  'did',
  'will',
  'should',
  'can',
  'must',
  'have',
  'has',
  'had',
  'its',
  'their',
  'there',
  'which',
  'what',
  'who',
  'when',
  'where',
  'how',
  'all',
  'any',
  'each',
  'some',
  'such',
  'only',
  'also',
  'our',
  'your',
  'you',
  'they',
  'them',
  'but',
  'about',
  'after',
  'before',
  'while',
  'been',
  'being',
  'would',
  'could',
  'may',
  'might',
  'shall',
  'per',
  'via',
]);
