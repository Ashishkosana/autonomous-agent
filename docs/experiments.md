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

**Status.** Not yet runnable — requires Phases 2–7.

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
able to carry into a later run. (vi) Under the scenario harness's `maxReasks: 0`, one
invalid revision ends the run; the production default (`maxReasks: 1`) would re-ask once
with the validation message — an accepted deviation, but it means these `failed` statuses
overstate fatality relative to production configuration. (vii) The shipped `code.run`
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
