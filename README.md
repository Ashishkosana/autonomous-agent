# Observable Autonomous Learning Agent

An experimental autonomous agent that receives one high-level goal, plans and acts on
its own inside an isolated Linux sandbox, evaluates its own results, extracts lessons,
persists them, and retrieves them in later runs. Everything it does is emitted as
structured telemetry so a human can watch it work — and so the "Living Flame"
visualisation can reflect only measured development, never a fake counter.

The research question: can an agent accumulate experience across runs, retrieve it when
relevant, change strategy because of it, and make that growth observable?

## Status

**Phase 3 — Cloudflare Sandbox adapter (awaiting real execution).** The repository
contains the contracts, domain models and event schema from Phase 1, the autonomous
runtime (`src/agent/runtime/`) from Phase 2, and a `CloudflareSandboxEnvironment` adapter
plus a gateway Worker (`worker/`) from Phase 3. The adapter and gateway are proven against
fake clients and the Worker bundles under `wrangler`; the tests that need a real Cloudflare
sandbox are written but skip until credentials are present — nothing here claims
Cloudflare has been exercised. There is still no real model provider, no persistence and
no dashboard. See [`docs/architecture.md`](docs/architecture.md) for the phase plan and
the list of decisions that are deliberately still open,
[`docs/experiments.md`](docs/experiments.md) for the evidence so far, and
[`docs/adr/ADR-001-cloudflare-sandbox.md`](docs/adr/ADR-001-cloudflare-sandbox.md) for the
Cloudflare findings and the "what is proven, by what" table.

## Layout

```
src/
  domain/      identifiers, provenance, goal, plan, action, observation, artifact, run
  events/      structured event schema, correlation fields, sink/source contracts
  tools/       Tool contract, ToolRegistry, structured ToolResult
  models/      ModelProvider contract + instrumentation decorator (provider is OPEN)
  sandbox/     ExecutionEnvironment contract
  sandbox/cloudflare/  CloudflareSandboxEnvironment, SandboxClient port, HTTP client, wire protocol (no SDK import)
  storage/     PersistentStorage contract for artifacts/objects
  memory/      working memory (implemented), persistent record kinds, store/retrieval contracts
  evaluation/  Evaluator contract — separate from tool success by design
  agent/       Planner / ActionSelector / Executor / Learner contracts and implementations
  agent/runtime/  AgentRuntime loop, RunSession, RunUsageTracker, composition root
tests/         contract, behavioural and architecture-rule tests
tests/runtime/ end-to-end runtime scenarios (recovery, limits, give-up, provenance, ordering)
tests/sandbox/ Cloudflare adapter, gateway handler and HTTP client unit tests (fake sandbox client)
tests/integration/cloudflare/  tests that need a REAL Cloudflare sandbox; skip loudly without credentials
tests/support/ test-only adapters (fake environment, fake sandbox client, in-memory store, scripted model, rule evaluator)
worker/        Cloudflare gateway Worker — the only place `@cloudflare/sandbox` is imported
docs/          architecture, experiments, ADRs
```

## Running locally

Requires Node.js 22 or newer.

```bash
npm install
npm run check        # format check + type check (src + worker) + tests
npm test             # tests only; Cloudflare integration tests are skipped without credentials
npm run typecheck    # strict TypeScript, no emit
npm run format       # prettier --write
```

## Running against a real Cloudflare sandbox

The Sandbox SDK only runs inside a Cloudflare Worker, so the Node-side adapter talks to a
small gateway Worker (`worker/`) over authenticated HTTPS. Requirements: a Cloudflare
account on the Workers Paid plan, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the
environment, and a `workers.dev` subdomain. Docker is **not** required for this path
(the Worker uses the pre-built `cloudflare/sandbox` image); it is only needed for
`npm run worker:dev`.

```bash
npm run worker:deploy     # deploy worker/wrangler.jsonc
npm run worker:secret     # set AGENT_SANDBOX_GATEWAY_TOKEN on the Worker (prompted, never stored here)
export AGENT_SANDBOX_GATEWAY_URL=https://agent-sandbox-gateway.<subdomain>.workers.dev
export AGENT_SANDBOX_GATEWAY_TOKEN=<same token>
npm run test:cloudflare   # fails (does not skip) if the variables are missing
```

Secrets live only in the environment or Wrangler secrets; see `.env.example` and
`worker/.dev.vars.example`. Evidence from real runs is written outside the repository
(`AGENT_SANDBOX_EVIDENCE_DIR`, default `/tmp/agent-sandbox-evidence`).

## Design rules enforced by tests

- Core modules never import Cloudflare or model-vendor SDKs (`tests/architecture.test.ts`).
- `src/` never imports from `tests/`; in-memory adapters are not production code.
- A successful tool call never implies task success (`tests/evaluation.test.ts`).
- Every derived record carries provenance so the chain
  _retrieved memory → plan/decision → action → observation → evaluation → lesson_
  can be walked by identifiers (`tests/provenance.test.ts`).
- Retrieval results state which signals were actually used; "semantic" is never claimed
  by a keyword retriever (`tests/memory.test.ts`).
