# ADR-005 — Structured memory storage: SQLite via `node:sqlite`, local filesystem for objects

Status: Accepted; proven across processes and sandboxes (E-007)
Date: 2026-09-21

## Problem

Phases 1–5 stored memory in a `Map` that died with the test. The agent's research
question — does experience persisted in one run change a later run — needs records that
outlive the process, the sandbox and the machine's uptime, and artifacts that outlive the
sandbox they were produced in. The `MemoryStore` and `PersistentStorage` contracts existed
(`src/memory/store.ts`, `src/storage/persistent-storage.ts`); this decision picks their
first real backends.

## Requirements

- Durable: records written by one process are read back byte-for-byte by another.
- The four logical categories stay logical (working / knowledge / experience / decision);
  `lesson` remains a storage-level discriminator for a derived record, not a fifth category.
- Field-level record schemas are still OPEN, so the backend must not need a migration each
  time a field is added.
- Metadata filtering (`kinds`, `runId`, `goalId`, all-of `tags`, `createdAfter`, `limit`)
  must be a real index, not a full scan of JSON blobs — it is the first retrieval stage.
- Zero paid infrastructure; no third-party dependency in core `src/` (dependency policy);
  works on the developer's WSL2 machine and in the cloud VM.
- Honest failure: corruption is reported, never returned partially; configuration errors
  name the variable to set.
- Nothing in `src/agent/` may know which backend is in use.

## Options considered

| Option                                           | Verdict                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JSON files, one per record                       | Durable and dependency-free, but every query is a directory scan and a parse; tags/kinds cannot be indexed; concurrent writes need our own locking.                                                          |
| SQLite through a third-party binding             | Mature, but violates the dependency policy for a core directory and adds a native build step.                                                                                                                |
| **SQLite through Node's built-in `node:sqlite`** | Zero dependencies, real indexes, transactions, a single file that is trivially copied, inspected with any sqlite3 client, or deleted to forget. Node ≥ 22.13 unflagged; still labelled experimental by Node. |
| Cloudflare D1 / KV / R2 now                      | The production candidates, but paid-plan and network dependent; the same contracts map onto them later without touching callers.                                                                             |
| Postgres / hosted database                       | Operationally heavy for a single-agent V1 and paid when hosted.                                                                                                                                              |

For objects: a local directory (`FilesystemStorage`) now; Cloudflare R2 remains the
natural production backend behind the same `PersistentStorage` contract.

## Decision

1. **`SqliteMemoryStore`** (`src/memory/sqlite/sqlite-memory-store.ts`) over `node:sqlite`.
   One row per record: the **full record as JSON is the source of truth**; the indexed
   columns (`kind`, `run_id`, `goal_id`, `task_id`, `created_at`, `summary`, insertion
   `seq`) and a `memory_record_tags` table are a query index derived from it on write.
   Field-level schemas can therefore evolve without a migration; only the shared base that
   `assertStorableRecord` guards is fixed. `schema_meta.schema_version = 1`; a file from an
   incompatible version is refused at open. WAL journal, `foreign_keys = ON`,
   `busy_timeout = 5 s`. One agent process writes at a time (V1 shape).
2. **Contract, enforced by one suite over every backend**
   (`tests/support/memory-store-contract.ts`, run over the test store and SQLite in-memory
   and on-disk): validated puts; `put` is an upsert by `recordId` that keeps the record's
   position; results oldest-first by `createdAt` with stable ties; `count` ignores `limit`;
   inputs are never aliased; a **record id owned by a different run cannot be overwritten**
   (`MemoryStoreError('conflict')`).
3. **`FilesystemStorage`** (`src/storage/local/filesystem-storage.ts`): bodies under
   `<root>/objects/<key>`, metadata JSON under `<root>/metadata/<key>.json`, both written
   via temp-file + rename. Keys follow a strict grammar (`src/storage/keys.ts`:
   `/`-separated `[A-Za-z0-9][A-Za-z0-9._-]*` segments, no `.`/`..`, ≤ 512 chars) that maps
   onto a filesystem path, an R2/S3 object name or a database column without escaping;
   resolved paths are re-checked against the root. `archiveArtifacts`
   (`src/storage/archive.ts`) promotes sandbox artifacts into storage and emits
   `ARTIFACT_STORED`, outside the runtime loop — the composition root decides what to keep.
4. **`LexicalRetriever`** (`src/memory/lexical-retriever.ts`) is the production retriever:
   metadata filter through the store, then distinct-term overlap; deterministic ranking
   (score, newer first, record id); `signalsUsed = ['metadata', 'keyword']`, `semantic`
   never claimed. The test-only retriever was removed; every scenario now uses this one.
5. **Ids that reach durable storage come from `UniqueIdGenerator`**
   (`src/domain/unique-ids.ts`, 80 bits of Web-Crypto randomness behind the readable
   prefix). The deterministic `SequentialIdGenerator` is test-only.
6. **Configuration** via composition roots (`src/memory/config.ts`, `src/storage/config.ts`):
   `AGENT_MEMORY_BACKEND=sqlite` + `AGENT_MEMORY_PATH`, `AGENT_STORAGE_BACKEND=filesystem`
   - `AGENT_STORAGE_ROOT`. Unset means _no persistent memory/storage configured_ — never
     a silent default file.
7. **Architecture rules** (`tests/architecture.test.ts`): `node:sqlite` only in the SQLite
   store; `node:fs` only in the filesystem storage; `src/agent/` never imports
   `memory/sqlite`, `memory/config`, `storage/local` or `storage/config`.

## Reason

The JSON-body-plus-index layout gives durable, indexed, transactional storage with no
dependency and no migration burden while the record schemas are still moving. Keeping the
body whole also keeps the store honest about fidelity: what comes out is exactly what went
in (the contract suite checks `toEqual` on every kind, including nested provenance and
Unicode). The `conflict` rule turns a class of silent data loss into a loud error.

## Tradeoffs

- `node:sqlite` prints `ExperimentalWarning` on Node 22 and its API surface may still
  change; the store uses only `DatabaseSync.exec/prepare/close` and
  `StatementSync.run/get/all` to keep exposure minimal.
- Metadata filtering is indexed but lexical scoring is in-process over the filtered
  candidates (bounded by `maxCandidates`, default 2000); the semantic index (ADR-006) is
  the seam for scale and meaning.
- Single-writer. Multi-agent or multi-machine memory is a later decision (D1/R2 or a
  server) behind the same contracts.
- Upsert by the owning run means a later run can only _add_ records, not edit Run 1's —
  except through records that preserve the original `runId` (how Phase 8 will bump
  `LessonValidation` counters).

## Reversibility

High. Both backends sit behind existing interfaces with contract suites; replacing them is
a new adapter plus a config union member. The SQLite file itself is portable and readable
by any SQLite tool.

## Evidence / experiment

- `tests/memory/store-contract.test.ts` — 24 contract cases × {test store, SQLite
  `:memory:`, SQLite file}.
- `tests/memory/sqlite-memory-store.test.ts` — reopen-and-read-back on a real file
  (order preserved via persisted `seq`), closed-handle behaviour, schema-version refusal,
  corrupt body / mismatched identity refused, failed write leaves nothing behind,
  unopenable path is a configuration error.
- `tests/storage/filesystem-storage.test.ts` — storage contract (6 cases), no writes
  outside the root and no temp files, metadata identity check, `archiveArtifacts` with a
  stored/failed/skipped mix and `ARTIFACT_STORED` payloads.
- `tests/memory/lexical-retriever.test.ts` — ranking, stopwords, empty queries return
  nothing, metadata filter first, deterministic ties, identical ranking over both stores.
- **E-007** (`tests/memory/e-007-cross-process.test.ts`, `docs/experiments.md`) — two child
  OS processes, two fresh Linux sandboxes, one SQLite file and one storage directory:
  Run 2 retrieved exactly Run 1's five records, the planner was shown the lesson text and
  the plan cites the lesson; Run 1's report was read back from storage after its sandbox
  was destroyed. E-007 also **found** the id-collision defect that decision 5 and the
  `conflict` rule fix.
- **E-007b** (`tests/integration/model/real-model-memory.test.ts`) — the same two-run
  design with a real local model; results in `docs/experiments.md`.
