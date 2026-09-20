# ADR-004: Deterministic governance and side-effect authority

Status: accepted

## Context

Model output is not sufficient authority for real operational actions. External and destructive changes require deterministic controls and accountable approval.

## Decision

Models and agents may propose actions. Deterministic AAO execution infrastructure validates schema, authorizes the actor, enforces policy and approval requirements, applies idempotency/replay protections, executes, verifies, and audits. Initial V1 requires human approval before every `external_side_effect`; `destructive` actions require explicit human confirmation and have no autonomous execution path.

## Consequences

Tool execution must not bypass governance. Sensitive data receives least-privilege access, data minimization, controlled trace logging, and explicit handling policy. Durable external effects need an idempotency and recovery design; AAO does not claim exactly-once semantics.
