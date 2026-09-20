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

**Result.** 29 events, status `completed`, 2 iterations, 1 retry, 1 strategy change,
5 memory writes (2 decisions, 2 experiences, 1 lesson). The lesson's provenance reaches
back to the seeded knowledge record through retrieval → plan → decision → action →
observation → evaluation, verified by id. Timeline reproduced in the Phase 2 report.

**Control cases** (`tests/runtime/termination.test.ts`): a run limit stops a model that
never improves (`limit_reached`, no `GOAL_COMPLETED`, no tool call after the limit); a
model may give up (`gave_up`, reason recorded); invalid model output fails the run
(`failed`, cause `unrecoverable`); a premature `finish` claim is rejected by the evaluator.

**Caveat.** The model is scripted, so this proves the _control loop_, not model
competence. Real-model behaviour is measured from Phase 4 onward.

## E-002 — Autonomous recovery in a real Cloudflare sandbox (Phase 3, NOT YET RUN)

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

**Result.** Not run. The suites skip with `Cloudflare integration NOT RUN — missing
environment variables …` and fail hard under `AGENT_REQUIRE_CLOUDFLARE=1`
(`npm run test:cloudflare`). Blocked on user-controlled prerequisites listed in ADR-001
("Prerequisites for real execution"). Results will be appended here and in ADR-001 once
they exist; until then, nothing in this repository claims Cloudflare has been exercised.

## Phase 1 contract-level evidence

Not experiments, but the tests that make later experiments meaningful:

- `tests/memory.test.ts` — given a failed approach A and a successful approach B stored
  as experience plus a derived lesson, a related query retrieves A, B and the lesson and
  a plan can cite them in `informedBy`.
- `tests/evaluation.test.ts` — a tool call that returns `ok` is evaluated as a failure
  when the artifact it produced is empty.
- `tests/provenance.test.ts` — the chain from a new lesson back to the memory record that
  informed the plan is walkable by identifiers alone.
