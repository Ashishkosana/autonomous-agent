# Architecture

This document describes the V1 architecture of the observable autonomous learning agent
and the current state of each layer. It is a living document; ADRs in `docs/adr/` record
the decisions that shaped it.

## 1. Concepts and where they live

| Concept                   | Responsibility                                      | Location                | Status after Phase 2                                    |
| ------------------------- | --------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| **Intelligence**          | Proposes plans, actions, judgements, lessons        | `src/models/`           | Contract + instrumentation decorator; provider OPEN     |
| **Capability**            | What the agent can do to the world                  | `src/tools/`            | Contract + registry; real tools in Phase 5              |
| **Autonomy**              | The loop that keeps acting without a human          | `src/agent/runtime/`    | Implemented and tested against test adapters            |
| **Memory**                | What the agent knows, experienced, decided, learned | `src/memory/`           | Records, working memory impl, store/retrieval contracts |
| **Evaluation**            | Whether a task actually progressed                  | `src/evaluation/`       | Contract; strategy OPEN                                 |
| **Learning**              | Turning evaluated outcomes into persistent lessons  | `src/agent/learner.ts`  | Rule-based `OutcomeLearner`                             |
| **Execution environment** | Where actions physically run                        | `src/sandbox/`          | Contract; Cloudflare adapter built, real run pending    |
| **Persistent storage**    | Artifacts and objects that outlive a sandbox        | `src/storage/`          | Contract; backend OPEN (R2 candidate)                   |
| **Observability**         | Structured events describing every meaningful step  | `src/events/`           | Schema + factory + sink/source contract                 |
| **Visual growth**         | Living Flame driven by telemetry                    | `ui/` (not yet created) | Phase 9                                                 |

These are deliberately separate modules. Nothing collapses them into one `Agent` class:
`AgentRuntime` orchestrates them through their interfaces and owns nothing else.

## 2. The runtime loop (implemented in Phase 2)

`src/agent/runtime/agent-runtime.ts`:

```
receive goal                            → GOAL_RECEIVED
retrieve relevant memory                → MEMORY_SEARCH_STARTED / MEMORY_RETRIEVED
create plan                             → PLAN_CREATED
loop:
    stop if any RunLimit is reached     → RUN_LIMIT_REACHED            (status limit_reached)
    pick next task; none left → done    → GOAL_COMPLETED               (status completed)
    ask selector for next step
        give_up                         → GOAL_FAILED cause=gave_up    (status gave_up)
        finish → goal-level evaluation  → EVALUATION_COMPLETED, then completed or failure path
        act:                            → DECISION_CREATED, [RETRY_STARTED], TOOL_SELECTED
            execute                     → TOOL_STARTED, TOOL_COMPLETED | TOOL_FAILED
            evaluate                    → EVALUATION_COMPLETED
            learn + write memory        → MEMORY_WRITTEN (decision, experience), [LESSON_CREATED, MEMORY_WRITTEN]
            success → mark task complete
            failure                     → FAILURE_DETECTED
                planner revises         → [STRATEGY_CHANGED], PLAN_UPDATED
                (next iteration retries the same task under the revised plan)
unrecoverable error anywhere            → GOAL_FAILED cause=unrecoverable (status failed)
```

Model calls made by any component additionally emit `MODEL_CALL_COMPLETED` via
`InstrumentedModelProvider`.

### Runtime components

| Component                   | File                                  | Responsibility                                                                                                     |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AgentRuntime`              | `src/agent/runtime/agent-runtime.ts`  | The loop above. Owns orchestration, task selection, termination, memory writes and all runtime-level events.       |
| `RunSession`                | `src/agent/runtime/run-session.ts`    | Per-run ids, clock, goal, event factory + sink, usage tracker, working memory, run state. No orchestration.        |
| `RunUsageTracker`           | `src/agent/runtime/run-usage.ts`      | `RunUsage` counters and `breach()` — the first `RunLimit` reached.                                                 |
| `plan-tasks.ts`             | `src/agent/runtime/plan-tasks.ts`     | Pure helpers: next runnable task, status updates.                                                                  |
| `createAutonomousRun`       | `src/agent/runtime/create-run.ts`     | Composition root: wires defaults around caller-supplied model, tools, environment, evaluator, store and retriever. |
| `ModelPlanner`              | `src/agent/planner.ts`                | Structured plan / revision requests to the model; validates output; builds `Plan` with honest `informedBy`.        |
| `ModelActionSelector`       | `src/agent/action-selector.ts`        | Tool-action request to the model; turns the proposal into `Action` + `DecisionRecord`, or finish / give up.        |
| `ToolExecutor`              | `src/agent/executor.ts`               | Runs one `Action` through the registry against the environment; emits tool events; returns an `Observation`.       |
| `OutcomeLearner`            | `src/agent/learner.ts`                | Rule-based: one `ExperienceRecord` per attempt; a `LessonRecord` only from a failure → success contrast.           |
| `InstrumentedModelProvider` | `src/models/instrumented-provider.ts` | Decorates any `ModelProvider` to report a `ModelCallRecord` per call.                                              |
| `RunWorkingMemory`          | `src/memory/working.ts`               | Process-local working memory for the run.                                                                          |

### Termination conditions (exhaustive)

| Condition                                                      | Event                                 | `RunStatus`     |
| -------------------------------------------------------------- | ------------------------------------- | --------------- |
| Every plan task is `completed` or `skipped`                    | `GOAL_COMPLETED`                      | `completed`     |
| A `finish` claim passes goal-level evaluation                  | `GOAL_COMPLETED`                      | `completed`     |
| Selector returns `give_up`                                     | `GOAL_FAILED` (cause `gave_up`)       | `gave_up`       |
| Any `RunLimit` reached, checked at the head of every iteration | `RUN_LIMIT_REACHED`                   | `limit_reached` |
| Planner/selector/evaluator throws (e.g. invalid model output)  | `GOAL_FAILED` (cause `unrecoverable`) | `failed`        |

There is no other way out of the loop; every iteration either terminates or consumes an
iteration count, so the `maxIterations` limit bounds the run unconditionally.

### Trust boundaries inside the loop

- The model **proposes** plans, revisions and tool calls. It never executes anything and
  never decides success: a `finish` proposal is checked by the evaluator.
- The evaluator judges from evidence (artifact inspection, command checks, rules). Its
  verdict, not `ToolResult.status`, drives task completion and failure handling.
- The runtime **decides** whether to continue, retry or stop, and it alone writes memory.

## 3. Data flow for one action

```
ModelProvider.requestToolAction(ToolDescriptor[])       ← model sees schemas, not code
        ↓ ToolActionProposal { toolName, input, rationale }
Runtime builds Action { actionId, planId, decisionId?, derivedFrom }
        ↓
invokeTool(registry, name, input, ToolContext)          ← validates input, times, wraps
        ↓ Tool.execute(input, context)                   ← touches only context.environment
ExecutionEnvironment (sandbox)
        ↓ ToolResult { status: ok | error, ... }         ← "the call completed" only
Observation { observationId, actionId, toolResult, artifacts }
        ↓
Evaluator.evaluate(scope)                                ← may inspect the environment
        ↓ EvaluationResult { verdict, checks[], gaps[], toolStatus, derivedFrom }
Learner.learn(action, observation, evaluation)
        ↓ ExperienceRecord + LessonRecord[]              ← written to MemoryStore
```

`ToolResult.status` and `EvaluationResult.verdict` are distinct fields on distinct records
on purpose. `EvaluationResult.toolStatus` copies the tool status so "tool ok, task failed"
is visible in the data.

## 4. Provenance model

Every derived record carries a `Provenance` (`src/domain/provenance.ts`): optional lists of
`retrievalIds`, `memoryRecordIds`, `planIds`, `decisionIds`, `actionIds`,
`observationIds`, `evaluationIds`, `lessonIds`. Combined with the entity's own id and its
`RunCorrelation { runId, goalId, taskId? }`, this lets us walk:

```
retrieved memory record
   → RetrievalResult.retrievalId
      → Plan.informedBy / DecisionRecord.provenance
         → Action.planId / Action.decisionId
            → Observation.actionId
               → EvaluationResult.derivedFrom
                  → LessonRecord.provenance
```

`tests/provenance.test.ts` constructs the whole chain by hand and walks it in both
directions; `tests/runtime/autonomous-loop.test.ts` does the same against records the
runtime actually wrote. This is what lets the dashboard say, truthfully, "this plan used
experience from run N" and "this lesson came from this failure".

### How provenance travels through the runtime

Links are recorded only where the relationship really occurred:

| Record             | Field                                                     | Set from                                                                                                 |
| ------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Plan`             | `informedBy.retrievalIds`                                 | Retrievals that returned ≥ 1 hit and were rendered into the planning prompt                              |
| `Plan`             | `informedBy.memoryRecordIds`                              | Record ids the model cited **∩** records actually presented (fabricated ids are dropped)                 |
| `Plan` (revision)  | `informedBy.planIds / evaluationIds`                      | The plan it replaces and the evaluation(s) that triggered revision                                       |
| `DecisionRecord`   | `provenance`, `evidence`                                  | Plan id; presented retrievals/records; previous attempts' action + evaluation ids for this task          |
| `Action`           | `planId`, `decisionId`, `retryOf`, `derivedFrom`          | The plan/decision that produced it; the action it retries                                                |
| `Observation`      | `actionId`                                                | The executed action                                                                                      |
| `EvaluationResult` | `derivedFrom`                                             | Observation ids inspected and the action judged (evaluator-supplied)                                     |
| `ExperienceRecord` | `actionId`, `observationId`, `evaluationId`, `provenance` | The attempt, plus the decision's provenance                                                              |
| `LessonRecord`     | `provenance`                                              | Union of every attempt's action/observation/evaluation/decision/plan ids and the decisions' memory links |

Events carry the same ids in `EventCorrelation`. `MEMORY_RETRIEVED.recordIds`,
`PLAN_CREATED.informedBy*`, `RETRY_STARTED.retryOfActionId` and
`LESSON_CREATED.derivedFromEvaluationIds` make the chain reconstructable from the stream
alone, and the live stream and the stored records can be joined without a separate index.

## 5. Memory

Four logical categories are locked:

- **Working** — run-scoped scratchpad (`src/memory/working.ts`). Not persisted by default.
- **Knowledge** — things learned from the world, with `SourceReference[]`.
- **Experience** — what happened when the agent acted, incl. `outcome`, `attempt`,
  `retryOf`, `changedApproach`.
- **Decision** — why a choice was made: options, evidence, reason, confidence, outcome.

**Lessons are not a fifth category.** `LessonRecord` is a _derived persistent learning
record_: the output of the learning step, not a place where raw experience is stored. It
is persisted as record kind `lesson` purely so it can be stored, indexed and retrieved
through the same `MemoryStore`/`MemoryRetriever` machinery, and it exists only by virtue
of the records it links to — knowledge, experience, decisions, evaluations, observations,
actions, strategies and retrievals — via its `provenance`. The logical memory model
remains exactly four categories: working, knowledge, experience, decision. The
`PersistentMemoryKind` enumeration is a storage-level discriminator and should not be
read as the category list.

Lesson records carry `LessonValidation` counters (retrieved / applied / confirmed /
contradicted). These are raw inputs for a future growth formula, not a growth formula.

Retrieval (`src/memory/retrieval.ts`) returns a small ranked set and records
`signalsUsed` and per-hit `matchedBy` so the UI can never claim a stage that did not run.
`SemanticIndex` is the seam where an embedding/vector implementation plugs in.

## 6. Execution environment boundary

`ExecutionEnvironment` (`src/sandbox/execution-environment.ts`) is the only way tools
touch the world: commands, files, processes, state. It imports nothing. Provider
identity is data (`descriptor.provider`), not a type. `CloudflareSandboxEnvironment`
(`src/sandbox/cloudflare/`) implements it; a `LocalLinuxEnvironment` can follow without
touching the runtime.

The Cloudflare adapter is layered so the vendor SDK stays out of `src/` entirely:

```
CloudflareSandboxEnvironment      contract → Cloudflare semantics (stdin staging, timeout
        │                          wrapping, mkdir-before-write, error mapping)
        ▼
SandboxClient (port)              the SDK subset we use, as a plain interface
   ├── HttpSandboxClient          Node side: authenticated JSON over HTTPS (protocol.ts)
   │        ▼
   │   worker/src/gateway.ts      routing, bearer auth (fails closed), validation
   │        ▼
   └── SdkSandboxClient           worker/src — the ONLY file that calls @cloudflare/sandbox
            ▼
       Cloudflare Sandbox         Durable Object → container → isolated Linux
```

The gateway exists because the Sandbox SDK runs only inside a Worker (ADR-001). Whether
the runtime itself eventually runs inside that Worker or stays on a separate host is an
open topology question; both fit behind `SandboxClient`.

`tests/support/execution-environment-contract.ts` exports a contract suite that every
implementation must pass. It runs against the test fake, against the Cloudflare adapter
over a fake sandbox client, over the full HTTP chain in-process, and — when credentials
are present — against a real Cloudflare sandbox (`tests/integration/cloudflare/`).

## 7. Events

`AgentEvent` envelope: `schemaVersion`, `eventId`, per-run monotonic `sequence`,
`timestamp`, `runId`, `goalId?`, `type`, `correlation`, `payload`. Payload shapes are
declared per event type and checked at compile time to be exhaustive. Transport is OPEN;
`EventSink` / `EventSource` are the seams. Payloads contain observable facts and concise
human-facing summaries only — never raw model chain-of-thought.

## 8. Decisions

### Locked (V1 baseline)

Autonomous loop · Cloudflare hosting · Cloudflare Sandbox execution · isolated Linux with
full shell · Internet + discovery/search · browser automation · filesystem · code
execution · Git · GitHub integration · persistent cross-run memory · four memory
categories · semantic retrieval requirement · structured events · real-time observability
· Living Flame · TypeScript implementation language.

### Open (must be discussed before choosing)

| Decision                             | Where it will plug in                           | Planned ADR |
| ------------------------------------ | ----------------------------------------------- | ----------- |
| LLM provider / model                 | `ModelProvider`                                 | ADR-002     |
| Structured database                  | `MemoryStore`                                   | ADR-003     |
| Vector / semantic retrieval          | `SemanticIndex`, `MemoryRetriever`              | ADR-004     |
| Browser automation implementation    | a `Tool` family + possibly environment support  | ADR-005     |
| Frontend framework                   | `ui/`                                           | later       |
| Exact memory schemas                 | `src/memory/records.ts`                         | later       |
| Growth formula                       | consumer of telemetry + `LessonValidation`      | later       |
| Cloudflare deployment topology       | `src/api/`, `wrangler.jsonc`                    | later       |
| Event transport                      | `EventSink` / `EventSource` implementations     | later       |
| Persistence strategy per memory type | `MemoryStore` / `PersistentStorage` composition | later       |
| Evaluator architecture               | `Evaluator` implementations                     | later       |

### Implementation details (reversible, chosen by default)

Vitest as test runner · Prettier for formatting · branded string ids · ISO-8601 timestamps
· JSON-Schema-shaped tool/structured-output descriptions · `ParseResult` instead of
throwing for untrusted input.

## 9. Phase plan

| Phase | Deliverable                                               | Status                                      |
| ----- | --------------------------------------------------------- | ------------------------------------------- |
| 0     | Repository assessment                                     | done                                        |
| 1     | Contracts, domain models, event schema, tests             | done                                        |
| 2     | Minimal autonomous loop proven with tests                 | done                                        |
| 3     | Cloudflare Sandbox `ExecutionEnvironment`                 | built; real-sandbox tests await credentials |
| 4     | Persistent memory and retrieval                           |                                             |
| 5     | Tools, incrementally                                      |                                             |
| 6     | Learning loop: experience, decisions, lessons, adaptation |                                             |
| 7     | Full event coverage                                       |                                             |
| 8     | Dashboard on real events                                  |                                             |
| 9     | Living Flame driven by telemetry                          |                                             |
| 10    | Cross-run experiment (Run #1 / Run #2)                    |                                             |
