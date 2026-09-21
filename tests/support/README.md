# Test support adapters

Everything in this directory exists **only** to exercise the contracts under
`src/` in isolation. None of it is production architecture:

- `FakeExecutionEnvironment` is not an execution environment; the real ones are `LocalLinuxEnvironment` (ADR-002) and `CloudflareSandboxEnvironment` (ADR-001). `NamespaceContainerRuntime` runs the real adapter on the host kernel without Docker — real interpreters, no isolation.
- `InMemoryMemoryStore` is not the persistence design; `SqliteMemoryStore` is (ADR-005). Both must pass `memory-store-contract.ts`. Retrieval uses the production `LexicalRetriever` directly.
- `ScriptedModelProvider` is not a model; `OpenAICompatibleProvider` behind `ModelProvider` is (ADR-003).
- `InMemoryEventBus` is not the event transport; that decision is OPEN (ADR-008).

Nothing under `src/` may import from this directory (enforced by `tests/architecture.test.ts`).
