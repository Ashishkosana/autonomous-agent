# Architecture Decision Records

One file per significant decision, numbered in the order the decision was made.
An ADR is written when a decision is taken, not before. OPEN decisions are listed in
`docs/architecture.md` and have no ADR yet.

| ADR                                                     | Title                                                          | Status                                              |
| ------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| [ADR-001](ADR-001-cloudflare-sandbox.md)                | Cloudflare Sandbox as V1 execution environment                 | Accepted; real verification DEFERRED (Workers Paid) |
| [ADR-002](ADR-002-local-linux-execution-environment.md) | Local Linux container as the development execution environment | Accepted; verified on real Docker                   |
| [ADR-003](ADR-003-model-provider.md)                    | Vendor-neutral OpenAI-compatible model adapter                 | Accepted; real-model verification PENDING           |
| ADR-004                                                 | Structured memory storage                                      | Open (Phase 6)                                      |
| ADR-005                                                 | Semantic retrieval                                             | Open (Phase 7)                                      |
| ADR-006                                                 | Browser runtime                                                | Open (Phase 9)                                      |
| ADR-007                                                 | Event transport and dashboard backend                          | Open (Phase 10)                                     |
| ADR-008                                                 | Living Flame growth formula                                    | Open (Phase 12)                                     |

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
