# Observable Autonomous Learning Agent

An experimental autonomous agent that receives one high-level goal, plans and acts on
its own inside an isolated Linux sandbox, evaluates its own results, extracts lessons,
persists them, and retrieves them in later runs. Everything it does is emitted as
structured telemetry so a human can watch it work — and so the "Living Flame"
visualisation can reflect only measured development, never a fake counter.

The research question: can an agent accumulate experience across runs, retrieve it when
relevant, change strategy because of it, and make that growth observable?

## Status

**Phase 7 — semantic memory and knowledge ingestion: PROVEN with a real embedding model
across processes and sandboxes on real Linux (E-008, E-009); Docker-isolated run pending.**
The repository contains the contracts, domain models and event schema from
Phase 1, the autonomous runtime (`src/agent/runtime/`) from Phase 2, the
`CloudflareSandboxEnvironment` adapter plus gateway Worker from Phase 3,
`LocalLinuxEnvironment` (`src/sandbox/local/`, ADR-002) from Phase 3B — the verified V1
execution environment — and, new in Phase 4, a vendor-neutral **OpenAI-compatible model
adapter** (`src/models/openai-compatible/`, ADR-003) with environment-driven configuration,
bounded retry/re-ask recovery, per-attempt `MODEL_CALL_STARTED/COMPLETED/FAILED` telemetry
and structural credential containment; and, new in Phase 5, the **standard tool set**
(`src/tools/`, ADR-004): `fs.read/write/list/delete`, `shell.run`, `code.run`
(python/node/sh), `http.request`, `web.fetch`, `git` — every one acting only through
`ExecutionEnvironment`, emitting `COMMAND_*`/`FILE_*` events and declaring artifacts, with
`web.search` present as a seam awaiting a backend decision; and, new in Phase 6, **real
persistent memory** (ADR-005): `SqliteMemoryStore` on Node's built-in `node:sqlite`
(`src/memory/sqlite/`), `FilesystemStorage` for artifacts (`src/storage/local/`),
`archiveArtifacts` emitting `ARTIFACT_STORED`, the `LexicalRetriever` as the production
retriever, `UniqueIdGenerator` for every id that reaches durable storage, and
`AGENT_MEMORY_*` / `AGENT_STORAGE_*` configuration resolved at composition roots; and, new
in Phase 7, **semantic memory and knowledge ingestion** (ADR-006): an `EmbeddingProvider`
with an OpenAI-compatible `/embeddings` adapter over the same transport as chat
(`AGENT_EMBEDDING_*`, no fallback to the chat endpoint), `SqliteSemanticIndex` keeping one
vector per record in the store's own file, `IndexedMemoryStore` embedding on write without
ever blocking persistence, `HybridRetriever` fusing metadata, keyword and cosine signals and
naming exactly which ones matched (with per-kind inclusion so the agent's own bookkeeping
cannot crowd out what it read from the world), and `ObservationKnowledgeIngestor` turning
`web.fetch`/`fs.read` output into `knowledge` records with sources — the fourth memory
category the loop now writes.

Evidence status: the runtime loop is proven with fakes (E-000) and replayed through the
real model adapter over a real local HTTP server; the **real Docker suite including E-003
passed on the developer's Windows 11 + WSL2 + Docker Desktop machine — 25 passed, 0 failed,
0 skipped** (`npm run test:local`); **E-004 has been executed against a real local model**
(Ollama `qwen2.5:3b` through the unchanged OpenAI-compatible adapter, `AGENT_MODEL_TOOL_MODE=json`:
3/3 runs passed 4-of-4, the goal was completed autonomously with a real failure → strategy
change → retry → lesson in 1 of 3 runs; results under review, see `docs/experiments.md`);
the **standard tools run on a real Linux kernel** (namespace runtime on the cloud VM:
11/11 including public-Internet HTTP, and E-005 — a Python program that exits 0 yet fails
evaluation until the loop fixes it — 6/6); **E-006 ran a real local model against the real
nine-tool catalogue in real Linux** (evidence, including the catalogue's prompt cost, in
`docs/experiments.md`); **memory outlives the process and the sandbox** (E-007: two child
OS processes, two fresh Linux sandboxes, one SQLite file — Run 2 retrieved exactly Run 1's
records, the planner was shown the lesson and cited it, Run 1's archived report was read
back after its sandbox was destroyed; 6/6); **E-007b ran a real local model twice against
one persistent memory** (4 runs: retrieval and presentation worked every time, the model
never cited memory, and the one clearly memory-driven decision made Run 2 _worse_ —
recorded honestly as Phase 8 input, no cross-run improvement claimed); **a real embedding
model finds what keywords cannot** (E-008, `nomic-embed-text` via Ollama: a paraphrase with
zero shared terms retrieved by `semantic` alone at cosine 0.62, lexical control 0 hits, an
unreachable endpoint degrades visibly; 7/7); **knowledge read from the world in Run 1 is
found by meaning in Run 2** (E-009: a page fetched through the sandbox becomes a knowledge
record, embedded by the real model into one SQLite file; page, sandbox and process are
destroyed; a second process with a fresh sandbox and a goal sharing no words with the page
retrieves it by `semantic`, the planner is shown it and the plan cites it — 6/6, twice; its
first batch found and fixed a ranking defect that hid the record behind the agent's own
bookkeeping); the same tool, E-005, E-007 and E-009 suites inside an isolated Docker
container are **PENDING** on the developer machine (`npm run test:local`); **real
Cloudflare verification is DEFERRED — requires Workers Paid**. There is no model-assisted
learning, no validated-improvement metric and no dashboard yet (Phases 8–13). See
[`docs/architecture.md`](docs/architecture.md), [`docs/experiments.md`](docs/experiments.md)
and the ADRs in [`docs/adr/`](docs/adr/README.md).

## Layout

```
src/
  domain/      identifiers, provenance, goal, plan, action, observation, artifact, run
  events/      structured event schema, correlation fields, sink/source contracts
  tools/       Tool contract, ToolRegistry, structured ToolResult, createStandardTools (registration = permission)
  tools/{filesystem,terminal,code,http,web,git}/  the nine standard tools — no node builtins, only ExecutionEnvironment
  tools/support/  shell quoting, workspace path confinement, output caps, observed commands, artifact refs
  models/      ModelProvider + EmbeddingProvider contracts, error kinds, secret redaction, instrumentation + resilience decorators, env config
  models/openai-compatible/  chat + embedding adapters for any OpenAI-compatible endpoint over one shared transport (the only fetch in the model layer)
  sandbox/     ExecutionEnvironment contract
  sandbox/cloudflare/  CloudflareSandboxEnvironment, SandboxClient port, HTTP client, wire protocol (no SDK import)
  sandbox/local/       LocalLinuxEnvironment, ContainerRuntime port, container scripts, DockerCliRuntime
  storage/     PersistentStorage contract, key grammar, archiveArtifacts, env config
  storage/local/  FilesystemStorage — the only place node:fs is used
  memory/      working memory, persistent record kinds, store/retrieval contracts, record validation, LexicalRetriever, HybridRetriever, IndexedMemoryStore, searchableText, env config
  memory/sqlite/  SqliteMemoryStore + SqliteSemanticIndex — the only places node:sqlite is used
  evaluation/  Evaluator contract — separate from tool success by design
  agent/       Planner / ActionSelector / Executor / Learner / KnowledgeIngestor contracts and implementations
  agent/runtime/  AgentRuntime loop, RunSession, RunUsageTracker, composition root
tests/         contract, behavioural and architecture-rule tests
tests/runtime/ end-to-end runtime scenarios (recovery, limits, give-up, provenance, ordering, E-000 over the wire adapter)
tests/models/  model layer: wire translation, chat + embedding adapters against a real local HTTP server, config, resilience, telemetry, redaction
tests/tools/   standard tools over the fake environment; over REAL Linux namespaces (tools suite + E-005) — skipped where unshare is unavailable
tests/memory/  MemoryStore contract suite (test store + SQLite), SQLite durability, Lexical/Hybrid retrievers, semantic index, config, E-007 and E-009 (two OS processes, two sandboxes)
tests/storage/ PersistentStorage contract suite, FilesystemStorage confinement, archiveArtifacts
tests/sandbox/ Cloudflare adapter, gateway handler and HTTP client unit tests (fake sandbox client)
tests/integration/cloudflare/  tests that need a REAL Cloudflare sandbox; skip loudly without credentials
tests/integration/local/       tests that need REAL Docker; skip loudly by default, fail (never skip) under npm run test:local
tests/integration/model/       tests that need a REAL model endpoint; skip loudly by default, fail (never skip) under npm run test:model
tests/support/ test-only adapters (fake environment, fake sandbox client, fake OpenAI-format server, in-memory store, scripted model, rule evaluator)
worker/        Cloudflare gateway Worker — the only place `@cloudflare/sandbox` is imported
sandbox/local-linux/  Dockerfile for the pinned local sandbox image (agent-sandbox-local)
scripts/       cross-platform helpers: build/clean the sandbox image, run the local Docker suite, run the real-model suite
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

## Running against a real model (any OpenAI-compatible endpoint)

The runtime never names a vendor; you name an endpoint. Any server that speaks the OpenAI
chat-completions format works — hosted free tiers (OpenRouter `:free` models, Groq, Google
AI Studio's OpenAI-compatible endpoint) or a local server (Ollama, LM Studio — no key). Set
the variables in your shell (or a git-ignored `.env`; see `.env.example`), then:

```bash
export AGENT_MODEL_PROVIDER=openai-compatible
export AGENT_MODEL_BASE_URL=https://<endpoint>/v1        # e.g. http://localhost:11434/v1 for Ollama
export AGENT_MODEL_NAME=<model id as the endpoint expects it>
export AGENT_MODEL_API_KEY=<key>                          # omit for keyless local servers
npm run test:model        # REAL-model suite (E-004): smoke tests + the E-000 goal driven by the model; fails if unset
```

Verified configuration (E-004): Ollama with `qwen2.5:3b` needs `AGENT_MODEL_TOOL_MODE=json`
— small models flatten the native function-call wrapper. A 3B model on CPU takes 7–20 s per
call and completes the E-000 goal in roughly one run out of three; a larger model is
recommended for real work.

Optional knobs: `AGENT_MODEL_LABEL` (telemetry label), `AGENT_MODEL_TIMEOUT_MS`,
`AGENT_MODEL_STRUCTURED_MODE` (`json_schema` | `json_object` | `prompt`),
`AGENT_MODEL_TOOL_MODE` (`tools` | `json`, for servers without function calling),
`AGENT_MODEL_TEMPERATURE`, `AGENT_MODEL_EXTRA_HEADERS` (JSON). The key is sent only as the
`Authorization` header; it is never written to events, memory, the sandbox, logs or error
messages (enforced by tests). Details and rationale: ADR-003.

## Running against a real local Linux sandbox (Docker)

Requirements: Docker Desktop (Windows/macOS) or Docker Engine (Linux) running a **Linux**
engine, and Node.js 22+ to run the tests (on Windows, the WSL Ubuntu distribution with
Docker Desktop's WSL integration works well — it is only the test runner; the agent's
sandbox is a separate disposable container, never your WSL distro or your host shell).

```bash
npm install
npm run sandbox:build     # docker build → agent-sandbox-local:0.1.0 (node 22, python3, git, curl; non-root)
npm run test:local        # REAL Docker suite: TEST 1–9, contract, lifecycle, E-003, Phase 5 tools, E-005; fails if Docker/image missing
npm run sandbox:clean     # remove any leftover sandbox containers (label agent.sandbox=1)
```

The container gets no host mounts, no Docker socket, no host environment, no
capabilities, no root, `--cpus 2 --memory 2g --pids-limit 256`, a private bridge network
with outbound Internet only. Details and rationale: ADR-002. Evidence is written to
`AGENT_SANDBOX_EVIDENCE_DIR` (default `<tmp>/agent-sandbox-evidence`), never into the repo.
Set `AGENT_TEST_INTERNET=1` to also assert that `http.request`/`web.fetch` reach the public
Internet from inside the sandbox (example.com).

Without Docker, on any Linux host with `unshare`, `npm test` already runs the Phase 5 tool
suite and E-005 on the real kernel through the test-only namespace runtime (real python3,
node, git, curl; **no isolation claimed**). To run E-006 — a real model choosing among the
real tools in real Linux — configure a model as above and run `npm run test:model`
(`AGENT_E006_RUNS=3` for several runs; add `AGENT_LOCAL_DOCKER=1` to use Docker instead of
namespaces). The same command runs E-007b — the model twice against one persistent SQLite
memory, fresh sandbox each time (`AGENT_E007B_PAIRS=2` for several pairs).

## Persistent memory and storage

Memory records (`knowledge`, `experience`, `decision`, `lesson`) live in one SQLite file
through Node's built-in `node:sqlite` (no dependency; Node 22.13+ prints an
`ExperimentalWarning`); artifacts promoted out of a sandbox live under a storage directory.
Both are configured, never defaulted:

```bash
export AGENT_MEMORY_BACKEND=sqlite
export AGENT_MEMORY_PATH=./.agent/memory.sqlite      # or :memory:
export AGENT_STORAGE_BACKEND=filesystem
export AGENT_STORAGE_ROOT=./.agent/storage
```

Delete the file and the directory to forget everything. Details, contract and evidence:
ADR-005, E-007 and E-007b in `docs/experiments.md`.

### Semantic retrieval (optional, needs an embedding model)

Without an embedding model, retrieval is keyword-only and says so (`signalsUsed` never
contains `semantic`). To retrieve by meaning, name an OpenAI-compatible `/embeddings`
endpoint — a second model, configured separately from the chat model, with no fallback
between the two:

```bash
export AGENT_EMBEDDING_PROVIDER=openai-compatible
export AGENT_EMBEDDING_BASE_URL=http://localhost:11434/v1   # e.g. Ollama: `ollama pull nomic-embed-text`
export AGENT_EMBEDDING_MODEL=nomic-embed-text
export AGENT_EMBEDDING_API_KEY=<key>                        # omit for keyless local servers
npm run test:model     # also runs E-008 (real embedding) — and `npm test` then runs E-009 on real Linux
```

Vectors live in the same SQLite file as the records, tagged with the model that produced
them; changing the model makes old vectors invisible (not wrong) until `backfill()`.
Verified configuration (E-008/E-009): Ollama `nomic-embed-text`, 768 dimensions, 16–90 ms
per call on CPU; paraphrases scored 0.56–0.62 against a 0.5 floor, unrelated text 0.36.
Details and rationale: ADR-006.

## Running against a real Cloudflare sandbox (DEFERRED — requires Workers Paid)

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
- `src/` has no third-party runtime dependencies outside an explicit, per-file adapter
  allowlist (currently empty) that may never name a core directory.
- `src/` never reads `process.env` — configuration is resolved at composition roots and
  passed in; network `fetch` is confined to the two named adapters (the model transport and
  the sandbox HTTP client); no model adapter retains the API key as a property.
- `src/` never imports from `tests/`; in-memory adapters are not production code.
- Tools touch the world only through `ExecutionEnvironment`: nothing under `src/tools/`
  imports a Node builtin, spawns a process or calls `fetch` (`tests/architecture.test.ts`).
- `node:sqlite` appears only in the two SQLite adapters, `node:fs` only in the filesystem
  storage, and `src/agent/` never imports a concrete memory or storage backend or its config
  (`tests/architecture.test.ts`).
- A memory record id owned by one run can never be overwritten by another run
  (`tests/support/memory-store-contract.ts`, run over every `MemoryStore`).
- A successful tool call never implies task success (`tests/evaluation.test.ts`).
- Every derived record carries provenance so the chain
  _retrieved memory → plan/decision → action → observation → evaluation → lesson_
  can be walked by identifiers (`tests/provenance.test.ts`).
- Retrieval results state which signals were actually used; "semantic" is never claimed
  by a keyword retriever, and the hybrid retriever claims it only when the index answered —
  an embedding failure is reported as `degraded`, never hidden (`tests/memory.test.ts`,
  `tests/memory/hybrid-retriever.test.ts`).
- Knowledge ingested from the world reaches the planner only as a capped, quoted excerpt
  with its source; `KNOWLEDGE_INGESTED` events carry where and how much, never the content
  (`tests/runtime/knowledge-ingestion.test.ts`).
