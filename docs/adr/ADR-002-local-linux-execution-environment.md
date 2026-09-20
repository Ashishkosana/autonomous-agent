# ADR-002 — Local Linux container as the development execution environment

**Status:** accepted (Phase 3B) · **Date:** 2026-09-20 · **Supersedes:** nothing —
complements ADR-001.

## Problem

ADR-001 locks Cloudflare Sandbox as the V1 production execution environment. Real
Cloudflare verification is **DEFERRED — requires Workers Paid** (see ADR-001). The
autonomous runtime still needs a _real_ place to run commands, files and processes
during development, on the developer's Windows machine, for free, without giving the
agent the developer's PowerShell, filesystem or credentials.

## Decision

Add `LocalLinuxEnvironment` (`src/sandbox/local/`) — a second implementation of the
unchanged `ExecutionEnvironment` contract — backed by a **disposable Docker container**
built from a pinned project `Dockerfile`, driven through the **Docker CLI as the trusted
outer controller**. The agent receives only the `ExecutionEnvironment`; it never sees
Docker, the host shell, or the host filesystem.

```
Windows 11 → WSL2 → Docker Desktop (Linux engine)
                          ↓  docker run / exec / inspect / stop / rm   (host side, trusted)
                 disposable container  agent-sandbox-local:0.1.0
                          ↓  sh, coreutils, git, curl, node, python3   (agent side, free)
                 LocalLinuxEnvironment  ──implements──▶  ExecutionEnvironment  ◀── AgentRuntime
```

### Why Docker rather than the WSL distribution or the host

Inspection of the developer machine (2026-09-20): Windows 11 Home, WSL 2.7.13 with
default version 2, `Ubuntu-26.04` and `docker-desktop` distributions, Docker Desktop
4.90.0 running Docker Engine 29.7.2 (`linux/amd64`), Git and Python 3.12 on the host, no
Node on the host.

| Option                                    | Isolation                                                                | Limits                         | Disposable  | Verdict                     |
| ----------------------------------------- | ------------------------------------------------------------------------ | ------------------------------ | ----------- | --------------------------- |
| Host PowerShell / cmd                     | none — the agent would own the developer's machine                       | none                           | no          | rejected (security model)   |
| The developer's `Ubuntu-26.04` WSL distro | shares its filesystem, `/mnt/c` automount, credentials, `.ssh`, dotfiles | only global `.wslconfig`       | no          | rejected (user instruction) |
| A dedicated imported WSL distro           | separate rootfs; `/mnt/c` can be disabled                                | global only; no cap dropping   | unregister  | fallback only               |
| **Docker container (chosen)**             | own mount/pid/net/user namespaces, `--cap-drop ALL`, no host mounts      | `--cpus --memory --pids-limit` | `docker rm` | **chosen**                  |

Docker was already installed and running, so no machine-level change was needed. The same
`docker` CLI exists inside WSL (Docker Desktop integration) and on any Linux host, so one
adapter serves the developer's PC and CI.

## Isolation mechanism and host exposure

Every safety flag is emitted by one pure function, `dockerRunArgs()`
(`docker-cli-runtime.ts`), and asserted by unit tests; the real container is read back
with `docker inspect` in `tests/integration/local/lifecycle.test.ts`.

| Control         | Setting                                                                                                     | Effect                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Host filesystem | **no mounts** (`spec.mounts = []`); `--mount` never emitted by default                                      | the agent sees only the image and its writable layer                                                                |
| Mount policy    | `validateMount()` + `FORBIDDEN_MOUNT_SOURCES`                                                               | `/`, `/etc`, `/home`, `C:\`, `C:\Users`, any user home, Docker socket/pipe are refused                              |
| Docker control  | Docker CLI runs on the host only; socket/pipe never mounted                                                 | the agent cannot create, inspect or escape containers                                                               |
| Privileges      | `--user agent` (uid 10001), `--cap-drop ALL`, `--security-opt no-new-privileges:true`, never `--privileged` | no root, no capabilities, no setuid escalation, no `apt-get`                                                        |
| Network         | `--network bridge` (never `host`); no `--publish`                                                           | private network namespace, outbound Internet via NAT, no inbound ports                                              |
| Environment     | only `LANG`, `PYTHONUNBUFFERED`, `AGENT_SANDBOX` (fixed values)                                             | no host env, no `USERPROFILE`, no tokens; per-call `env` names validated                                            |
| Init            | `--init`                                                                                                    | orphaned background processes are reaped                                                                            |
| Image           | `node:22.23.2-bookworm-slim` + apt `python3 git curl jq procps …`, no Docker client, no cloud CLIs          | reproducible; version pinned in Dockerfile label, `sandbox-spec.ts` and `scripts/sandbox-image.mjs` (test-enforced) |

**Known residual exposure.** Docker Desktop resolves `host.docker.internal` to the host,
so a process in the sandbox can reach services the developer runs on the host's network
interfaces (as any LAN client could). The sandbox has no credentials for them. Blocking
this would require `--network none` or an egress proxy; deferred, documented.

## Resource limits (infrastructure safety, not approval gates)

| Limit                | Value                                                        | Why                                                                              |
| -------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| CPU                  | `--cpus 2`                                                   | enough for `npm install`/builds; leaves the developer's machine responsive       |
| Memory               | `--memory 2g --memory-swap 2g`                               | 2 GiB, **no swap** — a leak is killed by the OOM killer instead of thrashing WSL |
| Processes            | `--pids-limit 256`                                           | stops fork bombs; ample for toolchains                                           |
| Per-command timeout  | `timeoutMs`, default **10 min**, in-container `timeout -k 2` | every command has a deadline; partial output survives; exit 124/137 → `timedOut` |
| Exec client backstop | deadline + kill grace + 10 s                                 | protects against a hung engine; reported as `timedOut`, never thrown             |
| Stop grace           | `--stop-timeout 5`                                           | `stop()` gives the init 5 s before SIGKILL                                       |

## Mapping: `ExecutionEnvironment` → local implementation

All operations are `docker exec` of POSIX scripts from `container-scripts.ts`. Caller
data is always a positional parameter, never interpolated into a script.

| Contract method                | Inside the container                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `runCommand(cmd, opts)`        | `timeout -k 2 <s> sh -c <cmd>` via `docker exec [-i] [-w cwd] [-e K=V]`; stdin piped natively                    |
| `readFile(p)`                  | `cat -- p`; "No such file" → `not_found`, "Permission denied" → `permission_denied`, else `internal`             |
| `writeFile(p, content)`        | `sh -c 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"' sh p` with content on stdin                              |
| `deleteFile(p)`                | `rm -- p`                                                                                                        |
| `fileExists(p)`                | `test -e p` (exit 0/1; other exits are errors)                                                                   |
| `listDirectory(p)`             | `find p -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%f\n'` → `{name, path, type, sizeBytes}`                        |
| `startProcess(cmd)`            | `setsid sh -c 'sh -c "$1"; echo $? > "$2/exit"' … &` → leader PID; bookkeeping in `/tmp/.agent-proc/<id>/`       |
| `stopProcess(id)`              | `kill -s TERM -- -<pgid>`, wait ≤ 2 s, `kill -s KILL -- -<pgid>`; exit 3 = already gone (idempotent)             |
| `getState()`                   | `docker inspect .State.Status` + per-process `/proc/<pid>` / exit-file probe; metadata carries limits and mounts |
| _(lifecycle, not in contract)_ | `start()` = `docker run -d … sleep infinity`; `stop()` = `docker stop`; `destroy()` = `docker rm -f`             |

Semantics deliberately match `CloudflareSandboxEnvironment` (timeout handling, error
codes, `killed` vs `exited`) so `AgentRuntime`, tools and the evaluator cannot tell the
providers apart; the shared contract suite runs against fake, local and Cloudflare.

## Lifecycle and filesystem semantics

```
start()   docker run → container "running", empty /workspace owned by agent
use       exec per operation; files live in the container's writable layer
stop()    docker stop → "exited"; files still inspectable via docker; operations → `unavailable`
destroy() docker rm -f → container and writable layer deleted; getState() → stopped/destroyed
start()   again → a brand-new Linux: previous files, ~/.cache, git config, processes are gone
```

Sandbox-local state is therefore **disposable by construction**. Persistent agent memory
(knowledge, experience, decisions, lessons) must live outside the container, exactly as
ADR-001 concluded for Cloudflare. `tests/integration/local/lifecycle.test.ts` proves the
destroy → recreate freshness on a real engine.

## Networking

Bridge network: private namespace, NAT egress to the Internet (required by future tools
and by TEST 8), no inbound ports. Docker Desktop's DNS is used. `--network none` is
available through `LocalSandboxOptions.network` for offline runs.

## Relationship to CloudflareSandboxEnvironment

Same contract, same semantics, different port: Cloudflare uses `SandboxClient` (SDK
shape, reached through a gateway Worker); local uses `ContainerRuntime` (engine shape,
reached through the Docker CLI). Nothing in `src/agent`, `src/tools`, `src/evaluation`
or `src/memory` imports either (`tests/architecture.test.ts`). Switching environments is
a composition-root choice. Cloudflare code, tests and configuration are unchanged and
remain ready for activation.

## Testing levels and what each proves

| Level                                                     | Where                                                | Proves                                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Unit, `FakeContainerRuntime`                              | `tests/sandbox/local-linux-environment.test.ts`      | contract mapping, argv/flags, mount policy, error mapping, lifecycle states                                                      |
| Real kernel, no engine (`unshare -Urm`, Linux CI/VM only) | `tests/sandbox/local-linux-namespace.test.ts`        | the shell scripts are correct POSIX/GNU (found and fixed `dash` `kill -- -pgid` and `pgrep` self-match bugs) — **not** isolation |
| Real Docker                                               | `tests/integration/local/*` via `npm run test:local` | TEST 1–9, contract suite, lifecycle, E-003; fails (never skips) without Docker                                                   |

## Known limitations

- The Cursor cloud VM that authored this ADR has no Docker; Docker-level claims are
  proven only when `npm run test:local` runs on a machine with Docker (the developer's).
- Non-root user cannot `apt-get`; extra system packages require an image change.
- `--memory-swap` may be ignored with a warning on kernels without swap accounting;
  `docker inspect` in the lifecycle test reports the effective value.
- A command exiting 124/137 on its own at/after the deadline is indistinguishable from a
  timeout (same as ADR-001).
- `host.docker.internal` reachability (see residual exposure).
- Windows hosts need Node ≥ 22 somewhere to run the test suite (WSL Ubuntu or a Windows
  Node install); the sandbox image provides its own Node for the agent.
- `--cpus` fractions, `--pids-limit` and cgroup v2 paths assume a Linux engine (Docker
  Desktop's WSL2 backend qualifies); Windows-container mode is rejected by the gate.
