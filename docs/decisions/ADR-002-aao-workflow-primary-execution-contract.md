# ADR-002: AAO workflow as the primary execution contract

Status: accepted

## Context

AAO needs stable workflow semantics while retaining the option to use and replace execution infrastructure.

## Decision

AAO owns workflow specifications, validation, compilation, node semantics, run lifecycle, state contracts, and canonical runtime events. Execution engines are adapters. LangGraph.js is the current candidate beneath a compiler/runtime boundary according to [ADR-000](ADR-000-substrate-recommendation.md); it must not become AAO's public workflow contract.

## Consequences

Framework types remain behind adapters. Production workflow DSL and compiler implementation are deferred to later sprints. Research prototypes are evidence only and are not automatically promoted to the production contract.
