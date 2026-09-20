# ADR-001 — Cloudflare Sandbox as the V1 execution environment

Status: Accepted. Adapter, gateway Worker and integration tests implemented (Phase 3).
**Real Cloudflare verification: DEFERRED — requires Workers Paid** (decision 2026-09-20; not a
failure). The code stays in the repository and activates unchanged once an account exists.
Development uses `LocalLinuxEnvironment` (ADR-002) against the same contract meanwhile.
Date: 2026-09-20 (Phase 1); evidence section updated 2026-09-20 (Phase 3)

## Problem

The agent needs an isolated Linux environment with a full shell, filesystem, code
execution and Internet access, in which it can act with broad autonomy without reaching
the host or other tenants. The environment must be reachable from the same platform that
hosts the API, coordination state and persistent storage.

## Requirements

- Isolated Linux container per run (or per agent session) with Bash, Python and Node.
- Full shell inside the boundary; no artificial command allowlist.
- Public Internet egress from inside the sandbox.
- Filesystem and process control from the runtime.
- Container state may be treated as ephemeral; durability comes from external storage.
- The agent runtime must not depend on the provider: the same brain must be able to run
  against a local Linux environment or another cloud later.

## Options considered

1. **Cloudflare Sandbox** (Cloudflare Containers + Sandbox SDK) — sandboxed Linux with
   command execution, file APIs, process management and network egress, co-located with
   Workers, R2, D1/KV/Durable Objects and Vectorize.
2. **Self-managed containers on a VM** (Docker on a VPS/EC2) — maximum control, but we
   own isolation, scaling, networking and the host boundary ourselves.
3. **Third-party code-execution sandboxes** (e.g. hosted microVM providers) — good
   isolation, but adds a second vendor and a network hop for every action, and splits
   the platform between two clouds.
4. **Serverless functions only** — cannot provide a persistent shell, arbitrary installs
   or long-running processes.

## Decision

Cloudflare hosting and Cloudflare Sandbox are the V1 execution environment. This was set
as a locked baseline by the project owner and is recorded here so the reasoning and the
conditions for revisiting it are explicit.

The implementation lives behind `ExecutionEnvironment` (`src/sandbox/execution-environment.ts`).
Cloudflare-specific code is confined to `src/sandbox/cloudflare/` (SDK-free adapter) and
`worker/` (the only code that imports the SDK). `tests/architecture.test.ts` fails if any
other module imports a Cloudflare package.

## Reason

- One platform for API, coordination, sandbox and storage keeps V1 topology small.
- Sandbox gives the locked requirement — full shell in an isolated Linux boundary —
  without us operating hosts.
- Co-located R2 (objects), a structured store and Vectorize are natural candidates for
  the OPEN storage decisions, though none is chosen by this ADR.

## Tradeoffs

- Platform coupling for deployment and operations; mitigated by the interface boundary.
- Container lifetime, cold starts, resource ceilings and egress behaviour are set by the
  platform and must be measured, not assumed (see evidence below).
- Local emulation of sandbox behaviour requires Wrangler + Docker; a
  `LocalLinuxEnvironment` implementation of the same contract remains the intended
  fallback for offline work.

## Reversibility

Medium. The agent runtime, tools, memory and evaluation depend only on
`ExecutionEnvironment`; replacing the sandbox means writing one new implementation and
passing the shared contract suite (`tests/support/execution-environment-contract.ts`).
Deployment topology and any Cloudflare-specific storage choices would need their own
migration.

---

## Phase 3 evidence

Legend used throughout: **[REAL]** proven by execution against Cloudflare ·
**[FAKE]** proven only with local/fake adapters · **[LOCAL]** verified by local tooling
without a Cloudflare account · **[DOCS]** taken from official Cloudflare documentation,
verified on 2026-09-20 · **[NOT YET]** not tested.

### Official requirements discovered [DOCS]

Source: `developers.cloudflare.com/sandbox/*` and `/containers/*` (pages last updated
Aug–Sep 2026), plus the published npm package and Docker Hub tags.

| Topic                      | Finding                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package                    | `@cloudflare/sandbox`. Stable `latest` = **0.12.9** (published 2026-09-03). A **1.0 preview** is on the `@next` tag (`0.13.0-next.751.1` at time of writing, several releases per week). Cloudflare recommends `@next` for new projects; it is still a preview with a changing API.                                |
| Plan / entitlement         | "Available on Workers Paid plan". Built on Cloudflare Containers. (Bridge docs still mention a "Containers / Sandbox beta" flag; the main docs do not.)                                                                                                                                                            |
| Where the SDK runs         | Only inside a Cloudflare Worker: `getSandbox(env.Sandbox, id)` needs a Durable Object namespace binding. There is no client for Node or other hosts. Cloudflare's own answer for external callers is a self-deployed **bridge Worker** exposing HTTP.                                                              |
| Wrangler config            | `containers[]` (`class_name: "Sandbox"`, `image`, `instance_type`, `max_instances`), `durable_objects.bindings[]` (`class_name`/`name: "Sandbox"`), `migrations[]` (`new_sqlite_classes: ["Sandbox"]`), `compatibility_flags: ["nodejs_compat"]`. The Worker must `export { Sandbox } from '@cloudflare/sandbox'`. |
| Container image            | Must match the npm version exactly (runtime version check). Public images on Docker Hub: `cloudflare/sandbox:0.12.9` (Ubuntu 22.04, Node 20, Bun, git/curl/jq…, **no Python**), `-python` (adds Python 3.11 + pandas/numpy), `-opencode`, `-musl`.                                                                 |
| Docker                     | Required for `wrangler dev` (local emulation via Miniflare) and for `wrangler deploy` **when `image` is a Dockerfile**. **Not required** when `image` is a pre-built registry reference (Cloudflare pulls it). We use the pre-built image for this reason.                                                         |
| Authentication             | `wrangler login` (browser OAuth) or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` for non-interactive use. A `workers.dev` subdomain must exist on the account for the default URL.                                                                                                                             |
| Command execution (stable) | `exec(command: string, { cwd, env, timeout })` → `{ success, exitCode, stdout, stderr, command }`, runs through a shell in the container. `startProcess(command, { cwd, env, autoCleanup, … })` → `Process { id, pid, status, kill(), … }`; `listProcesses()`, `getProcess()`, `killProcess(id, signal)`.          |
| Files (stable)             | `readFile`, `writeFile`, `deleteFile`, `exists`, `mkdir({recursive})`, `listFiles` (returns `name, absolutePath, type, size, modifiedAt`), `renameFile`, `moveFile`. Absolute paths.                                                                                                                               |
| stdin                      | Documented for `exec`/`startProcess`, **but absent from the 0.12.9 type definitions and JavaScript** (verified in `node_modules`). Treated as unavailable.                                                                                                                                                         |
| Timeouts                   | Per-command `timeout` "raises an error on the caller side… the underlying process continues running". HTTP transport has a 120 s default request timeout; RPC transport (`SANDBOX_TRANSPORT=rpc`) multiplexes calls. `sleepAfter` (default 10 m) stops idle containers; `keepAlive` disables that.                 |
| Lifecycle                  | Sandbox id → Durable Object → _current_ container. Idle stop, failure, or platform replacement discards **all** files, processes and shell state; the next call starts a fresh container for the same id. `destroy()` is explicit teardown.                                                                        |
| Network                    | Outbound Internet works by default; inbound needs `exposePort`/tunnels. Outbound handlers can block/allow/inject credentials (not used in Phase 3).                                                                                                                                                                |
| Persistence options        | Mount S3-compatible buckets (R2) as directories; backup/restore of directories to R2; both documented as production-only features. Not used in Phase 3 (deliberately).                                                                                                                                             |
| Limits                     | Inherit Containers limits (instance types `lite`, `basic`, `standard-*`; memory/vCPU/disk per type). Workers subrequest limits apply per request (1,000 on Paid).                                                                                                                                                  |
| Security model             | Per-sandbox VM isolation of filesystem, processes, network; shared everything _within_ a sandbox → one sandbox per run/user. Sandbox ids are not credentials: the Worker must authenticate callers.                                                                                                                |

### Choices made in Phase 3

1. **Stable `0.12.9`, not the `@next` preview.** The preview's `exec` is argv-only,
   returns a handle instead of a result, has no stdin, and its API moves weekly. The
   contract we must satisfy needs buffered results and stdin. The SDK is touched in one
   file (`worker/src/sdk-sandbox-client.ts`) so migrating to 1.0 later is contained.
2. **Project-owned gateway Worker, not Cloudflare's reference bridge.** The bridge only
   exposes `exec` and `/workspace`-scoped read/write over HTTP; it has no delete/exists/
   list or process endpoints, and it skips authentication when its secret is unset. Our
   gateway (`worker/src/`) exposes exactly the `SandboxClient` subset the adapter needs,
   requires a bearer secret (fails closed without one), validates sandbox ids and
   request bodies, and serialises SDK errors into a normalised vocabulary.
3. **Pre-built image reference** (`docker.io/cloudflare/sandbox:0.12.9`) instead of a
   Dockerfile, so real deployment does not depend on a local Docker daemon. Consequence:
   no Python in the default image; the code-execution test probes for runtimes instead
   of assuming one. Switching to `-python` is a one-line config change.
4. `enableDefaultSession: false` (each `exec` independent, `cwd`/`env` per call — the
   contract has no hidden shell state; also the SDK's recommended forward-compatible
   setting) and `normalizeId: true` (lowercase ids, the SDK's future default).
5. `transport: 'rpc'`. Cloudflare's 2026 deprecation guide (checked via the official
   `sandbox-stable` skill during onboarding) deprecates the default HTTP and the WebSocket
   DO→container transports in favour of RPC. Set explicitly in `getSandbox()` rather than
   via `SANDBOX_TRANSPORT` so there is one source of truth; it must not change for an id
   once in use.

**Onboarding check (2026-09-20).** Cloudflare's agent-setup instructions
(`developers.cloudflare.com/agent-setup/prompt.md`) were applied: official skills installed
to `~/.agents/skills` (14, including `sandbox-stable`, `wrangler`, `durable-objects`) and
the five Cloudflare MCP servers registered in `.cursor/mcp.json` (URLs only, OAuth on first
use). Comparing the `sandbox-stable` skill's gate and contract with this repository: package
and image are both on the stable `0.12.9` line; `exec` is used as a buffered command string;
sessions are disabled; the only deviation was the deprecated default transport, fixed by
choice 5. No conflict with the architecture; no restructuring performed.

### Mapping: `ExecutionEnvironment` → Cloudflare

`CloudflareSandboxEnvironment` (`src/sandbox/cloudflare/cloudflare-sandbox-environment.ts`)
depends on a `SandboxClient` port (`sandbox-client.ts`) that mirrors the SDK subset.
`HttpSandboxClient` implements the port over HTTPS to the gateway; `SdkSandboxClient`
implements it inside the Worker with the real SDK.

| Contract method                  | Cloudflare implementation                                                                                                                                                                                                                                                                                                                                                                           | Status |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `runCommand(cmd, {cwd, env})`    | `sandbox.exec(cmd, { cwd, env })`; `exitCode/stdout/stderr` copied; `durationMs` measured by the adapter.                                                                                                                                                                                                                                                                                           | [FAKE] |
| `runCommand(…, {stdin})`         | **Gap in SDK 0.12.9.** Adapter writes the payload to `/tmp/.agent-stdin-<id>` via `writeFile`, runs `sh -c '<cmd>' < '<file>'`, deletes the file in `finally`. Same technique Cloudflare documents for its own (newer) stdin support.                                                                                                                                                               | [FAKE] |
| `runCommand(…, {timeoutMs})`     | **Semantic mismatch.** SDK timeout aborts the request and leaves the process running with output lost. Adapter wraps the command in `timeout -k 2 <s> sh -c '…'` inside the sandbox so the process is actually terminated and partial output survives; exit 124/137 at/after the deadline → `timedOut: true, exitCode: null`. SDK `timeout` is passed as a backstop with +10 s grace.               | [FAKE] |
| `readFile`                       | `sandbox.readFile(path, { encoding: 'utf-8' }).content`; `FileNotFoundError` → `not_found`.                                                                                                                                                                                                                                                                                                         | [FAKE] |
| `writeFile`                      | `sandbox.mkdir(parent, { recursive: true })` then `sandbox.writeFile(path, content)`.                                                                                                                                                                                                                                                                                                               | [FAKE] |
| `deleteFile`                     | `sandbox.deleteFile(path)`; not-found → `not_found`.                                                                                                                                                                                                                                                                                                                                                | [FAKE] |
| `fileExists`                     | `sandbox.exists(path).exists`.                                                                                                                                                                                                                                                                                                                                                                      | [FAKE] |
| `listDirectory`                  | `sandbox.listFiles(path).files` → `{ name, path: absolutePath, type, sizeBytes: size }`.                                                                                                                                                                                                                                                                                                            | [FAKE] |
| `startProcess`                   | `sandbox.startProcess(cmd, { cwd, env, autoCleanup: false })` → `{ processId: id, command, startedAt }`. `autoCleanup: false` keeps the record inspectable after exit.                                                                                                                                                                                                                              | [FAKE] |
| `stopProcess`                    | `sandbox.killProcess(id)` (SIGTERM); `ProcessNotFoundError` → `not_found`; adapter records `killed`.                                                                                                                                                                                                                                                                                                | [FAKE] |
| `getState`                       | `listProcesses()` + `getContainerPlacementId()`; status `ready` on success, `starting` on container-unavailable, `error` otherwise (never throws except for misconfiguration), `stopped` after `destroy()`. Process states merge live records with the adapter's own record (SDK `starting/running`→`running`, `killed`→`killed`, `completed/failed/error`→`exited`; untracked-but-known→`exited`). | [FAKE] |
| `ExecutionEnvironmentError.code` | SDK error `name`/`code` → normalised kind → contract code: `file_not_found`/`process_not_found`→`not_found`; `permission_denied`→`permission_denied`; `container_unavailable`/`request_timeout`→`unavailable`; everything else→`internal`.                                                                                                                                                          | [FAKE] |
| _(not in contract)_ `destroy()`  | `sandbox.destroy()`; exposed on the adapter for lifecycle experiments and cleanup only.                                                                                                                                                                                                                                                                                                             | [FAKE] |

Provider identity is data: `descriptor = { provider: 'cloudflare-sandbox', environmentId: <sandbox id> }`.
No new events were added: tool execution through this adapter emits the same
`TOOL_STARTED/COMPLETED/FAILED` events as through the fake.

### What is proven, by what

| Claim                                                                                                  | Status    | Evidence                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter satisfies the shared `ExecutionEnvironment` contract suite                                     | [FAKE]    | `tests/sandbox/cloudflare-sandbox-environment.test.ts` (over `FakeSandboxClient`) and `tests/sandbox/http-sandbox-client.test.ts` (over the full HTTP chain in-process) |
| stdin staging/cleanup, timeout wrapping, parent-dir creation, process-state merging, error mapping     | [FAKE]    | `tests/sandbox/cloudflare-sandbox-environment.test.ts`                                                                                                                  |
| Gateway auth (fail-closed), routing, validation, error serialisation                                   | [FAKE]    | `tests/sandbox/gateway.test.ts` — handler runs in Node with the Fetch API                                                                                               |
| Wire protocol round-trips every operation and error kind                                               | [FAKE]    | `tests/sandbox/http-sandbox-client.test.ts`                                                                                                                             |
| Worker bundles against the real SDK; wrangler accepts the config and lists the container/DO bindings   | [LOCAL]   | `wrangler deploy --dry-run` (no account needed) produced a 634 KiB bundle and reported the `Sandbox` DO binding and `docker.io/cloudflare/sandbox:0.12.9` container     |
| Only `worker/src/index.ts` and `worker/src/sdk-sandbox-client.ts` import `@cloudflare/*`               | [FAKE]    | `tests/architecture.test.ts`                                                                                                                                            |
| TEST 1–7 (command, filesystem, code, failure, processes, network, boundary) on a real sandbox          | [NOT YET] | `tests/integration/cloudflare/execution-boundary.test.ts` — written, skipped without credentials                                                                        |
| Shared contract suite on a real sandbox                                                                | [NOT YET] | `tests/integration/cloudflare/contract.test.ts`                                                                                                                         |
| Phase 2 recovery scenario with real sandbox + scripted model                                           | [NOT YET] | `tests/integration/cloudflare/autonomous-loop.test.ts`                                                                                                                  |
| Lifecycle: reuse while active, isolation between ids, destroy → clean container, idle stop loses files | [NOT YET] | `tests/integration/cloudflare/lifecycle.test.ts` (idle observation opt-in via `AGENT_SANDBOX_IDLE_WAIT_MS`)                                                             |
| `SdkSandboxClient` (the one file that calls the SDK) behaves as its types suggest                      | [NOT YET] | Only real execution can prove it; it is intentionally trivial                                                                                                           |

Real-execution results will be appended below once the prerequisites in the next
section are met. Until then, nothing in this repository claims Cloudflare has been
exercised. **Status 2026-09-20: DEFERRED — requires Workers Paid.** The owner chose not to
pay for the plan yet; every [NOT YET] row above stays open and none is marked failed.

### Prerequisites for real execution (user-controlled)

1. A Cloudflare account on the **Workers Paid** plan with Containers/Sandbox available.
2. `CLOUDFLARE_API_TOKEN` (Workers Scripts + Durable Objects + Containers permissions; the
   "Edit Cloudflare Workers" template is the starting point) and `CLOUDFLARE_ACCOUNT_ID`,
   provided as environment variables/secrets — never in the repository.
3. A `workers.dev` subdomain registered on the account (or a custom route).
4. Then: `npm run worker:deploy`, `npm run worker:secret` (bearer token), export
   `AGENT_SANDBOX_GATEWAY_URL` / `AGENT_SANDBOX_GATEWAY_TOKEN`, `npm run test:cloudflare`.

Docker is **not** needed for this path. It is needed only for `npm run worker:dev`.

### Lifecycle semantics and the memory rule [DOCS, to be confirmed REAL]

- Creation is lazy: the first operation on an id starts a container (cold start can take
  tens of seconds; the SDK waits up to 30 s for provisioning + 90 s for readiness by
  default).
- The same id reaches the same Durable Object; while its container is active, files,
  processes and shell state persist and are shared by every caller using that id.
- After `sleepAfter` idle time (10 m default; we set 5 m), on failure, or on platform
  replacement, the container is gone: **all files, processes and interpreter state are
  lost**. The next operation silently starts a fresh container with the same id.
- `destroy()` discards everything immediately; the id can be reused.
- Guarantees that exist: isolation between ids; same-id routing; explicit destroy.
- Guarantees that do **not** exist: file survival across idle/replace; process survival;
  a stable container behind an id; any notion of "the same machine" over time.

Therefore persistent agent memory (knowledge, experience, decisions, lessons) and
durable artifacts must live outside the sandbox — in whatever `MemoryStore` /
`PersistentStorage` implementations Phase 4 chooses. Sandbox-local files are working
state for one run, and even within a run the runtime must tolerate a container restart
(`getState().status === 'starting'`, `ExecutionEnvironmentError('unavailable')`).

### Known limitations

- **stdin** is emulated via a temp file: the payload briefly exists on the sandbox disk
  under `/tmp`. Acceptable for V1 (the sandbox is single-tenant per run); revisit if the
  SDK ships native stdin.
- **Timeout ambiguity**: a command that itself exits 124/137 at or after the deadline is
  indistinguishable from a timeout. Fast exits with those codes are classified
  correctly.
- **Request ceiling**: without `timeoutMs`, a command longer than the SDK's 120 s request
  timeout fails with `unavailable`; tools should pass explicit deadlines.
- **Per-call subrequests**: each adapter call is one Worker request → one SDK call over
  the RPC transport. Fine for the gateway topology; if the runtime ever moves inside the
  Worker, the multiplexed RPC session is what keeps it under subrequest limits.
- **No Python** in the default image; choose `-python` or a custom image when needed.
- **Gateway is a network hop**: latency per operation is a round trip to the Worker plus
  the Worker→container call. Measured values will be recorded from the evidence files.
- The `killed` status after `stopProcess` reflects the adapter's request; if the sandbox
  still reports the process running, `getState()` says `running` (truth over intent).

### Unresolved topology questions (deliberately NOT decided here)

- Where the **agent runtime** runs in production: inside a Worker/Durable Object (CPU and
  wall-clock limits, needs RPC transport, `SdkSandboxClient` directly) or on a long-lived
  host talking to the gateway (as the tests do). The adapter supports both because the
  mapping sits behind the `SandboxClient` port.
- One sandbox per run vs. per agent session; `sleepAfter`/`keepAlive` policy; region
  pinning (first request fixes the location).
- Whether the gateway stays a separate Worker or folds into the future API Worker.
- Custom image contents (Python, browsers for automation, extra tooling) — with a
  Dockerfile this reintroduces the Docker requirement for deploys, or a CI image build.
- Whether to adopt Sandbox SDK 1.0 when it becomes stable.
