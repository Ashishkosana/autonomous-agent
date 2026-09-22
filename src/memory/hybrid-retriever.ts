import type { Clock, MemoryRecordId } from '../domain/ids.js';
import { compareHits, lexicalTerms } from './lexical-retriever.js';
import type { PersistentMemoryRecord } from './records.js';
import type {
  MemoryRetriever,
  RetrievalDegradation,
  RetrievalDrop,
  RetrievalHit,
  RetrievalQuery,
  RetrievalResult,
  RetrievalSignal,
  ScoreBreakdown,
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
  /**
   * Keep the best hit of every memory kind that has one before filling the
   * remaining slots by score. Default true.
   *
   * E-009 (first batch) showed why: for a goal "write a report", the agent's
   * own experience/decision/lesson records about writing reports are phrased
   * in the goal's vocabulary and sit closest to it in embedding space too, so
   * a single score-ordered list of 5 held only the agent's bookkeeping and
   * the one record that came from the world — the ingested style page —
   * ranked 6th of 6. The planner never saw it. The four memory categories
   * exist because they answer different questions; a retrieval that can
   * silently drop a whole category answers fewer of them.
   */
  readonly kindDiversity?: boolean;
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
  private readonly kindDiversity: boolean;

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
    this.kindDiversity = options.kindDiversity ?? true;
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
    let unmatched = 0;
    for (const record of candidates) {
      const keyword = this.keywordCoverage(terms, record);
      const cosine = semantic.scores.get(record.recordId);
      const semanticHit = cosine !== undefined && cosine >= this.semanticThreshold;
      if (keyword <= 0 && !semanticHit) {
        unmatched += 1;
        continue;
      }
      const matchedBy: RetrievalSignal[] = ['metadata'];
      if (keyword > 0) matchedBy.push('keyword');
      if (semanticHit) matchedBy.push('semantic');
      const combined =
        this.keywordWeight * keyword + (semanticHit ? this.semanticWeight * cosine : 0);
      const breakdown: ScoreBreakdown = {
        lexical: keyword,
        semantic: cosine ?? null,
        semanticAdmitted: semanticHit,
        semanticThreshold: semantic.ran ? this.semanticThreshold : null,
        lexicalWeight: this.keywordWeight,
        semanticWeight: this.semanticWeight,
        combined,
      };
      hits.push({ record, score: combined, matchedBy, breakdown });
    }
    hits.sort(compareHits);
    const limit = Math.max(0, query.limit);
    const selected = rankHits(hits, limit, this.kindDiversity);

    return {
      retrievalId: query.retrievalId,
      query,
      hits: selected.hits,
      signalsUsed,
      ...(degraded.length > 0 ? { degraded } : {}),
      ...(selected.dropped.length > 0 ? { dropped: selected.dropped } : {}),
      candidateCount: candidates.length,
      unmatchedCount: unmatched,
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

/**
 * `ranked` is already in final order. First pass: the best hit of each kind,
 * visited in ranked order, so with a limit smaller than the number of kinds
 * the globally best hits still win. Second pass: the rest, in ranked order.
 * The selection is then re-sorted, so the caller still sees a list ordered by
 * score — the guarantee is about inclusion, not position.
 */
export function selectWithKindDiversity(
  ranked: readonly RetrievalHit[],
  limit: number,
): RetrievalHit[] {
  return rankHits(ranked, limit, true).hits;
}

/**
 * Score order is already applied to `ranked`. Kind diversity (when on) keeps
 * the best hit of each kind before filling remaining slots, then re-sorts.
 * Ranks and drop reasons are attached; scores are not changed.
 */
export function rankHits(
  ranked: readonly RetrievalHit[],
  limit: number,
  diversity: boolean,
): { hits: RetrievalHit[]; dropped: RetrievalDrop[] } {
  const capped = Math.max(0, Math.floor(limit));
  const rankOf = new Map<string, number>();
  ranked.forEach((hit, index) => rankOf.set(hit.record.recordId, index + 1));

  const chosen = new Set<string>();
  if (!diversity || ranked.length <= capped) {
    for (const hit of ranked.slice(0, capped)) chosen.add(hit.record.recordId);
  } else {
    const kindsSeen = new Set<PersistentMemoryRecord['kind']>();
    for (const hit of ranked) {
      if (chosen.size >= capped) break;
      if (kindsSeen.has(hit.record.kind)) continue;
      kindsSeen.add(hit.record.kind);
      chosen.add(hit.record.recordId);
    }
    for (const hit of ranked) {
      if (chosen.size >= capped) break;
      chosen.add(hit.record.recordId);
    }
  }

  const keptByDiversity = new Set<string>();
  if (diversity && ranked.length > capped) {
    for (const id of chosen) {
      if ((rankOf.get(id) ?? 0) > capped) keptByDiversity.add(id);
    }
  }

  const hits = ranked
    .filter((hit) => chosen.has(hit.record.recordId))
    .sort(compareHits)
    .map((hit, index) => ({
      ...hit,
      rankBeforeSelection: rankOf.get(hit.record.recordId) ?? index + 1,
      keptByDiversity: keptByDiversity.has(hit.record.recordId),
      finalRank: index + 1,
    }));

  const dropped: RetrievalDrop[] = ranked
    .filter((hit) => !chosen.has(hit.record.recordId))
    .map((hit) => {
      const rankBeforeSelection = rankOf.get(hit.record.recordId) ?? 0;
      const reason =
        diversity && rankBeforeSelection <= capped ? 'displaced_by_diversity' : 'below_limit';
      return {
        recordId: hit.record.recordId,
        kind: hit.record.kind,
        score: hit.score,
        ...(hit.breakdown ? { breakdown: hit.breakdown } : {}),
        rankBeforeSelection,
        reason,
      };
    });

  return { hits, dropped };
}
