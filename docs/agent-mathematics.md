# Agent mathematics

This document describes mathematics that the running agent actually performs.
Tags:

- **IMPLEMENTED** — repository code computes this.
- **EXTERNAL MODEL** — a model server computes this. Our code calls it and stores the result.
- **HEURISTIC** — a fixed rule chosen by hand, not fitted to data.
- **PROPOSED/FUTURE** — not implemented. Named only so it is not confused with the code.

Nothing here trains a model, computes a gradient, or estimates whether memory improves performance.

## 1. Lexical term set — IMPLEMENTED, HEURISTIC

`lexicalTerms` in `src/memory/lexical-retriever.ts`.

\[
T(x) = \{ w \in \mathrm{split}(\mathrm{lower}(x)) : |w| \ge 3,\ w \notin \mathrm{STOP} \}
\]

`split` breaks on characters that are not letters or digits. `STOP` is a fixed English list in that file. The minimum length defaults to 3.

## 2. Keyword coverage — IMPLEMENTED

`HybridRetriever.keywordCoverage`. `st(r)` is `searchableText(record)`.

\[
k(q, r) = \frac{|T(q) \cap T(\mathrm{st}(r))|}{|T(q)|}
\]

when \(T(q)\) is non-empty, and \(0\) otherwise. Range \([0, 1]\).

`LexicalRetriever` uses the overlap **count** \(|T(q) \cap T(\mathrm{st}(r))|\) instead of the fraction. Its `ScoreBreakdown.lexical` is that count. Its `semantic` is null. The two retrievers do not share a unit.

## 3. Embedding map — EXTERNAL MODEL

\[
E : \mathrm{Text} \to \mathbb{R}^{d}
\]

`OpenAICompatibleEmbeddingProvider` sends text to an OpenAI-compatible `/embeddings` endpoint and stores the returned `Float32Array`. This repository does not implement \(E\). \(d\) is whatever the server returns on the first successful call and is then required for every later vector (`checkDimensions`). It is not a constant in our code. The verified local model `nomic-embed-text` returns \(d = 768\).

Our code does not normalise vectors. That server happens to return unit-length vectors; cosine is still computed in full so a different server still works.

`SqliteSemanticIndex` stores the bytes of the float32 vector next to the provider name, model name, dimension, and a SHA-256 of the text. A repeat index of unchanged text does not call \(E\). Search ignores rows from a different provider, model, or dimension.

## 4. Cosine similarity — IMPLEMENTED

`cosineSimilarity` in `src/models/embeddings.ts`.

\[
c(q, m) = \frac{q \cdot m}{\|q\|\,\|m\|}
= \frac{\sum_i q_i m_i}{\sqrt{\sum_i q_i^2}\,\sqrt{\sum_i m_i^2}}
\]

\(q\) is the query embedding. \(m\) is the stored embedding of `st(r)`. If either vector has length 0, the function returns 0 (the cosine is undefined; the code defines it as 0). The range is \([-1, 1]\) in exact arithmetic.

A value such as 0.6155 is the cosine of the angle between two vectors. It is not a percentage.

## 5. Semantic threshold — IMPLEMENTED, HEURISTIC

Default \(\tau = 0.5\), from `HybridRetrieverOptions.semanticThreshold`. A cosine is admitted only when \(c(r) \ge \tau\). Otherwise it contributes nothing, even if it was computed.

0.5 is an engineering default for one family of embedding models. It is not a mathematical constant. Other models need their own measurement.

## 6. Hybrid score — IMPLEMENTED, HEURISTIC

`HybridRetriever.retrieve`. Defaults \(w_k = 1\), \(w_s = 1\).

\[
S(r) = w_k\, k(r) + \mathbf{1}[c(r) \ge \tau]\, w_s\, c(r)
\]

A candidate is a hit when \(k(r) > 0\) or \(c(r) \ge \tau\). Otherwise it is counted in `unmatchedCount` and not listed. \(S(r) \in [0, 2]\) at the defaults. The keyword fraction and the cosine are different quantities added with equal weights because that was the simplest explicit rule, not because the units match.

`ScoreBreakdown` on each hit records `lexical`, `semantic`, `semanticAdmitted`, the threshold, both weights, and `combined`.

## 7. Ranking and top-k — IMPLEMENTED

Hits are ordered by `compareHits`: \(S\) descending, then `createdAt` descending, then `recordId` ascending. The runtime asks for `limit` records (default 5, `AgentRuntime`).

`rankBeforeSelection` is the 1-based place in that order. `finalRank` is the 1-based place in the list actually returned. Hits that were scored but not returned are `dropped`, with reason `below_limit` or `displaced_by_diversity`.

## 8. Kind diversity — IMPLEMENTED, HEURISTIC

`rankHits` / `selectWithKindDiversity`, on by default (`kindDiversity: true`).

When there are more scored hits than `limit`:

1. Walk the score order and keep the first hit of each memory kind until `limit` slots are used.
2. Fill any remaining slots in score order.
3. Sort the chosen set by `compareHits` again.

Scores do not change. `keptByDiversity` is true when a returned hit's `rankBeforeSelection` is greater than `limit`. A hit inside the plain top-k that was removed to make that room has drop reason `displaced_by_diversity`.

This is a quota on kinds, not a second similarity (there is no penalty for records that are similar to each other).

## 9. Memory update — IMPLEMENTED

\[
M_{\mathrm{new}} = M_{\mathrm{old}} \cup \{\text{new records}\}
\]

`MemoryStore.put` appends or replaces a record with the same id **from the same run**. A different run cannot overwrite it. There is no deletion from the agent loop, no decay, and no in-place counter update.

What gets added after an evaluated attempt (`OutcomeLearner`, `ObservationKnowledgeIngestor`, `AgentRuntime`):

- one decision record, outcome = the evaluation verdict (or `pending` before evaluation)
- one experience record, outcome = the same verdict
- zero or one knowledge record, when `web.fetch` or `fs.read` returned usable text
- one lesson record only when this attempt's verdict is `success` and an earlier attempt **of the same task** had a verdict other than `success`

`fs.read` and `fs.delete` experiences also store a precondition `{kind: 'file_exists', path}`. At the next presentation the runtime checks it against the sandbox. A violation is rendered as `PRECONDITION VIOLATED` and does not change \(S(r)\).

### Outcome semantics — IMPLEMENTED

One vocabulary, `OutcomeVerdict`: `success`, `partial`, `failure`, `inconclusive`.

| Evaluation verdict  | Experience `outcome` | Decision `outcome` |
| ------------------- | -------------------- | ------------------ |
| success             | success              | success            |
| partial             | partial              | partial            |
| failure             | failure              | failure            |
| inconclusive        | inconclusive         | inconclusive       |
| (not yet evaluated) | —                    | pending            |

`verdictAsOutcome` is the identity function. `partial` is not stored as `failure`. `inconclusive` is not stored as `failure`.

`DeterministicEvaluator` (`src/evaluation/deterministic-evaluator.ts`) decides the verdict from caller-supplied mechanical checks only:

- no decisive check → `inconclusive`
- all decisive checks passed → `success`
- none passed → `failure`
- some passed → `partial`

The raw tool status is recorded and is not decisive unless the caller added a `tool_succeeded` criterion. Prose success criteria that do not match `src/domain/criteria.ts` are reported as gaps and are neither passes nor failures. No model judge is called.

### Confidence — IMPLEMENTED as a constant, not as an update

Knowledge confidence is 0.5 (`web.fetch`) or 0.4 (`fs.read`). Lesson confidence is 0.6. Decision confidence is present only when the model reported one. None of these numbers are read by retrieval, planning, or evaluation, and none of them change after they are written. **PROPOSED/FUTURE:** any Bayesian or evidence-based update.

### Lesson validation counters — not a live update

`LessonValidation` is stored as zeros. **IMPLEMENTED** exposure counts come from events (`exposureFromEvents`): `MEMORY_RETRIEVED` (retrieved), `MEMORY_PRESENTED` (presented), `PLAN_CREATED` / `PLAN_UPDATED` cited ids (explicitly cited). **PROPOSED/FUTURE:** `timesConfirmed` and `timesContradicted`. Task success does not increment them. A citation is not a causal attribution.

## 10. Run trajectory — IMPLEMENTED

`trajectoryFromEvents` rebuilds one run from its event log:

- goal statement
- retrievals, including scores when the retriever recorded a breakdown, presented ids, and precondition violations
- cited record ids
- each selected action: tool, attempt, capped input, observation summary, verdict
- retries, strategy changes, memory writes, token counts, model latency, final status

Retrieval itself runs once, on the goal text, before planning (`AgentRuntime.retrieveMemory`). Later steps reuse that set. Records written during the run are not retrieved until a later run. **PROPOSED/FUTURE:** step-level retrieval, if an experiment shows the extra embedding calls are worth it.

`ComparableRunSpec` plus `comparisonMismatches` is the freeze-list for a later memory-on / memory-off pair (goal, criteria, limits, model id, tools, evaluator name, retrieval weights and threshold and diversity and top-k). `memory: 'off'` uses `SuppressedRetriever`, which does not read the store or call \(E\). **PROPOSED/FUTURE:** running that pair repeatedly and estimating an effect.

## What this agent does

- Calls a foundation model for plans and actions.
- Calls tools inside an execution environment.
- Stores persistent memory and appends records after attempts.
- Retrieves with the lexical set \(T\), and, when an embedding model is configured, with \(E\) and cosine.
- Ranks with \(S(r)\), top-k, and kind diversity.
- Puts the retrieved records into later model prompts, including a precondition warning when a check fails.
- Evaluates with deterministic checks when the caller supplied them.
- Keeps an event trace that reconstructs the run.

## What this agent does not do

- Train or modify foundation-model weights.
- Compute gradients or run gradient descent.
- Optimise a loss function, including \(\arg\min\) over retrieval weights.
- Statistically prove that memory improves performance.
- Causally attribute an outcome to a memory record.
- Reinforcement learning, contextual bandits, or credit assignment (Shapley or otherwise).
- Bayesian confidence updates.
- Validated autonomous self-improvement, or a Living Flame growth score.

Those are **PROPOSED/FUTURE**. They are not hidden inside the learner. The learner writes records with fixed rules.
