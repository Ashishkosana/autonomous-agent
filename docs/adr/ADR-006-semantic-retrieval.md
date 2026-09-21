# ADR-006 — Semantic retrieval: embeddings behind `EmbeddingProvider`, vectors in SQLite, hybrid ranking with per-kind inclusion

Status: Accepted; proven with a real embedding model across processes and sandboxes (E-008, E-009)
Date: 2026-09-21

## Problem

Through Phase 6 the only retrieval signal beyond metadata was distinct-term overlap
(`LexicalRetriever`). E-007b showed the consequence for the research question: a record is
only found when a later goal happens to reuse its words, and records the agent wrote about
itself (experience, decision, lesson) are always in the agent's own vocabulary while
anything read from the world is not. Phase 7 also needed a way for the loop to _acquire_
knowledge at all — before it, `knowledge` was the one category the loop never wrote.

## Requirements

- Retrieval by meaning: a paraphrase with no term in common with a record still finds it.
- The chat model path stays untouched; embeddings are a second, separately configured model
  behind the same provider-neutral rules (ADR-003): no vendor in `src/agent/`, no secret in
  logs, one HTTP transport.
- Vectors live with the records they describe — same durability, same file, same "delete to
  forget" — and are comparable only within the model that produced them.
- Honesty: `signalsUsed`/`matchedBy` name only the stages that actually ran and contributed;
  an embedding endpoint failure degrades retrieval visibly (`degraded`), never silently.
- A record that could not be embedded is still durable and lexically retrievable.
- Knowledge acquired from the world carries its source and provenance and is treated as
  untrusted text on its way into any prompt.
- Zero paid infrastructure; no third-party dependency in `src/`.

## Options considered

| Option                                                                 | Verdict                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep keyword-only retrieval, improve tokenisation                      | Cannot bridge vocabulary: E-007b/E-009 goals and page text share no terms by construction. Rejected.                                                                     |
| A vector database (hosted or local server)                             | Paid or operationally heavy; a network dependency for a V1 whose store is one SQLite file. Deferred behind the same `SemanticIndex` seam.                                |
| `sqlite-vec` / a native extension                                      | Violates the dependency policy for core `src/`; adds a native build. Deferred.                                                                                           |
| **Vectors as BLOBs in `node:sqlite`, exact cosine in-process**         | Zero dependencies, same file as the store, exact results; brute force is bounded by the metadata stage (candidates ≤ `maxCandidates`) and is fast at V1 scale.           |
| Semantic-only retrieval                                                | Loses exact-term recall (ids, paths, tool names) and the honest "which signal" report. Rejected in favour of fusion.                                                     |
| Model-assisted ingestion (summarise fetched pages with the chat model) | Would let the model rewrite what the world said before it is stored. Deferred to Phase 8 with an explicit provenance design; V1 stores a verbatim excerpt with a source. |

## Decision

1. **`EmbeddingProvider`** (`src/models/embeddings.ts`): `embed({ texts, purpose })` →
   `Float32Array[]`, `purpose ∈ {index_memory, query_memory}`; `cosineSimilarity`.
   **`OpenAICompatibleEmbeddingProvider`** (`src/models/openai-compatible/embedding-provider.ts`)
   speaks `/embeddings`, batches, checks dimension consistency, parses strictly. The HTTP
   layer (headers, credential containment, timeout, error mapping, redaction) moved into
   **`OpenAICompatibleTransport`**, shared with the chat provider, so there is one place
   that may hold a key. Configuration is `AGENT_EMBEDDING_*` (`src/models/config.ts`) with
   **no fallback to the chat endpoint** — a missing embedding model means _no semantic
   retrieval_, not "reuse the chat model". Calls are `MODEL_CALL_*` telemetry with purposes
   `embed_memory` / `embed_query` (`InstrumentedEmbeddingProvider`).
2. **`SqliteSemanticIndex`** (`src/memory/sqlite/sqlite-semantic-index.ts`) implements
   `SemanticIndex`: one float32 vector per record id, stored with `(provider, model,
dimensions, sha256(text))`; may share the store's file. Search filters by the current
   provider+model, optionally `within` a candidate set, and ranks by exact cosine
   in-process. Unchanged text is never re-embedded; a vector from another model is never
   compared. `SEMANTIC_SCHEMA_VERSION = 1`.
3. **`IndexedMemoryStore`** (`src/memory/indexed-memory-store.ts`) decorates any
   `MemoryStore`: `put` persists first, then embeds `searchableText(record)`; an embedding
   failure is reported (`onIndexFailure`) and counted, the record stays durable;
   `backfill()` repairs. **`searchableText`** (`src/memory/searchable-text.ts`) is the one
   definition of "what a record is found by", used by the keyword and semantic stages alike.
4. **`HybridRetriever`** (`src/memory/hybrid-retriever.ts`): metadata filter through the
   store decides eligibility; keyword coverage (fraction of query terms present) and cosine
   similarity (floor `semanticThreshold`, default 0.5) add up with weights 1/1; a hit needs at
   least one positive signal and `matchedBy` lists exactly those; `signalsUsed` includes
   `semantic` only when the index answered; an index failure yields
   `degraded: [{ signal: 'semantic', reason }]` and a lexical result. Ranking is
   deterministic (score, newer first, id). **`kindDiversity` (default on)**: after ranking,
   the best hit of each memory kind is kept before remaining slots are filled by rank, then
   the selection is re-sorted by score — inclusion per kind is guaranteed, position is
   earned. See _Reason_.
5. **Knowledge ingestion** (`KnowledgeIngestor` in `src/agent/contracts.ts`;
   `ObservationKnowledgeIngestor` in `src/agent/knowledge-ingestor.ts`): rule-based, V1.
   `web.fetch` (confidence 0.5) and `fs.read` (0.4) outputs — recognised by tool name _and_
   output shape — become one `KnowledgeRecord` each with a `SourceReference` (url/path, tool,
   `retrievedAt`, `actionId`) and provenance (action, observation, plan, decision). Failed
   calls, HTTP ≥ 400, non-ingestible tools and near-empty content are never knowledge, and
   each refusal says why. The runtime ingests after the experience record and **regardless of
   the verdict** (`KNOWLEDGE_INGESTED` precedes the record's `MEMORY_WRITTEN`, carries
   source/title/size/confidence, never content). The ingestor is distinct from the Learner:
   _what the world said_ and _what the agent did_ stay separate records with separate
   confidence.
6. **Prompt boundary**: knowledge is rendered to the planner as a quoted excerpt capped at
   400 characters with its title and source, never the whole record. Ingested text is data.
7. **Architecture rules** (`tests/architecture.test.ts`): `fetch` only in
   `models/openai-compatible/transport.ts` and the sandbox HTTP client; `apiKey` handling
   only in the provider/transport files; `node:sqlite` only in the two SQLite adapters.

## Reason

The seam already existed (`SemanticIndex`, `signalsUsed`); this decision fills it with the
smallest implementation that is real, honest and dependency-free. Fusion rather than
replacement keeps exact-term recall and lets every hit say why it is there.

`kindDiversity` is the one non-obvious rule and it was forced by evidence, not taste.
E-009's first batch: for the goal _"produce a brief report file … that ends by citing what
it was based on"_, Run 1's own lesson/experience/decision records about writing the report
were phrased in the goal's words (keyword credit) and also sat closer to it in embedding
space (cosine 0.55–0.67: records _about doing_ a task embed near a goal _to do_ the task),
while the ingested style page — no shared term by design, cosine 0.5569 — ranked 6th of 6
and fell outside the retrieval limit of 5. The planner was never shown the only record that
came from the world. The four memory categories exist because they answer different
questions; a top-N over one score can silently drop a whole category, and E-007b had already
shown that the agent's own state-bound bookkeeping is the _least_ reliable memory in a fresh
sandbox. Guaranteeing inclusion per kind fixes what is kept without pretending the
similarities are different; the E-009 evidence keeps the raw cosine scan to show that.

## Tradeoffs

- Brute-force cosine over metadata-filtered candidates: exact and simple, O(candidates ×
  dimensions) per query. Fine for thousands of records; an ANN index is a later adapter
  behind `SemanticIndex`.
- Vectors are model-bound. Changing `AGENT_EMBEDDING_MODEL` makes existing vectors
  invisible (not wrong) until `backfill()` re-embeds; there is no automatic migration.
- The 0.5 floor and 1/1 weights are conservative defaults measured against one model
  (nomic-embed-text: paraphrase 0.56–0.62 vs unrelated 0.36). Other models will need
  different floors; the numbers are options, not constants.
- `kindDiversity` can promote a weak hit of a rare kind over a stronger hit of a common
  kind when the limit is tight. With fewer slots than kinds the globally best hits still
  win, so the top result is never demoted.
- V1 ingestion is verbatim and rule-based: it stores what a page said, not what it means,
  and only for two tools. Ranking, summarising and trusting content are Phase 8 questions.
- Ingested text reaches the planner's prompt as a capped quotation. That is a rendering
  convention, not a security boundary; the enforceable boundaries remain the sandbox and
  tool policy.

## Reversibility

High. Every piece sits behind an existing interface (`EmbeddingProvider`, `SemanticIndex`,
`MemoryStore`, `MemoryRetriever`, `KnowledgeIngestor`) with contract or unit coverage;
swapping the vector store, the embedding vendor or the ranking policy is a new adapter or an
option. Deleting the vector table loses nothing but the ability to search by meaning until
`backfill()`.

## Evidence / experiment

- `tests/models/embedding-provider.test.ts` — wire format, batching, dimension mismatch,
  error mapping and redaction over a fake OpenAI-compatible server; config resolution with
  no chat→embedding fallback; instrumentation purposes.
- `tests/memory/sqlite-semantic-index.test.ts` — index/search/persist/reopen, model
  isolation, hash skip, `IndexedMemoryStore` durability under embedding failure, backfill.
- `tests/memory/hybrid-retriever.test.ts` — paraphrase found where lexical finds nothing
  (fake embedding), additive signals, metadata eligibility, threshold, honest degradation,
  no-index behaviour, never-embedded records still found by keyword.
- `tests/memory/hybrid-retriever-diversity.test.ts` — deterministic reproduction of the
  E-009 crowd-out and the per-kind inclusion rule.
- `tests/agent/knowledge-ingestor.test.ts`, `tests/runtime/knowledge-ingestion.test.ts` —
  ingestion rules; loop-level ordering, provenance, counts, no content in events; prompt cap.
- **E-008** (`tests/integration/model/real-embedding.test.ts`, gated) — real
  nomic-embed-text: zero-overlap paraphrase retrieved by `semantic` alone at cosine 0.6155,
  lexical control 0 hits, unrelated record 0.359 excluded, unreachable endpoint degrades
  visibly. Results in `docs/experiments.md`.
- **E-009** (`tests/memory/e-009-knowledge-across-runs.test.ts`, gated) — two processes,
  two fresh Linux sandboxes, one SQLite file with records and vectors, real embedding
  model: a page fetched through the sandbox in Run 1 becomes knowledge, the page and the
  sandbox are destroyed, Run 2's zero-overlap goal retrieves it by meaning, the planner is
  shown it, the plan cites it. Batch 1 found the crowd-out (decision 4); batches 2–3 passed
  6/6. Results in `docs/experiments.md`.
