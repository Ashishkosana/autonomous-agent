# ADR-001 — Cloudflare Sandbox as the V1 execution environment

Status: Accepted
Date: 2026-09-20

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
Cloudflare-specific code is confined to `src/sandbox/cloudflare/` (Phase 3) and the
Worker/API entry point. A test in `tests/architecture.test.ts` fails if any core module
imports a Cloudflare SDK.

## Reason

- One platform for API, coordination, sandbox and storage keeps V1 topology small.
- Sandbox gives the locked requirement — full shell in an isolated Linux boundary —
  without us operating hosts.
- Co-located R2 (objects), a structured store and Vectorize are natural candidates for
  the OPEN storage decisions, though none is chosen by this ADR.

## Tradeoffs

- Platform coupling for deployment and operations; mitigated by the interface boundary.
- Container lifetime, cold starts, resource ceilings and egress behaviour are set by the
  platform and must be measured in Phase 3, not assumed.
- Local development of sandbox behaviour requires Wrangler + Docker; a
  `LocalLinuxEnvironment` implementation of the same contract is the intended fallback
  for tests and offline work.

## Reversibility

Medium. The agent runtime, tools, memory and evaluation depend only on
`ExecutionEnvironment`; replacing the sandbox means writing one new implementation and
passing the shared contract suite (`describeExecutionEnvironmentContract`). Deployment
topology and any Cloudflare-specific storage choices would need their own migration.

## Evidence / experiment

Phase 3 must verify, against a real sandbox: command execution, filesystem round-trip,
Python and Node execution, dependency installation, outbound HTTP, and background
process start/stop. Results will be appended here.
