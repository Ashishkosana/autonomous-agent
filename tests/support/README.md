# Test support adapters

Everything in this directory exists **only** to exercise the contracts under
`src/` in isolation. None of it is production architecture:

- `FakeExecutionEnvironment` is not an execution environment; Phase 3 adds Cloudflare Sandbox.
- `InMemoryMemoryStore` and `KeywordOnlyRetriever` are not the persistence or retrieval design; Phase 4 decides those (ADR-003 / ADR-004).
- `ScriptedModelProvider` is not a model; the provider is an OPEN decision (ADR-002).
- `InMemoryEventBus` is not the event transport; that decision is OPEN.

Nothing under `src/` may import from this directory (enforced by `tests/architecture.test.ts`).
