# Observable Autonomous Learning Agent

An experimental autonomous agent that receives one high-level goal, plans and acts on
its own inside an isolated Linux sandbox, evaluates its own results, extracts lessons,
persists them, and retrieves them in later runs. Everything it does is emitted as
structured telemetry so a human can watch it work — and so the "Living Flame"
visualisation can reflect only measured development, never a fake counter.

The research question: can an agent accumulate experience across runs, retrieve it when
relevant, change strategy because of it, and make that growth observable?

## Status

**Phase 1 — architecture skeleton.** This repository currently contains contracts, domain
models, an event schema, and tests. There is no autonomous loop yet, no model provider,
no Cloudflare integration, no dashboard. Those arrive in later phases; see
[`docs/architecture.md`](docs/architecture.md) for the phase plan and the list of
decisions that are deliberately still open.

## Layout

```
src/
  domain/      identifiers, provenance, goal, plan, action, observation, artifact, run
  events/      structured event schema, correlation fields, sink/source contracts
  tools/       Tool contract, ToolRegistry, structured ToolResult
  models/      ModelProvider contract (provider is an OPEN decision)
  sandbox/     ExecutionEnvironment contract (Cloudflare Sandbox implements it in Phase 3)
  storage/     PersistentStorage contract for artifacts/objects
  memory/      working memory, persistent record kinds, MemoryStore, retrieval contracts
  evaluation/  Evaluator contract — separate from tool success by design
  agent/       Planner / ActionSelector / Executor / Learner contracts (runtime in Phase 2)
tests/         contract, behavioural and architecture-rule tests
tests/support/ test-only adapters (fake environment, in-memory store, scripted model)
docs/          architecture, experiments, ADRs
```

## Running locally

Requires Node.js 22 or newer.

```bash
npm install
npm run check        # format check + type check + tests
npm test             # tests only
npm run typecheck    # strict TypeScript, no emit
npm run format       # prettier --write
```

## Design rules enforced by tests

- Core modules never import Cloudflare or model-vendor SDKs (`tests/architecture.test.ts`).
- `src/` never imports from `tests/`; in-memory adapters are not production code.
- A successful tool call never implies task success (`tests/evaluation.test.ts`).
- Every derived record carries provenance so the chain
  _retrieved memory → plan/decision → action → observation → evaluation → lesson_
  can be walked by identifiers (`tests/provenance.test.ts`).
- Retrieval results state which signals were actually used; "semantic" is never claimed
  by a keyword retriever (`tests/memory.test.ts`).
