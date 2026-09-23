# Flagship V1 roadmap

This is the single canonical roadmap. It is directional: phases sequence responsibilities without pretending that all implementation details are already decided. Deployment remains a separate later decision.

## Phase A — Architecture Foundation

| Sprint / outcome | Scope | Status |
| --- | --- | --- |
| Sprint 0 — Product & Architecture Contract | Freeze product, boundaries, governance, lifecycle, substrate ownership, and roadmap. | Complete (`ARCHITECTURE_CONTRACT_COMPLETE`) |
| Sprint 1 — Engineering Foundation | Establish the local engineering baseline and repository operating foundation. | Complete (`ENGINEERING_FOUNDATION_COMPLETE`) — see [ADR-006](../decisions/ADR-006-local-process-topology-and-engineering-foundation.md) |
| Sprint 2 — Canonical Domain Contracts | Define executable production contracts for workflows, tools, runs, agents, approvals, traces, and evaluation. | Complete (`SPRINT_02_CANONICAL_DOMAIN_CONTRACTS_COMPLETE`) — see [ADR-007](../decisions/ADR-007-canonical-domain-contracts.md) |

## Phase B — Workflow Runtime

Implement workflow DSL, validation and compiler, node registry, runtime executor, and state/reducers.

## Phase C — AI Layer

Implement model abstraction, capability/model routing, and bounded agent runtime.

## Phase D — Tool Infrastructure

Implement tool registry, authorization middleware, and MCP connector layer.

## Phase E — Governance

Implement actor, role, and policy model plus approval engine.

## Phase F — Reliability

Implement error taxonomy, retries and timeouts, durable execution, and idempotency.

## Phase G — Observability

Implement trace runtime, metrics, and audit.

## Phase H — Evaluation

Implement evaluation runtime and CI regression gates.

## Phase I — Workflow Proof

Build and evaluate Company Research, Document Intelligence, and Operational Request.

## Phase J — Portability

Build company configuration system and prove adaptation to a second company.

## Phase K — Product Surface

Build the Operations Control Center and Run Inspector.

## Phase L — Hardening

Run adversarial tests, security work, real-integration gates, and a comprehensive benchmark.

## Stable milestones

| Milestone | Meaning |
| --- | --- |
| `ARCHITECTURE_CONTRACT_COMPLETE` | Product and architecture contract is coherent and canonical. |
| `ENGINEERING_FOUNDATION_COMPLETE` | Local engineering baseline supports intentional implementation. |
| `CORE_CONTRACTS_LOCKED` | Executable core contracts are defined and authoritative. |
| `EXECUTABLE_CORE` | Workflow runtime can execute core contracts. |
| `GOVERNED_EXECUTION` | Policy, approval, and controlled tool execution operate together. |
| `RELIABLE_RUNTIME` | Reliability, recovery, and idempotency requirements are evidenced. |
| `WORKFLOW_PROOF_COMPLETE` | The three proof workflows demonstrate the runtime contract. |
| `TEMPLATE_THESIS_PROVEN` | A second-company adaptation proves portability. |
| `CONTROL_CENTER_COMPLETE` | Operations Control Center and Run Inspector are functional. |
| `FLAGSHIP_BENCHMARKED` | Benchmark and adversarial evidence are complete. |
| `FLAGSHIP_V1_COMPLETE` | Flagship V1 acceptance criteria are met. |
