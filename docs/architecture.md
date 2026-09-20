# Architecture

This document describes the V1 architecture of the observable autonomous learning agent
and the current state of each layer. It is a living document; ADRs in `docs/adr/` record
the decisions that shaped it.

## 1. Concepts and where they live

| Concept                   | Responsibility                                      | Location                             | Phase 1 status                          |
| ------------------------- | --------------------------------------------------- | ------------------------------------ | --------------------------------------- |
| **Intelligence**          | Proposes plans, actions, judgements, lessons        | `src/models/`                        | Contract only; provider OPEN            |
| **Capability**            | What the agent can do to the world                  | `src/tools/`                         | Contract + registry; no real tools yet  |
| **Autonomy**              | The loop that keeps acting without a human          | `src/agent/`                         | Component contracts; loop in Phase 2    |
| **Memory**                | What the agent knows, experienced, decided, learned | `src/memory/`                        | Records + store/retrieval contracts     |
| **Evaluation**            | Whether a task actually progressed                  | `src/evaluation/`                    | Contract; strategy OPEN                 |
| **Learning**              | Turning evaluated outcomes into persistent lessons  | `src/agent/contracts.ts` (`Learner`) | Contract only                           |
| **Execution environment** | Where actions physically run                        | `src/sandbox/`                       | Contract; Cloudflare impl in Phase 3    |
| **Persistent storage**    | Artifacts and objects that outlive a sandbox        | `src/storage/`                       | Contract; backend OPEN (R2 candidate)   |
| **Observability**         | Structured events describing every meaningful step  | `src/events/`                        | Schema + factory + sink/source contract |
| **Visual growth**         | Living Flame driven by telemetry                    | `ui/` (not yet created)              | Phase 9                                 |

These are deliberately separate modules. Nothing is allowed to collapse them into one
`Agent` class: the runtime (Phase 2) will orchestrate them through their interfaces.

## 2. The loop the runtime will implement (Phase 2)

```
receive goal                          → GOAL_RECEIVED
while run not finished and limits not reached:
    retrieve relevant memory          → MEMORY_SEARCH_STARTED / MEMORY_RETRIEVED
    create or revise plan             → PLAN_CREATED / PLAN_UPDATED / STRATEGY_CHANGED
    select next action (+ decision)   → DECISION_CREATED / TOOL_SELECTED
    execute action                    → TOOL_STARTED / COMMAND_* / FILE_* / TOOL_COMPLETED|FAILED
    observe result
    evaluate result                   → EVALUATION_COMPLETED
    if failure:                       → FAILURE_DETECTED
        diagnose, revise strategy     → STRATEGY_CHANGED, RETRY_STARTED
    learn (experience + lessons)      → MEMORY_WRITTEN, LESSON_CREATED
finish                                → GOAL_COMPLETED | GOAL_FAILED | RUN_LIMIT_REACHED
```

Each arrow on the right is an event type declared in `src/events/contracts.ts`.

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

`tests/provenance.test.ts` constructs the whole chain and walks it in both directions.
This is what will let the dashboard say, truthfully, "this plan used experience from run
N" and "this lesson came from this failure".

Events mirror the same identifiers in `EventCorrelation`, so the live stream and the
stored records can be joined without a separate index.

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
identity is data (`descriptor.provider`), not a type. Cloudflare Sandbox will implement
it in `src/sandbox/cloudflare/` (Phase 3); a `LocalLinuxEnvironment` can follow without
touching the runtime.

`tests/execution-environment.test.ts` exports a contract suite that every implementation
must pass. It currently runs against the test fake.

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

| Phase | Deliverable                                               | Status |
| ----- | --------------------------------------------------------- | ------ |
| 0     | Repository assessment                                     | done   |
| 1     | Contracts, domain models, event schema, tests             | done   |
| 2     | Minimal autonomous loop proven with tests                 | next   |
| 3     | Cloudflare Sandbox `ExecutionEnvironment`                 |        |
| 4     | Persistent memory and retrieval                           |        |
| 5     | Tools, incrementally                                      |        |
| 6     | Learning loop: experience, decisions, lessons, adaptation |        |
| 7     | Full event coverage                                       |        |
| 8     | Dashboard on real events                                  |        |
| 9     | Living Flame driven by telemetry                          |        |
| 10    | Cross-run experiment (Run #1 / Run #2)                    |        |
