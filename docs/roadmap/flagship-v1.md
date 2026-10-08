# Flagship V1 roadmap

This is the single canonical roadmap. It is directional: phases sequence responsibilities without pretending that all implementation details are already decided. Deployment remains a separate later decision.

## Phase A — Architecture Foundation

| Sprint / outcome | Scope | Status |
| --- | --- | --- |
| Sprint 0 — Product & Architecture Contract | Freeze product, boundaries, governance, lifecycle, substrate ownership, and roadmap. | Complete (`ARCHITECTURE_CONTRACT_COMPLETE`) |
| Sprint 1 — Engineering Foundation | Establish the local engineering baseline and repository operating foundation. | Complete (`ENGINEERING_FOUNDATION_COMPLETE`) — see [ADR-006](../decisions/ADR-006-local-process-topology-and-engineering-foundation.md) |
| Sprint 2 — Canonical Domain Contracts | Define executable production contracts for workflows, tools, runs, agents, approvals, traces, and evaluation. | Complete (`SPRINT_02_CANONICAL_DOMAIN_CONTRACTS_COMPLETE`) — see [ADR-007](../decisions/ADR-007-canonical-domain-contracts.md) |

## Phase B — Workflow Runtime

Implement workflow DSL, validation and compiler, node registry, runtime executor, Run lifecycle, Node lifecycle, authoritative state management, and safe execution snapshots.

| Sprint / outcome | Scope | Status |
| --- | --- | --- |
| Sprint 3 — Workflow DSL, Semantic Validation & Compiler | Author workflows as YAML/JSON, validate them against canonical schema plus graph-level semantics (reachability, termination, routing, cycles), and compile a valid workflow into a framework-neutral `CompiledWorkflowPlan`. | Complete (`SPRINT_03_WORKFLOW_DSL_COMPILER_COMPLETE`) — see [ADR-008](../decisions/ADR-008-workflow-dsl-and-compiler.md) |
| Sprint 4 — Node Registry & Runtime V1 | Node Registry and the first deterministic execution runtime over a `CompiledWorkflowPlan`: runtime preflight, sequential unconditional routing, explicit state-patch application, and a structured failure taxonomy. | Complete (`SPRINT_04_RUNTIME_V1_COMPLETE`) — see [ADR-009](../decisions/ADR-009-node-registry-and-runtime-v1.md) |
| Sprint 5 — Managed Run State, Lifecycle & Execution Snapshots | Authoritative Run lifecycle and Node lifecycle, an explicit clock boundary, revisioned state kept as the single source of truth, and safe in-memory execution snapshots at every safe execution boundary — recovery-ready, not durable. | Complete (`SPRINT_05_MANAGED_RUNTIME_STATE_COMPLETE`) — see [ADR-010](../decisions/ADR-010-managed-runtime-state-and-lifecycle.md) |

## Phase C — AI Layer

Implement model abstraction, capability/model routing, and bounded agent runtime. Complete.

| Sprint / outcome | Scope | Status |
| --- | --- | --- |
| Sprint 6 — Model Abstraction & Capability Routing | Provider-neutral `@aao/model-runtime`: validated text/structured model requests and results, explicit Model and Model Policy registries, deterministic capability routing (no fallback/retry), a Vercel AI SDK adapter over an injected model, and an explicitly registered `model` node executed by the managed Runtime. | Complete (`SPRINT_06_MODEL_RUNTIME_COMPLETE`) — see [ADR-011](../decisions/ADR-011-model-runtime-and-capability-routing.md) |
| Sprint 7 — Bounded Agent Runtime | `@aao/agent-runtime`: canonical `AgentSpec` + registered instructions/limits, explicit Agent Registry, a deterministic controller over at most `maxIterations` (≤ 16) Model Runtime invocations returning structured `CONTINUE`/`COMPLETE` decisions, an explicitly registered atomic `agent` node, and a generic safe executor-failure protocol. No tools, skills, delegation, memory, persistence, retries, fallback, or Reflexion. | Complete (`SPRINT_07_BOUNDED_AGENT_RUNTIME_COMPLETE`) — see [ADR-012](../decisions/ADR-012-bounded-agent-runtime.md) |

## Phase D — Tool Infrastructure

Complete: Tool Registry, safe Tool execution, deterministic Authorization, and the isolated MCP connector boundary.

| Sprint / outcome | Scope | Status |
| --- | --- | --- |
| Sprint 8 — Tool Registry & Safe Tool Execution Boundary | `@aao/tool-runtime`: canonical `ToolSpec` + trusted handler binding, explicit version-exact Tool Registry with strict Ajv schema compilation at registration, one `executeTool` path (request → registry → permission support gate → input schema → handler once → output JSON safety + schema → `ToolResult`), redacted handler failures, deterministic workflow-owned Tool execution ids, and an explicitly registered `tool` node. Only `read_only`/`write_draft` Tools execute; the support gate is not authorization. No MCP, connectors, credentials, Agent Tool use, side effects, retries, or persistence. | Complete (`SPRINT_08_TOOL_RUNTIME_COMPLETE`) — see [ADR-013](../decisions/ADR-013-tool-registry-and-safe-execution-boundary.md) |
| Sprint 9 — Authorization & Permission Enforcement Boundary | `@aao/authorization`: host-attested `AuthorizationContext` (principal + explicit grants + optional Agent ceiling from the registered `AgentSpec`), one pure deterministic `authorize()` evaluator (`required ⊆ grants ∩ ceiling`, no hierarchy, no superuser, safe reason codes), enforced inside `executeTool` after the support gate and before input validation. Tool Node gets its context from a trusted host resolver; the public Tool Registry is inspection-only. No authentication, roles, policy DSL, approvals, Agent Tool use, MCP, or side effects. | Complete (`SPRINT_09_AUTHORIZATION_BOUNDARY_COMPLETE`) — see [ADR-014](../decisions/ADR-014-authorization-and-permission-enforcement.md) |
| Sprint 10 — MCP Integration Boundary & Tool Adapter Sessions | `@aao/mcp-connector`: explicit stdio client/server sessions, bounded Tools discovery, trusted host-owned canonical Tool bindings, structured output normalization, safe errors, and the existing `executeTool` support/authorization/validation path. Real SDK stdio, zero-call rejection gates, generic workflow integration, and compiled smoke verified. No HTTP, OAuth, Agent Tool use, retries, or persistence. | Complete (`SPRINT_10_MCP_INTEGRATION_BOUNDARY_COMPLETE`) — see [ADR-015](../decisions/ADR-015-mcp-integration-boundary-and-tool-adapter-sessions.md) |

## Phase E — Governed execution

| Sprint / outcome | Scope | Status |
| --- | --- | --- |
| Sprint 11 — Actor, Role & Policy Governance | Host-attested actors, explicit role bindings, deterministic deny policies, resolved authority feeding existing Authorization. | Complete (`SPRINT_11_GOVERNANCE_MODEL_COMPLETE`) — see [ADR-016](../decisions/ADR-016-actor-role-policy-governance.md) |
| Sprint 12 — Approval Engine | Process-local exact-request human approval waitpoints, eligible resolver checks (trusted identity + required role membership, corrected in the Sprint 13 closure gate), and validated in-process continuation; no real external effects or durable recovery. | Complete (`SPRINT_12_APPROVAL_ENGINE_COMPLETE`) — see [ADR-017](../decisions/ADR-017-human-approval-and-runtime-waitpoints.md) |
| Sprint 13 — Reliability Runtime | One Runtime-owned Reliability Controller: trusted hard-capped per-Node policies (default one attempt), a single structured failure taxonomy, explicit retry safety (only `read_only` Tools declared safe), per-attempt timeouts with cooperative `AbortSignal`, commit-on-success, late-result protection, and bounded attempt evidence. Process-local; no durable retries, idempotency, side-effect retry, tracing, or persistence. | Complete (`SPRINT_13_RELIABILITY_RUNTIME_COMPLETE`) — see [ADR-018](../decisions/ADR-018-runtime-reliability-and-bounded-retries.md) |
| Sprint 14 — Durable Execution | `@aao/durability`: storage-neutral `DurabilityStore` plus a local single-host/single-writer filesystem store with atomic writes. Contents: plan-fingerprint-bound Run identity; immutable safe-boundary `DurableCheckpoint`s (the `CheckpointRecord` placeholder deleted); write-ahead operation intent and outcome-first persistence; accepted-outcome recovery without executor replay; bounded crash replay only for trusted recovery-safe operations (`toolExecutionId` + `idempotency: "execution_id"` for `write_draft`); durable retry accounting; repository-backed durable Approvals with CAS resolution and revalidation; safe-boundary cancellation; a three-process restart smoke. One Runtime loop via `resumeWorkflow`. No exactly-once claim, queue, distributed workers, tracing, or side-effect enablement. | Complete (`SPRINT_14_DURABLE_EXECUTION_COMPLETE`) — see [ADR-019](../decisions/ADR-019-durable-execution-checkpoints-and-replay.md) |

## Forward roadmap

| Sprint | Outcome | Status |
| --- | --- | --- |
| 13 | Reliability Runtime | Complete |
| 14 | Durable Execution — persistent Runs, checkpoints, recovery and resume after restart, durable approval state, durable retry accounting, idempotency / replay protection | Complete |
| 15 | Trace Runtime | Next |
| 16 | Metrics & Audit | Planned |
| 17 | Evaluation Runtime | Planned |
| 18 | Eval Analytics / CI Gates | Planned |
| 19 | Framework Surface | Planned |
| 20 | Toolbox Foundation | Planned |
| 21 | Company Research Proof | Planned |
| 22 | Document Intelligence Proof | Planned |
| 23 | Operational Request Proof | Planned |
| 24 | Company Portability | Planned |
| 25 | Capability Packs / Templates | Planned |
| 26 | Control Center Foundation | Planned |
| 27 | Guided Integration / Run Inspector UX | Planned |
| 28 | Security / Integration Hardening | Planned |
| 29 | Benchmark / Docs / Local V1 | Planned |

The framework surface, generic Toolbox, Integration Fabric, capability packs, and Control Center will use the same governance boundary. This roadmap adds no implementation or deployment commitment for those future layers.

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
