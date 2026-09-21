/**
 * E-009 — KNOWLEDGE READ FROM THE WORLD IN RUN 1 IS FOUND BY MEANING IN RUN 2
 * (Phase 7, ADR-006).
 *
 * Extends E-007's two-process design with the three things Phase 7 added:
 * knowledge ingestion, a real embedding model, and semantic retrieval.
 *
 *   child role=run1  fresh sandbox → the scripted model fetches a style page
 *                    served by the child process itself (web.fetch through the
 *                    sandbox's curl) → the page becomes a KnowledgeRecord, is
 *                    embedded by the REAL embedding model into the shared
 *                    SQLite file → the report is written → sandbox destroyed →
 *                    the page server is closed, so the page no longer exists
 *                    anywhere but in memory
 *   (process exits)
 *   child role=run2  fresh sandbox → a goal phrased with NO indexable term in
 *                    common with the stored page → HybridRetriever returns the
 *                    knowledge record by `semantic` → the planner is shown its
 *                    title, source and excerpt → the plan cites it → the report
 *                    is written correctly on the first attempt.
 *                    Control in the same process: LexicalRetriever over the
 *                    same store with the same goal text.
 *
 * The chat model is scripted in both runs: this proves the ingestion,
 * embedding, persistence and semantic-retrieval plumbing across process and
 * sandbox boundaries with a real embedding model — not that a chat model
 * *chooses* better because of the knowledge.
 */
export const E009_ENV = {
  role: 'AGENT_E009_ROLE',
  dir: 'AGENT_E009_DIR',
} as const;

export type E009Role = 'run1' | 'run2';

export const E009_FILES = {
  memory: 'memory.sqlite',
  run1: 'run1.json',
  run2: 'run2.json',
} as const;

/** The page Run 1 reads. Its wording is chosen to share no indexable term with GOAL_2. */
export const PAGE_TITLE = 'House style for written summaries';
export const PAGE_BODY =
  'Every written summary must finish by naming the material it drew on, under a heading called Sources. Put each entry on a separate line so a reader can check where a claim came from.';
export const PAGE_HTML = `<!doctype html><html><head><title>${PAGE_TITLE}</title></head><body><h1>${PAGE_TITLE}</h1><p>${PAGE_BODY}</p><script>ignored()</script></body></html>`;

/** Run 2's goal: a paraphrase of "write a report that ends with a Sources section" with different words. */
export const GOAL_2 =
  'Produce a brief report file at /workspace/report.md that ends by citing what it was based on';

export interface EmbedCallEvidence {
  readonly purpose: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly ok: boolean;
  readonly errorKind?: string;
}

export interface E009RunEvidence {
  readonly role: E009Role;
  readonly pid: number;
  readonly runId: string;
  readonly goal: string;
  readonly environment: {
    readonly provider: string;
    readonly environmentId: string;
    readonly label: string;
  };
  readonly embeddingModel: { readonly provider: string; readonly model: string };
  readonly status: string;
  readonly terminationReason?: string;
  readonly usage: Record<string, number>;
  /** Run 1 only: the page server and what the loop made of the page. */
  readonly page?: {
    readonly url: string;
    readonly fetchStatus: string;
    readonly ingested: {
      readonly recordId: string;
      readonly title: string;
      readonly source: string;
      readonly keptChars: number;
      readonly truncated: boolean;
      readonly confidence: number;
    } | null;
    readonly indexedInSharedFile: boolean;
    readonly serverClosedBeforeExit: boolean;
  };
  readonly retrieval: {
    readonly hitCount: number;
    readonly recordIds: readonly string[];
    readonly signalsUsed: readonly string[];
    readonly degraded: readonly { readonly signal: string; readonly reason: string }[];
    readonly hits: readonly {
      readonly recordId: string;
      readonly kind: string;
      readonly score: number;
      readonly matchedBy: readonly string[];
    }[];
  };
  /** Run 2 only: the same goal text through the keyword-only retriever over the same store. */
  readonly lexicalControl?: {
    readonly hitCount: number;
    readonly recordIds: readonly string[];
    readonly foundKnowledge: boolean;
    readonly goalTermsOverlappingKnowledge: readonly string[];
  };
  /** Run 2 only: is the page still reachable from this process? */
  readonly pageStillServed?: boolean;
  /** Run 2 only: cosine of the goal against every vector in the file, unranked by keyword (diagnostic). */
  readonly semanticScan?: readonly {
    readonly recordId: string;
    readonly kind: string;
    readonly cosine: number;
  }[];
  readonly plan: {
    readonly informedByRetrievalIds: readonly string[];
    readonly informedByMemoryRecordIds: readonly string[];
  };
  readonly plannerPrompt: {
    readonly mentionsKnowledgeTitle: boolean | null;
    readonly mentionsKnowledgeSource: boolean | null;
    readonly mentionsKnowledgeExcerpt: boolean | null;
  };
  readonly written: Record<string, readonly string[]>;
  readonly embedCalls: readonly EmbedCallEvidence[];
  readonly indexFailures: readonly string[];
  readonly reportExistsInFreshSandboxAtStart: boolean;
  readonly sandboxStatusAfterDestroy: string;
  readonly storeCountsAfterRun: Record<string, number>;
  readonly events: readonly { readonly sequence: number; readonly type: string }[];
}
