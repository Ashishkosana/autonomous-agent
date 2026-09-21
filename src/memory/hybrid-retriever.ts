import type { Clock, MemoryRecordId } from '../domain/ids.js';
import { compareHits, lexicalTerms } from './lexical-retriever.js';
import type { PersistentMemoryRecord } from './records.js';
import type {
  MemoryRetriever,
  RetrievalDegradation,
  RetrievalHit,
  RetrievalQuery,
  RetrievalResult,
  RetrievalSignal,
  SemanticIndex,
} from './retrieval.js';
import { searchableText } from './searchable-text.js';
import type { MemoryStore } from './store.js';

export interface HybridRetrieverOptions {
  /** Terms shorter than this are ignored by the keyword stage. Default 3. */
  readonly minTermLength?: number;
  /** Upper bound on metadata-filtered candidates scored per retrieval. Default 2000. */
  readonly maxCandidates?: number;
  /**
   * Cosine similarity below this is not a semantic match. Default 0.5 — a
   * deliberately conservative floor for general-purpose embedding models,
   * where unrelated text commonly sits around 0.3–0.45.
   */
  readonly semanticThreshold?: number;
  /** Weight of the keyword stage's [0, 1] term-coverage score. Default 1. */
  readonly keywordWeight?: number;
  /** Weight of the semantic stage's cosine similarity. Default 1. */
  readonly semanticWeight?: number;
}

/**
 * The Phase 7 retriever (ADR-006): three stages, each reported only when it
 * actually ran.
 *
 *   metadata  — the store's indexed filter (kinds, tags) decides eligibility
 *   keyword   — fraction of the query's distinct terms present in the record
 *   semantic  — cosine similarity from the `SemanticIndex`, over the
 *               metadata-eligible candidates only
 *
 * A hit needs at least one positive signal; its `matchedBy` lists exactly
 * the signals that contributed. If the index fails (embedding endpoint down,
 * model mismatch) the retrieval completes lexically, `signalsUsed` omits
 * `semantic`, and `degraded` says why — the caller sees a weaker retrieval,
 * never a silent one. Ranking is deterministic (score, newer first, id).
 */
export class HybridRetriever implements MemoryRetriever {
  private readonly minTermLength: number;
  private readonly maxCandidates: number;
  private readonly semanticThreshold: number;
  private readonly keywordWeight: number;
  private readonly semanticWeight: number;

  constructor(
    private readonly store: MemoryStore,
    private readonly index: SemanticIndex | undefined,
    private readonly clock: Clock,
    options: HybridRetrieverOptions = {},
  ) {
    this.minTermLength = options.minTermLength ?? 3;
    this.maxCandidates = options.maxCandidates ?? 2000;
    this.semanticThreshold = options.semanticThreshold ?? 0.5;
    this.keywordWeight = options.keywordWeight ?? 1;
    this.semanticWeight = options.semanticWeight ?? 1;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const startedAt = this.clock.now();
    const startedMs = this.clock.monotonicMs();
    const signalsUsed: RetrievalSignal[] = ['metadata', 'keyword'];
    const degraded: RetrievalDegradation[] = [];

    const candidates =
      query.text.trim() === ''
        ? []
        : await this.store.query({
            kinds: query.kinds,
            ...(query.tags ? { tags: query.tags } : {}),
            limit: this.maxCandidates,
          });

    const semantic = await this.semanticScores(query.text, candidates);
    if (semantic.ran) signalsUsed.push('semantic');
    if (semantic.degradation) degraded.push(semantic.degradation);

    const terms = lexicalTerms(query.text, this.minTermLength);
    const hits: RetrievalHit[] = [];
    for (const record of candidates) {
      const keyword = this.keywordCoverage(terms, record);
      const cosine = semantic.scores.get(record.recordId);
      const semanticHit = cosine !== undefined && cosine >= this.semanticThreshold;
      if (keyword <= 0 && !semanticHit) continue;
      const matchedBy: RetrievalSignal[] = ['metadata'];
      if (keyword > 0) matchedBy.push('keyword');
      if (semanticHit) matchedBy.push('semantic');
      hits.push({
        record,
        score: this.keywordWeight * keyword + (semanticHit ? this.semanticWeight * cosine : 0),
        matchedBy,
      });
    }
    hits.sort(compareHits);

    return {
      retrievalId: query.retrievalId,
      query,
      hits: hits.slice(0, Math.max(0, query.limit)),
      signalsUsed,
      ...(degraded.length > 0 ? { degraded } : {}),
      startedAt,
      finishedAt: this.clock.now(),
      durationMs: this.clock.monotonicMs() - startedMs,
    };
  }

  private keywordCoverage(terms: ReadonlySet<string>, record: PersistentMemoryRecord): number {
    if (terms.size === 0) return 0;
    const words = lexicalTerms(searchableText(record), this.minTermLength);
    let n = 0;
    for (const term of terms) if (words.has(term)) n += 1;
    return n / terms.size;
  }

  private async semanticScores(
    text: string,
    candidates: readonly PersistentMemoryRecord[],
  ): Promise<{
    ran: boolean;
    scores: ReadonlyMap<MemoryRecordId, number>;
    degradation?: RetrievalDegradation;
  }> {
    const scores = new Map<MemoryRecordId, number>();
    if (!this.index || candidates.length === 0) return { ran: false, scores };
    try {
      const matches = await this.index.search(text, candidates.length, {
        within: candidates.map((c) => c.recordId),
      });
      for (const match of matches) scores.set(match.recordId, match.score);
      return { ran: true, scores };
    } catch (error: unknown) {
      return {
        ran: false,
        scores,
        degradation: {
          signal: 'semantic',
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
