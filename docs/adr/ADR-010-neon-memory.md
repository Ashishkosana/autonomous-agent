# ADR-010 — Neon Postgres for durable memory

Status: Accepted
Date: 2026-09-28

## Problem

SQLite (ADR-005) keeps memory on a local disk. A Hugging Face Space container
is replaced on restart and on sleep, so a file inside it is not memory across
runs. The agent still must not train foundation-model weights. What has to
survive is the records it already writes: knowledge, experience, decision,
lesson, their vectors, and the counters used to compare two runs.

## Requirements

- The `MemoryStore` and `SemanticIndex` contracts stay the ones the runtime
  already uses.
- `src/` does not read `process.env`. The connection string is resolved at a
  composition root and passed in.
- One process has one memory backend. No dual-write.
- SQLite remains the local and CLI default.
- Live tests can be skipped without a database, and `npm run test:neon` fails
  if the connection string is missing.
- Errors that leave the process must not contain the connection string or the
  password.

## Options considered

1. Keep SQLite only, and mount a volume on the Space. Free Spaces do not offer
   a durable volume that survives a rebuild, and a file is still one machine.
2. `@neondatabase/serverless` over HTTP `fetch`. `fetch` in `src/` is confined
   to two adapters by an architecture test. Adding a third egress path for
   memory was a worse fit than the Postgres wire protocol.
3. Dual-write SQLite and Postgres. Two sources of truth, and a Space restart
   would still have to decide which one won.
4. Postgres through `pg`, opened only from `src/adapters/neon/`, selected by
   `AGENT_MEMORY_BACKEND=neon`.

## Decision

Option 4. `NeonDatabase` implements the same open handle the SQLite backend
does: a `MemoryStore`, a `SemanticIndex`, plus `recordEfficiency` /
`latestEfficiency` for run counters. Schema version 1 is applied in one
transaction under an advisory lock. The JSON body remains the source of truth.
Vectors are float32 `bytea`. Cosine similarity is computed in process, the
same function SQLite uses. There is no pgvector dependency.

Connection string order: `AGENT_MEMORY_URL`, then `NEON_DATABASE_URL`, then
`DATABASE_URL`. The CLI still defaults to `./.agent/memory.sqlite` when the
backend is unset. A Space with a URL and no backend selects Neon. A Space
with neither uses `/tmp/agent-memory/memory.sqlite` and says so on the page.

`deleteAll()` truncates the agent tables. Tests and operators must point it
at a dedicated database.

## Reason

The runtime, retriever, and ingestor do not change. A later run on a new
Space container can still query records written by an earlier container.
Efficiency is a comparison of stored counters, not a new learning algorithm.

## Tradeoffs

- `pg` is a third-party import. It is allowlisted on
  `src/adapters/neon/pg-client.ts` only. Core directories stay free of it.
- Brute-force cosine does not scale to millions of vectors. That is the same
  limit ADR-006 accepted for one agent's records.
- A public Space is not an isolated sandbox (see the Space README). Neon
  credentials must be Space secrets.
- Local development without Docker still uses SQLite. Neon is optional until
  the operator sets the backend.

## Reversibility

Set `AGENT_MEMORY_BACKEND=sqlite`. The contracts do not mention Neon. Dropping
the adapter removes the dependency. Existing SQLite files are untouched.

## Evidence / experiment

`tests/support/memory-store-contract.ts` runs against Neon when a connection
string is set (`tests/integration/neon/neon.test.ts`). Without one, the suite
skips. `npm run test:neon` refuses to pass without one.

E-010 (`docs/experiments.md`) is the cold-then-warm measurement. The scripted
pair in `npm test` shows the counters moving. It does not claim that a real
model improved, and it does not train weights.
