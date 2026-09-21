# Architecture Decision Records

One file per significant decision, numbered in the order the decision was made.
An ADR is written when a decision is taken, not before. OPEN decisions are listed in
`docs/architecture.md` and have no ADR yet.

| ADR                                                     | Title                                                          | Status                                              |
| ------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| [ADR-001](ADR-001-cloudflare-sandbox.md)                | Cloudflare Sandbox as V1 execution environment                 | Accepted; real verification DEFERRED (Workers Paid) |
| [ADR-002](ADR-002-local-linux-execution-environment.md) | Local Linux container as the development execution environment | Accepted; verified on real Docker                   |
| [ADR-003](ADR-003-model-provider.md)                    | Vendor-neutral OpenAI-compatible model adapter                 | Accepted; E-004 executed with a real local model    |
| [ADR-004](ADR-004-standard-tools.md)                    | Standard tools acting only through `ExecutionEnvironment`      | Accepted; proven on real Linux, Docker run pending  |
| ADR-005                                                 | Structured memory storage                                      | Open (Phase 6)                                      |
| ADR-006                                                 | Semantic retrieval                                             | Open (Phase 7)                                      |
| ADR-007                                                 | Browser runtime (and web search backend)                       | Open (Phase 9)                                      |
| ADR-008                                                 | Event transport and dashboard backend                          | Open (Phase 10)                                     |
| ADR-009                                                 | Living Flame growth formula                                    | Open (Phase 12)                                     |

## Template

```
# ADR-NNN — Title

Status: Proposed | Accepted | Superseded by ADR-MMM
Date: YYYY-MM-DD

## Problem
## Requirements
## Options considered
## Decision
## Reason
## Tradeoffs
## Reversibility
## Evidence / experiment
```
