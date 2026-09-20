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

## Phase 1 contract-level evidence

Not experiments, but the tests that make later experiments meaningful:

- `tests/memory.test.ts` — given a failed approach A and a successful approach B stored
  as experience plus a derived lesson, a related query retrieves A, B and the lesson and
  a plan can cite them in `informedBy`.
- `tests/evaluation.test.ts` — a tool call that returns `ok` is evaluated as a failure
  when the artifact it produced is empty.
- `tests/provenance.test.ts` — the chain from a new lesson back to the memory record that
  informed the plan is walkable by identifiers alone.
