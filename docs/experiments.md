# Experiments

This file records behavioural experiments and their evidence. Claims about learning,
adaptation or growth must point at an experiment recorded here.

## E-001 — Cross-run learning (planned, Phase 10)

**Hypothesis.** Knowledge, experience and lessons persisted in Run #1 are retrieved in
Run #2 for a related goal and measurably change Run #2's plan or actions.

**Design.**

1. Run #1: a technical research goal. Expect research, an artifact, self-evaluation that
   finds a gap, a second iteration, and persisted knowledge/experience/decision/lesson
   records.
2. Terminate the run and the sandbox.
3. Run #2: a related goal. Expect `MEMORY_RETRIEVED` events whose `recordIds` include
   Run #1 records, and a `PLAN_CREATED` event whose `informedByRetrievalIds` /
   `informedByMemoryRecordIds` reference them.

**Evidence to capture.** Event stream of both runs; the memory records written by Run #1;
the plan of Run #2 with its `informedBy` provenance; a diff of Run #2's behaviour versus
a control run with memory disabled.

**Status.** Partially runnable after Phase 6: E-007 executes steps 1–3 with a scripted
model (retrieval and citation across processes and sandboxes proven); E-007b executed them
with a real model (retrieval and presentation proven; the model never cited memory, and the
one clearly memory-driven decision was harmful — see E-007b). The full experiment — a
research goal with real knowledge ingestion and a control run — still requires Phase 7
(semantic memory) and Phase 8 (evaluation/learning), which E-007b's findings now inform.

## E-000 — Autonomous recovery inside one run (Phase 2, passing)

**Hypothesis.** Given one goal and no further human input, the runtime detects an
inadequate result that the tool reported as successful, revises its strategy, retries
with a different action, and records what it learned — deterministically.

**Design.** `tests/runtime/autonomous-loop.test.ts`. The "model" is a scripted provider
(plan → approach A → strategy revision → approach B). The evaluator is rule-based and
inspects the artifact in a fake sandbox. The tool succeeds both times; only the evaluator
distinguishes A from B.

**Result.** 33 events (29 at Phase 2; Phase 4 added one `MODEL_CALL_STARTED` per model
call), status `completed`, 2 iterations, 1 retry, 1 strategy change, 5 memory writes
(2 decisions, 2 experiences, 1 lesson). The lesson's provenance reaches
back to the seeded knowledge record through retrieval → plan → decision → action →
observation → evaluation, verified by id. Timeline reproduced in the Phase 2 report.

**Control cases** (`tests/runtime/termination.test.ts`): a run limit stops a model that
never improves (`limit_reached`, no `GOAL_COMPLETED`, no tool call after the limit); a
model may give up (`gave_up`, reason recorded); invalid model output fails the run
(`failed`, cause `unrecoverable`); a premature `finish` claim is rejected by the evaluator.

**Caveat.** The model is scripted, so this proves the _control loop_, not model
competence. Real-model behaviour is measured from Phase 4 onward.

**Phase 4 replay over the wire** (`tests/runtime/wire-adapter-loop.test.ts`, 8 tests,
passing). The same four scripted answers are served by a real local HTTP server in the
OpenAI chat-completions format and consumed through `OpenAICompatibleProvider` instead of
the in-process scripted provider: same `completed` outcome, 2 iterations, 1 retry, 1
strategy change, 4 model calls with 400/80 tokens taken from the server's `usage`; paired
`MODEL_CALL_STARTED`/`MODEL_CALL_COMPLETED` per call; `create_plan`/`revise_plan` sent as
`response_format: json_schema`, `select_action` as function tools with
`tool_choice: required`; the API key present only in the `Authorization` header and absent
from events, memory records and the sandbox. Variants: a malformed first plan is re-asked
once (5 calls, attempts `1,2,1,1,1`, correction turn visible on the wire) and the run
still completes; a first `503` is retried with a `MODEL_CALL_FAILED` in between and the
run still completes; an exhausted re-ask budget and a `401` both end the run as `failed`
/ `unrecoverable` with redacted reasons and no tool executed. This proves the runtime is
indifferent to which `ModelProvider` implementation answers — not model competence.

## E-005 — Real code execution: exit 0 is not success (Phase 5, PASSED on a real Linux kernel)

**Hypothesis.** With the real `code.run` tool, a program that runs cleanly (exit 0, tool
result `ok`, file written) can still fail the task, and the runtime detects this from the
real artifact — not from the exit code — revises the plan and recovers, with every step
observable and correlated.

**Design.** `tests/support/e005-suite.ts`, instantiated over Linux namespaces
(`tests/tools/e-005-namespace.test.ts`, part of `npm test` on Linux) and over Docker
(`tests/integration/local/e-005-real-code.test.ts`, `npm run test:local`). Goal: _"Write a
Python program that computes the sum of the integers 1..100 and saves the result to
`/workspace/out/result.txt`; the file must contain 5050."_ The model is scripted (four
turns fixed before the run); the tools, interpreter, files and evaluator are real. Turn 2
proposes `code.run` with `sum(range(1, 100))` — an off-by-one that writes `4950` and exits 0. Turn 4 proposes the corrected `range(1, 101)`.

**Result (2026-09-20, Cursor cloud VM, namespace runtime, real python3 3.12): 6/6.**

- `completed`; usage `iterations 2, toolCalls 2, retries 1, strategyChanges 1`.
- Two `COMMAND_FINISHED` events, both `exitCode 0`, commands
  `python3 /workspace/.agent/code/act-{1,2}.py`; `COMMAND_OUTPUT` `wrote 4950` then
  `wrote 5050`; two `TOOL_COMPLETED`, zero `TOOL_FAILED`.
- `EVALUATION_COMPLETED` #1: `verdict failure, toolStatus ok, 1/2 checks` — the file
  existed but did not contain `5050`; `FAILURE_DETECTED source evaluation`;
  `STRATEGY_CHANGED`; `PLAN_UPDATED`; `RETRY_STARTED`; #2: `success, 2/2`.
- The result file really holds `5050\n`; both program sources exist as artifacts
  (`FILE_CREATED` with byte sizes) and are attached to their observations; every
  `COMMAND_*`/`FILE_*` event carries the causing `actionId`.
- Causal order asserted across 18 event positions; experiences `failure, success`; one
  lesson whose provenance reaches the evaluations.

**What this establishes.** The Phase 2 principle "tool success ≠ task success" holds with
real execution: the tool layer reported the truth (the program ran), the evaluator judged
the artifact, and the loop recovered without any exit-code heuristics. Docker-isolated
reproduction is **PENDING** on the developer machine.

## E-007 — Memory outlives the process and the sandbox (Phase 6, PASSED on a real Linux kernel)

**Hypothesis.** Records the runtime writes through the real `MemoryStore` in one OS process
are retrieved by the runtime in a _different_ OS process with a _different_ sandbox, are
shown to the planner, and can be cited by the new plan; an artifact archived from the
first sandbox is readable after that sandbox is destroyed. Nothing survives between the
runs except the SQLite file and the storage directory.

**Design.** `tests/memory/e-007-cross-process.test.ts` (parent) spawns
`tests/support/e007/child.ts` twice with `vitest run --config tests/support/e007/vitest.config.ts`
— two real child processes with their own pids. Each child opens `memory.sqlite` and
`storage/`, starts a fresh `LocalLinuxEnvironment` (namespaces runtime in the cloud VM;
Docker on the developer machine via `AGENT_LOCAL_DOCKER=1`), runs the E-000 goal with the
scripted model, the standard `fs.*` tools and `UniqueIdGenerator`, archives the report
with `archiveArtifacts`, destroys the sandbox and writes an evidence file. Run 1's script is
approach A → failure → strategy change → approach B → lesson. Run 2's script cites the
lesson id it reads from Run 1's evidence file — the planner keeps a citation only if the
record was actually presented, so a broken retrieval path fails the test instead of
passing it. The parent asserts everything only knowable across the boundary and, as a
third process, opens the same file and storage itself.

**Result (2026-09-21, cloud VM, namespace runtime; 6/6 passed; evidence
`e007-cross-process.json`).**

| Fact                                                   | Run 1 (pid 61314)                                             | Run 2 (pid 61503)                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox                                                | `e007-run1-…`, report absent at start, present at end         | `e007-run2-…`, **report absent at start** (fresh), `stopped` after destroy                                                              |
| `MEMORY_RETRIEVED`                                     | 0 hits (empty store)                                          | **5 hits — exactly Run 1's five record ids** (2 experience, 2 decision, 1 lesson)                                                       |
| Planner prompt                                         | `RELEVANT MEMORY: none retrieved`                             | contains the full lesson statement (_"…failed approach 'Write the report from known findings' (fs.write) → failure … succeeded with…"_) |
| `PLAN_CREATED.informedByMemoryRecordIds`               | `[]`                                                          | **`[<Run 1 lesson id>]`**, `informedByRetrievalIds` = the one retrieval                                                                 |
| Iterations / retries / strategy changes                | 2 / 1 / 1                                                     | 1 / 0 / 0, no `FAILURE_DETECTED`                                                                                                        |
| Records written                                        | 2 decision, 2 experience, 1 lesson                            | 1 decision, 1 experience (no contrast → no lesson, by the learner's rule)                                                               |
| Store after run (knowledge/experience/decision/lesson) | 0 / 2 / 2 / 1                                                 | 0 / 3 / 3 / 1 — Run 1's records untouched                                                                                               |
| Artifacts archived (`ARTIFACT_STORED`)                 | 2 (drafts A and B, `artifacts/<run1>/<artifactId>/report.md`) | 1; **Run 1's archived report read back in this process and contains `## Sources`**                                                      |

The parent, as a third process, counted 7 records (5 owned by Run 1's `runId`, 2 by
Run 2's), followed the lesson's provenance to Run 1's successful experience, and listed all
three archived objects. Event order in Run 2: `MEMORY_RETRIEVED` precedes `PLAN_CREATED`;
`GOAL_COMPLETED` precedes `ARTIFACT_STORED`.

**What the experiment found before it passed.** The first execution used the deterministic
test id generator in both processes. Run 2's `run-1`, `mem-1`, `mem-2` collided with Run 1's
and — because `put` is an upsert — **silently overwrote two of Run 1's records**; the store
did exactly what it was told. Two changes followed: `UniqueIdGenerator` (80-bit random ids)
for anything that reaches durable storage, and a store-level rule that a record id owned by
another run cannot be overwritten (`MemoryStoreError('conflict')`, in the contract suite).
A second finding: the scripted revision hard-coded `task-1`; with unique ids the revised
plan no longer matched the in-progress task, so the runtime treated it as a new task — no
`RETRY_STARTED`, no lesson. That is correct runtime behaviour (it mirrors the E-004
"plans expand" observation when a real model fails to echo a task id) and the script now
echoes the id it reads from the rendered plan, like a model would.

**Caveat.** The model is scripted in both runs. E-007 proves persistence, retrieval,
presentation and citation across process and sandbox boundaries — not that a model
_decides differently_ because of memory. That is E-007b.

## E-007b — A real model runs twice against one persistent memory (Phase 6, EXECUTED — evidence recorded)

**Question.** E-007 proved the plumbing with a scripted model. Does a _real_ model, shown
what a previous run remembered, plan or act differently — and if so, better?

**Design.** `tests/integration/model/real-model-memory.test.ts` (gated real-model suite,
`AGENT_E007B_PAIRS=n`). Each pair: Run 1 with an empty `memory.sqlite`, a fresh Linux
sandbox, the E-000 goal, only the `fs.*` tool family (so catalogue cost and tool confusion
stay out of the comparison), limits 4 iterations / 6 tool calls / 16 model calls; records
persisted, report archived, sandbox destroyed. Run 2: fresh sandbox, same file, same goal.
The test **asserts only the honesty of the machinery** (terminal status; model-call
telemetry balances; `GOAL_COMPLETED` iff status `completed`, and then the report really has
the marker; Run 1 retrieved nothing; Run 2 retrieved _only_ Run 1's records; a
non-empty retrieval reaches the planner prompt as `RELEVANT MEMORY (cite record ids…)`).
Whether the model cited or acted on memory is recorded as evidence, never asserted — a 3B
model ignoring what it is shown is a finding, not a failure of the store.

Setup as E-004/E-006: Ollama `qwen2.5:3b`, CPU-only cloud VM (~12 tokens/s),
`AGENT_MODEL_TOOL_MODE=json`, namespace runtime (real interpreters, no isolation).

**Batch 1 (2026-09-21, 2 pairs, 4 runs; 2/2 tests passed; evidence
`model-e007b-pair-{1,2}.json`).**

| Pair | Run | Status              | Iter | Model calls (failed) | Retrieved                             | `informedByMemoryRecordIds` | Evaluations                                           | Records written          | Lessons |
| ---- | --- | ------------------- | ---- | -------------------- | ------------------------------------- | --------------------------- | ----------------------------------------------------- | ------------------------ | ------- |
| 1    | 1   | **completed**       | 3    | 6 (1)                | 0                                     | `[]`                        | failure, success, success                             | 3 decision, 3 experience | 0       |
| 1    | 2   | limit_reached (4/4) | 4    | 5 (0)                | **5 = all of Run 1's** (3 exp, 2 dec) | `[]`                        | success, success, success, success                    | 4 decision, 4 experience | 0       |
| 2    | 1   | limit_reached (4/4) | 4    | 7 (0)                | 0                                     | `[]`                        | failure, failure, success, success                    | 4 decision, 4 experience | 0       |
| 2    | 2   | limit_reached (4/4) | 4    | 11 (1)               | **5 = all of Run 1's** (3 exp, 2 dec) | `[]`                        | failure, failure, failure, failure (4× `TOOL_FAILED`) | 4 decision, 4 experience | 0       |

Store after each pair: 0 knowledge / 8 experience (pair 1: 7) / 8 decision (pair 1: 7) / **0 lesson**.

**What the evidence shows.**

1. **The memory path works with a real model.** In both pairs Run 2's `MEMORY_RETRIEVED`
   named exactly Run 1's records and nothing else; the planner prompt carried them verbatim
   (`- [mem-…] (experience) fs.write for "…" → success`). Run 2's sandboxes were fresh
   (report absent at start). Every model-call and evaluation event balanced.
2. **The model never cited memory.** `PLAN_CREATED.informedByMemoryRecordIds` was `[]` in
   all four runs, although Run 2's prompt asked it to cite record ids it relied on. The
   scripted E-007 model cited; `qwen2.5:3b` did not.
3. **The model _did_ read memory — and it copied rather than reasoned.** Pair 2 Run 2's
   strategy is Run 1's task description nearly word-for-word ("Create the initial template
   for the /workspace/report.md file by writing the first paragraph and sourcing section"),
   and its first action was **`fs.read`** on `/workspace/report.md` in a sandbox where the
   file did not exist yet — because the retrieved experience said
   `fs.read for "Assemble sources…" → success`. That experience was true in Run 1's state
   (the file existed by then) and false in Run 2's fresh sandbox. Run 2 then failed the same
   way four times (4× `TOOL_FAILED`, 4× `FAILURE_DETECTED`, 4 strategy changes, 1 retry,
   11 model calls) and ended with **no report at all**, where Run 1 had produced a valid
   one. **Memory made this run measurably worse.** An experience record that says only
   "tool X → success" without the state that made it succeed is a hazard, not help.
4. **Pair 1 went the other way, weakly.** Run 1's first write was an empty file (evaluator:
   failure); Run 2's first write already contained `## Sources` (evaluator: success at the
   first attempt). But Run 2 then planned six tasks and hit the 4-iteration limit while
   re-writing a file that already satisfied the requirement, so Run 1 completed and Run 2 did
   not. One pair is not evidence of improvement, and the next pair contradicts it.
5. **Zero lessons in four real-model runs**, including runs with a `FAILURE_DETECTED →
STRATEGY_CHANGED → PLAN_UPDATED → … success` sequence. `OutcomeLearner` derives a lesson
   only from a contrast _on the same task_ (success after a failed attempt of that task).
   The real model, on revision, supersedes the failed task with new ones instead of echoing
   its id and retrying it (the "plans expand" finding from E-004/E-006), so the success lands
   on a different task and no contrast exists. E-004 Run 3 produced a lesson precisely
   because that run did echo the task id. The scripted E-007 model produced one because the
   script echoes ids. **With this model, per-task contrast learning almost never fires.**
6. **Cost of memory in the prompt.** Run 2's `create_plan` prompt carried five records
   (~1.1 kB); Run 2 input tokens were 5 856 vs 3 022 (pair 1) and 12 442 vs 5 236 (pair 2,
   inflated by the failures). Retrieval is ranked and capped, but nothing yet prunes records
   that are true-but-state-dependent.

**Measurement defect found and fixed during the batch.** The first-attempt marker check
originally read the _archived_ artifact — which is the file at the end of the run, i.e.
the last write, since every attempt targets the same path — so it reported `true` for a
first write that the evaluator had just failed. The test now records every tool proposal
the model made (`proposals: [{tool, hadMarker}]`) straight from the provider, and derives
the first-attempt fact from the first proposal. Batch 1's `firstAttempt.contentHadRequiredMarker`
fields are therefore unreliable; the `evaluations[0]` verdicts above are the trustworthy
signal for batch 1 (the evaluator judged the real file at the time).

**Verdict for Phase 6.** Persistence → retrieval → presentation is **PROVEN** with a real
model. Influence on a later decision is **demonstrated but not beneficial**: the only
clearly memory-driven behaviour observed (pair 2) was harmful. Cross-run _improvement_ is
**NOT claimed**. This is the first hard evidence for the Phase 8 design (evaluation + real
learning): experience records need the preconditions under which they held, retrieval
needs to weigh applicability to the _current_ state, and the learner needs a contrast
signal that survives plan expansion (goal-level, not only task-level). These are recorded
as findings, not implemented here.

## E-006 — Real model × real tools × real Linux (Phase 5, EXECUTED — evidence recorded)

**Hypothesis.** A real model, shown the nine real tool descriptors, selects and drives real
tools inside real Linux toward the E-005 goal; the machinery stays honest whatever the
model does (complete telemetry, tool events correlated to actions, no success without the
real file), and the real tool catalogue's prompt cost becomes measurable.

**Design.** `tests/integration/model/real-model-tools.test.ts` via `npm run test:model`
(`AGENT_E006_RUNS=3`). Same model setup as E-004 (Ollama `qwen2.5:3b`, CPU-only cloud VM,
`AGENT_MODEL_TOOL_MODE=json`), unchanged adapter, `createStandardToolRegistry()` (nine
tools, `web.search` absent — no provider), environment chosen by
`tests/support/real-environment.ts` (Docker when available, else namespaces). Limits:
`maxIterations 6, maxToolCalls 8, maxModelCalls 24, maxDurationMs 840 s`. Assertions:
terminal status; ≥1 answered call; `started = completed + failed`; measured latencies;
every `COMMAND_*`/`FILE_*` event has an `actionId`; `completed` ⇒ the real file contains
`5050` and the last evaluation is `success`; otherwise no evaluation may be `success`.

**Results (2026-09-20/21, namespace runtime; evidence `model-e006-run-{1,2,3}.json`).**

Batch 1 (three runs, `qwen2.5:3b`, 13–25 s per model call on CPU):

| Run | Status          | Iter | Tool calls | Model calls | Tools chosen                                                   | What really happened                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------- | ---- | ---------- | ----------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `failed`        | 1    | 1          | 4           | `code.run`                                                     | Real python3 printed `5050` and exited 0 — but never wrote the file. `EVALUATION_COMPLETED: failure, toolStatus ok, 0/1`; `FAILURE_DETECTED: result.txt has not been created`. The revision then failed validation twice (re-ask exhausted) → `GOAL_FAILED`.                                                                                                                                             |
| 2   | `failed`        | 2    | 2          | 6           | `code.run` ×2                                                  | Program 1 called `fs.write(...)` _inside Python_ (`NameError: name 'fs' is not defined`, exit 1); program 2 began with a Markdown fence (` ```python `, `SyntaxError`, exit 1). Both tool results `ok`, both evaluations `failure`. A strategy change was recorded with the placeholder reason _"The reason for the change in approach must be provided."_ Revision then invalid → `GOAL_FAILED`.        |
| 3   | `limit_reached` | 6    | 6          | 10          | `code.run` ×2, `fs.write`, `code.run`, `shell.run`, `code.run` | Programs 1–2 crashed with `FileNotFoundError` (`/workspace/out/` did not exist; the tool's scratch path did). Attempt 3 wrote `5050` **directly with `fs.write`** — the evaluator, which only inspects the file, returned `success`, and a lesson was created. The plan still had 3 more tasks (“verify”, “save”, “run”); each was evaluated `success` by the same file check until `maxIterations 6/6`. |

Measured catalogue cost (architectural observation #4 of E-004, now with real tools):
`select_action` prompts carried **1,264–1,528 input tokens** with nine tools in `json` mode
(vs. 165–586 for two test tools in E-004); `create_plan` 372 and `revise_plan` 836–1,225.
Descriptors serialise to 4,352 characters. Usage was reported by the server on every call.

**What this establishes.**

- The whole chain is real and honest: a real model chose among the real tools, real
  python3/sh ran inside real Linux, every `COMMAND_*`/`FILE_*` event carried the causing
  `actionId`, `started = completed + failed` on all 20 model calls, latencies were
  measured, and no run was declared complete without the real file. Test result: batch 1
  was 2 passed / 1 failed on a **test-design** assertion (it required "no `success`
  evaluation unless the goal completed", which is wrong when a task succeeds and the run
  later hits a limit); the assertion was corrected to "no `GOAL_COMPLETED` unless
  completed" and the batch re-run (below).
- **Evaluation gap (Phase 8 evidence).** Run 3 satisfied the artifact check by writing the
  answer directly instead of computing it with a program, and later tasks with different
  descriptions were judged by the same file check. The rule evaluator verifies the
  artifact, not the _process_ the goal asked for, and is not task-aware. This is the
  strongest evidence so far for Phase 8's evaluator design: checks must be derived from
  the task's `expectedEvidence` (e.g. a program artifact whose execution produced the
  file), not one static artifact requirement per run.
- **Model-behaviour observations (not acted on).** (i) 3B models blur the boundary between
  tools and language — calling `fs.write` from Python, wrapping source in Markdown fences,
  escaping newlines as literal `\n` in JSON strings — producing exit-1 programs that the
  tools report faithfully. (ii) Programs assume parent directories exist; the tool
  deliberately does not pre-create `out/` for them. (iii) Plan revisions still fail
  validation often (missing `changeReason` when `strategyChanged`), and when they pass,
  `changeReason` is sometimes a placeholder that echoes the instruction. (iv) The model
  adds tasks such as "verify the output" that the current evaluator cannot distinguish
  from the main task. Whether `code.run` should strip Markdown fences, whether the planner
  should re-ask with the specific validation error, and how revisions may add tasks are
  Phase 8 decisions to be made with this evidence — not tool-level accommodations for one
  model.

Batch 2 (three more runs after the assertion fix, same model and configuration, 2026-09-21;
**3 passed / 0 failed** — every run reached a terminal status with consistent telemetry,
15 = 15 + 0, 6 = 6 + 0 and 4 = 4 + 0 model calls; 11–29 s per call):

| Run | Status          | Iter | Tool calls | Model calls | Tools chosen  | What really happened                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------- | ---- | ---------- | ----------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `failed`        | 1    | 1          | 4           | `shell.run`   | The model wrote its _expected output into the command_: `python -c "print(sum(range(1, 101)))" \| stdout: The sum is 5050` → `sh: python: not found`, `sh: stdout:: not found`, exit 127 (only `python3` exists). Evaluation `failure`; the revision was invalid (`changeReason` missing) → `GOAL_FAILED`.                                                                                                                                                              |
| 2   | `limit_reached` | 6    | 6          | 15          | `code.run` ×6 | Six Python programs, six revisions — **every revision diagnosed the same cause** ("the output file/directory is not ensured") and every program still crashed with `FileNotFoundError: /workspace/out/result.txt` (the directory was never created), or called `fs.write`/`fs.exists` from Python (`NameError`), or was written on one line (`SyntaxError`). Program 4 exited 0 yet the evaluator still found no file. 6 strategy changes, 12 memory writes, no lesson. |
| 3   | `failed`        | 2    | 2          | 6           | `code.run` ×2 | Both programs `FileNotFoundError` on the missing `out/` directory. The one revision that passed validation carried the meta-reason _"Corrected the issue with changeReason being empty when strategyChanged is true"_ — the model repaired the schema error, not the approach; the next revision failed validation → `GOAL_FAILED`.                                                                                                                                     |

Catalogue cost in batch 2 was consistent with batch 1: `select_action` 1,229–1,328 input
tokens, `create_plan` 372, `revise_plan` 801–1,363. Across both batches: **6 runs, 1 goal
reached** (batch 1 run 3, by writing the answer directly rather than computing it).

Additional observations from batch 2 (evidence for Phase 8, not acted on): (v) the
dominant real-world failure was environmental — a missing parent directory — which the
model diagnosed correctly six times in words and never fixed in code; a lesson-shaped
memory ("create the directory before writing") is exactly what Phase 6/8 memory should be
able to carry into a later run. (vi) E-006 runs with the production recovery settings
(`maxRetries 2, maxReasks 1`): each `failed` status above means the revision was invalid
_twice_ — the original answer and the re-ask that quoted the validation error back to the
model. The model call counts show it (run 1: plan, select, revise, re-asked revise = 4).
(vii) The shipped `code.run`
descriptor names `python3`; the model still typed `python` when it reached for `shell.run`.

## E-004 — Real model drives the loop (Phase 4, EXECUTED against a real local model — reviewed)

**Hypothesis.** A real language model, reached through the vendor-neutral adapter, answers
in valid structured form often enough to plan, select tool actions and drive the E-000 goal
to a terminal status within limits, with complete per-attempt telemetry and no credential
leakage.

**Design.** `tests/integration/model/real-model.test.ts` via `npm run test:model`, gated on
`AGENT_MODEL_*` configuration (skipped in plain `npm test`; fails instead of skipping under
`AGENT_REQUIRE_REAL_MODEL=1`). Three smoke tests (text, structured output, tool action for
a concrete file-writing task) and one loop run with `maxIterations 4`, `maxModelCalls 12`.
Assertions are about form and telemetry integrity — terminal status, at least one call
_answered_ by the model, `started = completed + failed`, provider/model labels on every
event, key absent from events/memory/sandbox — not about the model completing the goal,
which is recorded as evidence (`goalCompleted`, `reportHasRequiredSection`).

**Setup (2026-09-20).** Ollama 0.34.2 installed into `/tmp` on the Cursor cloud VM
(4 vCPU, no GPU, ~6 GB free RAM), bound to `127.0.0.1:11434`, models pulled from the
public registry. Nothing Ollama-specific was added to the runtime: the endpoint is reached
through `OpenAICompatibleProvider` with `AGENT_MODEL_PROVIDER=openai-compatible`,
`AGENT_MODEL_BASE_URL=http://127.0.0.1:11434/v1`, no API key. Verified path:
`AgentRuntime → ModelProvider → ResilientModelProvider → InstrumentedModelProvider →
OpenAICompatibleProvider → fetch → Ollama → qwen2.5:3b → structured JSON → planner /
selector → FakeExecutionEnvironment → ArtifactRequirementEvaluator → learner → memory`.
Evidence files are outside the repository (`/tmp/agent-evidence-e004-run*`).

**Compatibility findings (exact evidence, before any code change).**

| Probe / run                         | Config                       | Result                                                                                                                                                                           |
| ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| raw `/v1/chat/completions`, text    | —                            | `pong`, `usage` reported (37/2 tokens)                                                                                                                                           |
| raw, `response_format: json_schema` | —                            | valid `{"colours":[…]}`; Ollama enforces the schema by grammar                                                                                                                   |
| raw, function tools + `required`    | —                            | tool call returned but **flattened**: `{"path","content"}` instead of `{"input":{…},"rationale":…}`                                                                              |
| run 1 (`npm run test:model`)        | defaults (`tools`)           | plan created via `json_schema` (real `PLAN_CREATED`); both `select_action` attempts `invalid_response` (`rationale must be a non-empty string; input is required`); run `failed` |
| wire capture, `tools`               | defaults                     | 74 completion tokens, `content: ""`, no `tool_calls`, `finish_reason: stop` — Ollama's tool parser dropped a malformed call                                                      |
| run 2                               | `AGENT_MODEL_TOOL_MODE=json` | model returned `{"kind":"tool","toolName":"fs.write","input":{exact required content}}` **without `rationale`**; rejected twice; run `failed`                                    |

Root cause of run 2 was on our side: `toolActionProposalSchema` declared only `kind` as
`required`, while the parser requires `rationale`; a grammar-enforcing server legitimately
lets the model stop early. Fixed in commit `9808352` (schema now requires `kind` and
`rationale`; unit test added). The `tools`-mode flattening is model-side: two different 3B
models (qwen2.5:3b, llama3.2:3b) both place the tool's fields at the top level and drop the
wrapper. No code was changed for it; it is recorded under architectural concerns.

**Results after the schema fix — `qwen2.5:3b`, `AGENT_MODEL_TOOL_MODE=json`** (three
consecutive full runs of `npm run test:model`; every run **4 passed / 0 failed / 0 skipped,
exit 0**, i.e. text, structured output, a valid `fs.write` proposal with rationale, and a
terminal loop with consistent telemetry):

| Run | Status          | Iter | Model calls (started = completed + failed) | Tool calls | Evaluations (verdicts)             | Strategy changes | Lesson | Report has `## Sources` | Duration |
| --- | --------------- | ---- | ------------------------------------------ | ---------- | ---------------------------------- | ---------------- | ------ | ----------------------- | -------- |
| 3   | **`completed`** | 3    | 5 = 5 + 0                                  | 3          | failure → success → success        | 1                | 1      | yes                     | 76 s     |
| 4   | `limit_reached` | 4    | 7 = 7 + 0                                  | 4          | failure, success, failure, success | 2                | 0      | yes                     | 127 s    |
| 5   | `limit_reached` | 4    | 8 = 8 + 0                                  | 4          | failure, success, failure, success | 2                | 0      | yes                     | 127 s    |

Run 3 is the first fully autonomous real-model completion: the model's first `fs.write`
failed (tool error), the runtime emitted `FAILURE_DETECTED`, the model revised the plan
with a changed strategy, `RETRY_STARTED` → `TOOL_COMPLETED` → evaluation `success`, a
`LessonRecord` was derived from the failure→success contrast, and the remaining task
completed → `GOAL_COMPLETED`. Event sequence:

```
GOAL_RECEIVED, MEMORY_SEARCH_STARTED, MEMORY_RETRIEVED, MODEL_CALL_STARTED, MODEL_CALL_COMPLETED,
PLAN_CREATED, MODEL_CALL_STARTED, MODEL_CALL_COMPLETED, DECISION_CREATED, TOOL_SELECTED, TOOL_STARTED,
TOOL_FAILED, EVALUATION_COMPLETED, MEMORY_WRITTEN×2, FAILURE_DETECTED, MODEL_CALL_STARTED,
MODEL_CALL_COMPLETED, STRATEGY_CHANGED, PLAN_UPDATED, MODEL_CALL_STARTED, MODEL_CALL_COMPLETED,
DECISION_CREATED, RETRY_STARTED, TOOL_SELECTED, TOOL_STARTED, TOOL_COMPLETED, EVALUATION_COMPLETED,
MEMORY_WRITTEN×2, LESSON_CREATED, MEMORY_WRITTEN, MODEL_CALL_STARTED, MODEL_CALL_COMPLETED,
DECISION_CREATED, TOOL_SELECTED, TOOL_STARTED, TOOL_COMPLETED, EVALUATION_COMPLETED, MEMORY_WRITTEN×2,
GOAL_COMPLETED
```

Runs 4 and 5 wrote a valid report (evaluation `success` twice each) but ended at
`maxIterations 4`: on every revision the 3B model **added new tasks** (task-5, -6, -8 …)
instead of retrying or finishing, so the plan never had all tasks complete. Per-call
latency on CPU: 7–20 s (real `SystemClock`). Token usage 2.2k–4.0k input per run for a
2-tool catalogue.

**Comparison model — `llama3.2:3b`.** `tools` mode: same flattening → `failed` after the
re-ask. `json` mode: valid structured plans, 4 strategy changes, but chose `echo` on all
four attempts and once omitted `toolName`; `limit_reached`, no report. Runtime behaviour
was correct throughout (no crash, `started = completed + failed`, retries and strategy
changes recorded); the model was not competent enough for the goal.

**What this experiment establishes.** With a real local LLM over real HTTP, the runtime
plans, selects validated tool actions, executes, evaluates, detects failure, changes
strategy, retries, learns and completes — with zero code paths specific to the model or
to Ollama, using the shipped `AGENT_MODEL_TOOL_MODE` configuration. It also establishes
that a 3B model is at the edge of competence for this goal (1 completion in 3 runs) and
that `tools` mode is unusable with the current wrapper on small models. It was executed on
the Cursor cloud VM, not the developer machine; the same commands reproduce it there
(Ollama for Windows/WSL, `ollama pull qwen2.5:3b`, then the env vars above and
`npm run test:model`).

**Architectural observations for later phases (not acted on).**

1. `tools`-mode wrapper (`{input, rationale}`) is flattened by small models. Options for
   Phase 5/8, to be chosen with more model evidence: accept top-level arguments that match
   the tool's schema as `input` and take `rationale` from assistant text or a follow-up;
   or make `json` mode the default for small models. Not changed now.
2. The JSON-mode proposal schema is a flat union (`toolName`, `summary`, `reason` all
   optional); grammar-enforcing servers therefore cannot force `toolName` for
   `kind: "tool"`. A discriminated `anyOf` would be stricter if the servers we target
   support it.
3. Plan-revision discipline: small models grow the task list on every revision; the
   runtime honours that faithfully and the iteration limit ends the run. Phase 8 should
   consider whether revisions may add tasks freely.
4. Tool-catalogue size: every `select_action` carries every tool's schema (already 165–586
   prompt tokens for 2 tools depending on mode). Phase 5 will show the real catalogue size
   before any retrieval/filtering is designed.

## E-003 — Autonomous recovery in a real local Linux sandbox (Phase 3B, PASSED on the developer machine)

**Hypothesis.** E-000 reproduces unchanged when `FakeExecutionEnvironment` is replaced by
`LocalLinuxEnvironment` (ADR-002) talking to a disposable Docker container: same scripted
model, same rule evaluator, same `AgentRuntime`, same event sequence — but the file is
really written inside isolated Linux by the non-root `agent` user and really inspected
there, and the second, corrected action is chosen by the runtime, not by a human.

**Design.** `tests/integration/local/e-003-autonomous-loop.test.ts`, run by
`npm run test:local` (fails, never skips, without Docker). Asserts: status `completed`,
usage `{iterations: 2, toolCalls: 2, retries: 1, strategyChanges: 1}`; two `TOOL_COMPLETED`
and zero `TOOL_FAILED`; verdicts `['failure', 'success']` with `FAILURE_DETECTED.source ===
'evaluation'`; the artifact read back from the container equals approach B and
`stat -c %U` reports `agent`; the E-000 causal order `GOAL_RECEIVED → MEMORY_RETRIEVED →
PLAN_CREATED → TOOL_SELECTED → TOOL_STARTED → TOOL_COMPLETED → EVALUATION_COMPLETED →
FAILURE_DETECTED → STRATEGY_CHANGED → PLAN_UPDATED → RETRY_STARTED → TOOL_SELECTED →
TOOL_STARTED → TOOL_COMPLETED → EVALUATION_COMPLETED → LESSON_CREATED → GOAL_COMPLETED`
with contiguous sequence numbers; 2 decisions, 2 experiences, 1 lesson whose provenance
reaches the seeded knowledge record.

**No-human-in-the-loop proof.** All scripted turns are fixed before `run()` is called; the
test timestamps every `requestToolAction` call and asserts both happened between the start
and return of `run()`, and that `FAILURE_DETECTED`, `PLAN_UPDATED` and `RETRY_STARTED`
(runtime-sourced events) precede the second `TOOL_SELECTED`.

**Companion suites (same run).** `execution.test.ts` TEST 1–9 (command, filesystem,
Python, Node, failure, timeout, background process, outbound network, isolation evidence);
`contract.test.ts` (shared contract suite); `lifecycle.test.ts` (start → use → stop →
destroy → recreate freshness, two-sandbox isolation, `docker inspect` of limits and
security options). Raw outputs go to `AGENT_SANDBOX_EVIDENCE_DIR` (default
`<tmp>/agent-sandbox-evidence`), summarised by `scripts/test-local.mjs`.

**Result (2026-09-20, developer machine).** `npm run test:local` executed on the
developer's actual Windows 11 + WSL2 + Docker Desktop environment against
`agent-sandbox-local:0.1.0`:

```
25 passed
0 failed
0 skipped
Exit code 0
```

The 25 tests are the four Docker-gated suites in `tests/integration/local/`:
`execution.test.ts` (9 — TEST 1–9), `contract.test.ts` (6 — shared contract suite),
`e-003-autonomous-loop.test.ts` (6 — this experiment) and `lifecycle.test.ts` (4). Every
assertion listed under **Design** above therefore held on a real disposable container:
the runtime detected the inadequate artifact, changed strategy, retried with the corrected
approach and completed, with the file really written by the non-root `agent` user inside
isolated Linux and no human choosing the second action. `LocalLinuxEnvironment` is the
**verified V1 execution environment**. The Cursor cloud VM that authored the code has no
Docker engine (by decision), so the evidence comes from the developer machine, reported
by the project owner; raw JSON evidence lives in that machine's
`AGENT_SANDBOX_EVIDENCE_DIR`, outside the repository.

Independently, `tests/sandbox/local-linux-namespace.test.ts` (12 tests, passing in the
cloud VM) exercised the adapter's shell scripts on a real Linux kernel under
`unshare -Urm` before the Docker run; that found and fixed two real bugs (dash rejects
`kill -TERM -- -pgid`; `pgrep -f` matched its own command line) that no fake could have
found. It is script validation, not isolation evidence — the isolation evidence is the
Docker run above.

## E-002 — Autonomous recovery in a real Cloudflare sandbox (Phase 3, DEFERRED — requires Workers Paid)

**Hypothesis.** E-000 reproduces unchanged when `FakeExecutionEnvironment` is replaced
by `CloudflareSandboxEnvironment` talking to a real Cloudflare sandbox: same scripted
model, same rule evaluator, same event sequence — but the file is really written and
really inspected inside isolated Linux.

**Design.** `tests/integration/cloudflare/autonomous-loop.test.ts`. Asserts status
`completed`, 2 iterations, the `TASK_FAILED → PLAN_REVISED → … → GOAL_COMPLETED` order,
`descriptor.provider === 'cloudflare-sandbox'` on the environment, and that the final
file content is readable back from the sandbox itself. The companion suites
`execution-boundary.test.ts` (TEST 1–7: command, filesystem, code, failure, processes,
network, isolation evidence), `contract.test.ts` (shared contract suite) and
`lifecycle.test.ts` (reuse, isolation between ids, destroy, optional idle-stop
observation) record their raw outputs to `AGENT_SANDBOX_EVIDENCE_DIR`.

**Result.** Not run — **DEFERRED — requires Workers Paid** (owner decision 2026-09-20;
not a failure). The suites skip with `Cloudflare integration NOT RUN — missing
environment variables …` and fail hard under `AGENT_REQUIRE_CLOUDFLARE=1`
(`npm run test:cloudflare`). The code and tests remain in place for activation; E-003 is
the local equivalent. Nothing in this repository claims Cloudflare has been exercised.

## Phase 1 contract-level evidence

Not experiments, but the tests that make later experiments meaningful:

- `tests/memory.test.ts` — given a failed approach A and a successful approach B stored
  as experience plus a derived lesson, a related query retrieves A, B and the lesson and
  a plan can cite them in `informedBy`.
- `tests/evaluation.test.ts` — a tool call that returns `ok` is evaluated as a failure
  when the artifact it produced is empty.
- `tests/provenance.test.ts` — the chain from a new lesson back to the memory record that
  informed the plan is walkable by identifiers alone.
