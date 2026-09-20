# ADR-001: Hybrid workflow-agent architecture

Status: accepted

## Context

Operational AI needs reliable workflow structure and can sometimes benefit from open-ended reasoning. Treating every task as an autonomous agent gives models too much execution authority; treating every task as purely deterministic blocks useful interpretation and synthesis.

## Decision

AAO adopts a hybrid workflow-agent architecture. A workflow is the primary execution unit. Agents are optional, bounded components inside workflows, used only when genuine open-ended work benefits from planning, research, decomposition, or synthesis.

Deterministic AAO software owns validation, stable routing, permissions, authorization, approval requirements, state transitions, retry ceilings, budgets, timeouts, policy enforcement, and final authority for external actions. A model or agent may propose an action but cannot authorize itself.

## Consequences

Workflow definitions, nodes, and lifecycle semantics are first-class AAO concerns. Multi-agent design is not a default and requires measurable benefit over a workflow or a single bounded agent. The initial proof workflows apply this decision differently: Company Research is bounded-agentic, Document Intelligence is deterministic with selective model nodes, and Operational Request is governed operational execution.
