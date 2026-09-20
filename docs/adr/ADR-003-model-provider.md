# ADR-003 — Model provider: a vendor-neutral OpenAI-compatible adapter behind `ModelProvider`

**Status:** accepted (Phase 4) — adapter architecture; **E-004 executed against a real local
model** (Ollama `qwen2.5:3b` on the Cursor cloud VM, `AGENT_MODEL_TOOL_MODE=json`: 3/3 runs
4-of-4 passed, goal completed autonomously in 1 of 3 — see `docs/experiments.md` E-004;
under owner review, developer-machine reproduction pending). · **Date:** 2026-09-20 ·
**Relates to:** ADR-001, ADR-002 (same "contract + swappable adapter" pattern).

## 1. Context

Phases 1–3B proved the autonomous loop with a scripted model (`ScriptedModelProvider`) and
real execution environments. The runtime already talks to intelligence only through
`ModelProvider` (`src/models/contracts.ts`): `generate`, `structuredGenerate` (returns a
`ParseResult`, never throws on bad content) and `requestToolAction` (sees tool
_descriptors_, never executable tools). Phase 4 puts a real model behind that contract.

Constraints from the project owner:

- no permanent lock-in to OpenRouter, Groq, Google, OpenAI, Ollama or any vendor;
- no paid infrastructure, and the concrete free model/provider is chosen _after_ the
  adapter exists;
- no third-party runtime dependencies in `src/` (the existing architecture rule stands);
- API keys must never enter the sandbox, memory, events, logs, commits or error text;
- malformed model output must be a recoverable error, never a crash;
- every model call observable with safe telemetry.

## 2. Decision

1. **One wire format, many vendors.** The first real adapter,
   `OpenAICompatibleProvider` (`src/models/openai-compatible/`), speaks the OpenAI
   _chat-completions_ HTTP format using the platform `fetch`. This single format is served
   by OpenAI, OpenRouter, Groq, Together, Mistral, DeepSeek, Fireworks, Ollama, LM Studio,
   vLLM and llama.cpp servers — hosted and local, paid and free. The adapter does not know
   which company runs the endpoint; the operator names an **endpoint**, not a vendor.
2. **Configuration, not code, selects the model.** `resolveModelConfig(env)`
   (`src/models/config.ts`) reads `AGENT_MODEL_*` variables into a discriminated
   `ModelProviderConfig` (`none | openai-compatible`); `createModelProvider(config, deps)`
   instantiates it. Adding a differently-shaped provider (e.g. a native Anthropic or Gemini
   format) means a new union member and adapter directory — the runtime does not change.
3. **Pure translation, thin transport.** `wire.ts` is pure functions over plain data
   (request bodies, envelope validation, finish-reason/usage mapping, JSON extraction, tool
   name mangling, proposal parsing); `provider.ts` owns only HTTP, timeouts, error mapping
   and credential containment. This keeps the vendor-shaped code unit-testable without a
   network and keeps the network code small.
4. **Structured output has three modes** because servers differ: `json_schema`
   (`response_format` with the schema; OpenAI-strict servers), `json_object` (schema folded
   into the prompt, JSON mode enforced) and `prompt` (instruction only; smallest servers).
   All three end in the same runtime-owned `parse()`; the mode only changes how hard the
   server is asked to comply.
5. **Tool actions have two modes.** `tools` uses native function calling: each
   `ToolDescriptor` becomes a function whose parameters wrap the tool's own schema under
   `input` alongside `rationale` / `confidence` / `alternatives`, plus `finish` and
   `give_up` pseudo-functions, with `tool_choice: required`. Names are mangled to the wire
   alphabet bijectively (`fs.write` → `fs__write`) and translated back. `json` mode asks
   for a JSON proposal instead, for servers without function calling. A text answer
   containing a JSON proposal is accepted in either mode.
6. **Recovery is layered and bounded.** `ResilientModelProvider` wraps any provider:
   transient failures (`rate_limited`, `network`, `timeout`, `server`) are retried with
   exponential backoff or `Retry-After`, at most `maxRetries`; invalid answers (schema
   violation, no tool call) are re-asked at most `maxReasks` times with the rejected answer
   and the validation errors appended. `authentication`, `configuration` and
   `bad_request` are never retried. After the budget the failure is returned (structured:
   `ParseResult` failure) or thrown (`invalid_response`) and the runtime ends the run as
   `failed` with cause `unrecoverable` — a controlled outcome, not a crash.
7. **Telemetry is per attempt.** The composition root builds
   `Resilient(Instrumented(provider))`, so every attempt emits `MODEL_CALL_STARTED` then
   `MODEL_CALL_COMPLETED` (usage, latency, finish reason, `usageReported`) or
   `MODEL_CALL_FAILED` (error kind, redacted message, retryable) with one `modelCallId`
   owned by the instrumentation layer. Model calls count against `maxModelCalls` when they
   _start_: a timed-out call still consumed a call. Payloads carry metadata only — never
   prompts or completions.
8. **Credential containment is structural, not a convention.**
   - the key is read from `AGENT_MODEL_API_KEY` by the composition root only (`src/` never
     reads `process.env` — enforced by a test);
   - the provider stores request headers in a module-level `WeakMap`, so enumeration,
     `util.inspect`, spread and `JSON.stringify` of the provider cannot surface them
     (`toJSON` returns the descriptor);
   - `SecretRedactor` removes the configured key and extra-header values, plus
     credential-shaped strings (`Bearer …`, `sk-…`, `api_key=…`), from every error message
     the adapter throws — including a server that echoes the key back;
   - `describeModelConfig` reports `apiKeyConfigured: boolean`, never the value;
   - tests assert the key is absent from requests' URL/body, responses, events, memory
     records and sandbox files.

## 3. Alternatives considered

| Alternative                                              | Why not (now)                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor SDKs (`openai`, `@anthropic-ai/sdk`, …)           | Violates the no-third-party rule for core code; each SDK is a lock-in surface; `fetch` + one wire format covers the same servers                                    |
| Native Anthropic / Gemini formats first                  | Both vendors also expose OpenAI-compatible endpoints or are reachable through gateways that do; a native adapter is a later union member if a chosen model needs it |
| Retry/re-ask inside the adapter                          | Would make every future adapter re-implement it; as a decorator it is provider-agnostic and observable per attempt                                                  |
| Instrumentation outside resilience (one event/call)      | Hides failed attempts from the dashboard and under-counts calls against limits                                                                                      |
| Putting `rationale` in assistant text next to tool calls | Many servers drop assistant content when returning tool calls; wrapping under `input` + `rationale` gives a validated rationale from every server                   |
| Letting the runtime crash on malformed output            | Rejected by the brief: malformed output must be recoverable; the runtime already treats component exceptions as `unrecoverable` and ends the run cleanly            |

## 4. Consequences

- The runtime is vendor-agnostic by construction; `tests/architecture.test.ts` keeps it so
  (no vendor imports in core, `fetch` confined to two named adapters, no `process.env` in
  `src/`, an explicit — currently empty — third-party allowlist that can never name a core
  directory, and the provider never retaining `apiKey` as a property).
- `ScriptedModelProvider` remains the deterministic model for the loop tests; the same
  E-000 scenario is additionally replayed through the real adapter over a real local HTTP
  server (`tests/runtime/wire-adapter-loop.test.ts`), so the two providers are proven
  interchangeable.
- `ModelRequest.attempt` is telemetry-only metadata set by the resilience layer; providers
  ignore it.
- Usage accounting is honest: servers that omit `usage` yield zeros with
  `usageReported: false` rather than invented counts.
- Limits: tool descriptions on the wire include the family; long tool catalogues cost
  tokens on every `select_action` call. Prompt size management is a later concern (Phase 8).

## 5. Verification levels

| Level                               | Where                                                                                                                                        | What it proves                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (pure)                         | `tests/models/wire.test.ts`, `config.test.ts`, `errors-and-redaction.test.ts`, `resilient-provider.test.ts`, `instrumented-provider.test.ts` | Translation, validation, name mangling, retry/re-ask policy, telemetry records, redaction                                                                          |
| Integration, real HTTP, fake server | `tests/models/openai-compatible-provider.test.ts`                                                                                            | Transport, headers, timeouts, every HTTP status mapping, credential containment on the real `fetch` path                                                           |
| Loop over the wire                  | `tests/runtime/wire-adapter-loop.test.ts`                                                                                                    | E-000 through the real adapter: same recovery story, paired telemetry, re-ask/retry composed with the loop                                                         |
| **Real model**                      | `tests/integration/model/` via `npm run test:model`                                                                                          | Live endpoint answers in valid form and can drive the loop — **executed with Ollama `qwen2.5:3b` (E-004)**: `tools` mode flattened by 3B models, `json` mode works |

## 6. What remains open

- **Which model/endpoint** to use for V1 runs. E-004 shows a 3B local model is at the edge
  of competence (1 completion in 3 runs; plans grow on every revision). Candidates: a larger
  local model if the developer machine allows, or a free hosted tier (OpenRouter `:free`,
  Groq, Google AI Studio's OpenAI-compatible endpoint) — all reachable by configuration only.
- `tools` mode: two small models flattened the `{input, rationale}` wrapper (E-004). Whether
  to accept flattened arguments, move `rationale` elsewhere, or default to `json` mode is
  decided after Phase 5 provides more tool and model evidence — not for one model.
- The JSON-mode proposal schema is a flat union; a discriminated `anyOf` would let
  schema-enforcing servers require `toolName` for `kind: "tool"`.
- Prompt-size control and per-purpose model routing (e.g. cheaper model for
  `summarize`) — later phases, behind the same contract.
