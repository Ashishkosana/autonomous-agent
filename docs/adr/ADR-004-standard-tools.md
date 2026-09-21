# ADR-004 — Standard tools: real capabilities that act only through `ExecutionEnvironment`

**Status:** accepted (Phase 5) — **PROVEN on real Linux** (namespace runtime on the Cursor
cloud VM: 11/11 tool tests + E-005 6/6; see `docs/experiments.md`); **Docker-isolated run
PENDING** on the developer machine (`npm run test:local`, `tests/integration/local/`).
· **Date:** 2026-09-20 · **Relates to:** ADR-002 (the environment the tools run in),
ADR-003 (the model that proposes tool calls).

## 1. Context

Through Phase 4 the runtime's capability layer was a contract (`Tool`, `ToolRegistry`,
`invokeTool`) exercised only by two test doubles. The locked V1 capabilities are
filesystem, terminal/shell, code execution, Internet access, discovery/search, Git —
plus browser and GitHub (Phase 9). E-004 showed a real model choosing among real tool
descriptors, so the descriptors now have to describe real things.

Constraints: no third-party dependencies in `src/`; tools may not reach the host; the
model must never be told about a capability the run does not actually have; non-zero
exit codes, 404s and wrong outputs are observations for the evaluator, not tool errors;
every meaningful operation emits an event.

## 2. Decision

1. **Tools are thin translations onto `ExecutionEnvironment`.** Every byte a tool moves
   goes through `ToolContext.environment` — `runCommand`, `readFile`, `writeFile`,
   `listDirectory`, `deleteFile`, `startProcess`. Nothing in `src/tools/` imports a Node
   builtin, spawns a process or calls `fetch` (rule in `tests/architecture.test.ts`).
   Consequently the sandbox's boundaries — non-root user, no host mounts, resource
   limits, its network — are the tools' boundaries. There is no second, softer security
   model in the tool layer.

2. **HTTP happens inside the sandbox.** `http.request` and `web.fetch` run `curl(1)` in
   the environment (`src/tools/http/curl-client.ts`), so the agent's traffic leaves
   through the sandbox's network and is subject to whatever egress policy that network
   enforces. The tool adds validation (absolute `http(s)` URL, no embedded credentials,
   header-injection rejection, `--proto =http,https`, bounded redirects, `--max-time`,
   body capped by `head -c`) — not connectivity of its own.

3. **Registration is the permission model.** `createStandardTools({ families })` builds
   only the requested families. An unregistered tool cannot be described to the model,
   validated or invoked (`unknown_tool`). Finer policy (per-path, per-host) is deferred
   until a phase needs it; it will be enforced at dispatch, not by prompt text.

4. **The model proposes; the tool validates; the sandbox executes; the evaluator judges.**
   `parseInput` rejects malformed proposals with every error at once (`invalid_input`,
   retryable). Paths are resolved under the workspace root and escapes are rejected before
   anything is touched (`resolveWorkspacePath`). Timeouts are clamped to a ceiling set at
   the composition root; the model can only shorten them. Outputs are capped with an
   explicit `truncated` flag. `git` accepts an allowlist of local subcommands, prepends a
   fixed identity, disables credential prompts and rejects `push`, `config`, `-c`, exec
   overrides, non-`http(s)` and credentialed remotes — the allowlist is about **external
   effects and credentials**, not code execution (`shell.run` allows that by design).

5. **Exit codes are data.** `shell.run`, `code.run` and `git` return `{exitCode, timedOut,
stdout, stderr}` with `status: 'ok'` whenever the command ran; a killed-by-timeout
   command has `exitCode: null, timedOut: true`. Only environment-level failures (missing
   file → `not_found`, refused connection → `execution_failed`, …) fail the tool call.
   E-005 is the proof that this matters: a program that exits 0 and writes a file is
   judged wrong by the evaluator reading that file.

6. **Tools narrate themselves.** `ToolContext.emit` (replacing the unusable raw
   `EventSink`) lets a tool emit `COMMAND_STARTED/OUTPUT/FINISHED`, `FILE_CREATED/
CHANGED/DELETED` (and later `BROWSER_NAVIGATION`); the run session stamps sequence,
   run id and the action's correlation. File-producing tools declare `ArtifactRef`s that
   `invokeTool` attaches to the `ToolResult` and the executor copies onto the
   `Observation` — the first time `Observation.artifacts` is populated.

7. **Search is a seam, not an implementation.** `web.search` exists behind
   `SearchProvider`; no backend ships in `src/`, and the tool is omitted from the
   catalogue when no provider is configured. Choosing the backend (self-hosted metasearch
   queried from the sandbox vs. a keyed API) is an open decision recorded in
   `docs/architecture.md`.

## 3. The catalogue

| Tool           | Family     | Through the environment                                 | Emits                                      |
| -------------- | ---------- | ------------------------------------------------------- | ------------------------------------------ |
| `fs.read`      | filesystem | `readFile` (capped)                                     | —                                          |
| `fs.write`     | filesystem | `fileExists` + `writeFile`                              | `FILE_CREATED` / `FILE_CHANGED`, artifact  |
| `fs.list`      | filesystem | `listDirectory` (≤500 entries)                          | —                                          |
| `fs.delete`    | filesystem | `deleteFile` (never the root)                           | `FILE_DELETED`                             |
| `shell.run`    | terminal   | `runCommand` (cwd in workspace, clamped timeout, stdin) | `COMMAND_*`                                |
| `code.run`     | code       | `writeFile` source under `.agent/code/` + `runCommand`  | `FILE_CREATED`, `COMMAND_*`, code artifact |
| `http.request` | http       | `runCommand` (`curl` script, scratch files removed)     | — (TOOL_COMPLETED summary)                 |
| `web.fetch`    | web        | same + `htmlToText`                                     | —                                          |
| `web.search`   | web        | injected `SearchProvider` (none shipped)                | —                                          |
| `git`          | git        | `runCommand` (`git -c user.… <allowlisted subcommand>`) | `COMMAND_*`                                |

The tool descriptors (name, family, description, input JSON schema) serialise to ~4.4k
characters for nine tools; E-006 records what that costs in prompt tokens per
`select_action` call (architectural observation #4 of E-004).

## 4. Options considered and rejected

- **Node-side implementations** (host `fs`, `child_process`, `fetch`) — faster to write,
  but every tool would need its own confinement and the sandbox would stop being the
  boundary. Rejected; enforced by test.
- **One generic `exec` tool only** — minimal catalogue, but the model would have to
  compose shell for every file write and HTTP call; small models already struggle with
  wrapper shapes (E-004). Typed tools with schemas are cheaper to validate and observe.
- **A separate policy engine now** — no phase needs per-path/per-host rules yet; the
  registry-as-allowlist is enforceable today and does not preclude one later.
- **Scraping a public search engine for `web.search`** — fragile and of doubtful
  legitimacy; the seam is shipped, the backend is a decision for the owner.

## 5. Consequences

- Any new `ExecutionEnvironment` (Cloudflare, ADR-001) gets the whole tool set for free,
  provided its image has `sh`, coreutils, `python3`, `node`, `git`, `curl` — the same
  requirement ADR-002's image already meets.
- `ToolContext` changed shape (`events: EventSink` → `emit: ToolEventEmitter`); the
  only consumers were the executor and the test harness.
- `ToolErrorCode` gained `not_found` and `permission_denied`; `ToolResult` (ok) gained
  optional `artifacts`; `EVALUATION_COMPLETED` gained `toolStatus`. All additive.
- Scratch files live under `<workspace>/.agent/` and are visible to `fs.list`; they are
  real artifacts of the run and are meant to be.

## 6. Verification

| Claim                                                            | Evidence                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Tools validate, confine, cap, and map errors                     | `tests/tools/*.test.ts` over `FakeExecutionEnvironment` (37 tests)                                          |
| Tools never touch the host                                       | `tests/architecture.test.ts` — no `node:` imports, no spawn/fetch in `src/tools`                            |
| Real coreutils/python3/node/git/curl, real timeouts, real HTTP   | `tests/tools/standard-tools-namespace.test.ts` — **11/11 on the cloud VM kernel**                           |
| Public Internet reachable from the sandbox                       | same suite with `AGENT_TEST_INTERNET=1` — example.com 200, title extracted                                  |
| Exit 0 ≠ success; evaluator judges the real file; loop recovers  | E-005 `tests/tools/e-005-namespace.test.ts` — **6/6 on the cloud VM kernel**                                |
| Same, inside an isolated Docker container (non-root owner, etc.) | `tests/integration/local/standard-tools.test.ts`, `e-005-real-code.test.ts` — **PENDING developer machine** |
| A real model uses the real catalogue                             | E-006 `tests/integration/model/real-model-tools.test.ts` — see `docs/experiments.md`                        |
