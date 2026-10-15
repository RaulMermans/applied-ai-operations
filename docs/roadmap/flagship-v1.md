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

## Phase F — Observability

| Sprint / outcome | Scope | Status |
| --- | --- | --- |
| Sprint 15 — Trace Runtime | `@aao/observability` contains:<br>• the migrated `TraceEvent` v2 contract: a closed typed catalog and metadata-only strict payloads;<br>• an emit-only Runtime trace port and per-attempt `NodeTraceContext`;<br>• deterministic trace, span, and event identity that survives restart;<br>• contiguous per-Run sequence, idempotent append, and append-only storage;<br>• in-memory and local file Trace Stores;<br>• a non-throwing recorder with health reporting;<br>• Run, Node, routing, state, model, Agent, Tool (including blocked), retry, approval, checkpoint, recovery, and cancellation instrumentation;<br>• `validateTrace` and `compareTraceWithExecution`;<br>• canonical fixtures, a compiled restart smoke, and a documented OTel mapping.<br>Trace is never read for execution or recovery. No OTel SDK/exporter, metrics, audit, evals, or UI. | Complete (`SPRINT_15_TRACE_RUNTIME_COMPLETE`) — see [ADR-020](../decisions/ADR-020-trace-runtime-and-observability-boundary.md) |
| Sprint 16 — Metrics & Audit | `@aao/observability` gains:<br>• `RunMetrics` and `AggregateMetrics` as deterministic projections of validated Trace, with no Metrics store;<br>• explicit completeness (`null` or partial, never zero);<br>• lifecycle latency that excludes checkpoint timing, with approval wait reported separately;<br>• explicit retry, failure, Tool (physical vs logical), model, Agent, approval, durability, and token metrics;<br>• modelled cost from exact-match `ModelPricingProfile`s in integer nano-units, with explicit coverage;<br>• nearest-rank percentiles and named denominators.<br>Audit is a separate `AuditEvent` contract recorded at authoritative source boundaries (Approval transition at the true `resolvedAt`, denied attempts, Tool Authorization decisions, attributed cancellation request and application) through an emit-only `AuditPort`, into an append-only, hash-chained (tamper-evident) in-memory or local file `AuditStore`. Audit failure never changes execution, and nothing reads Audit or Metrics as authority. No dashboards, alerts, exporters, Eval Runtime, or side-effect enablement. | Complete (`SPRINT_16_METRICS_AUDIT_COMPLETE`) — see [ADR-021](../decisions/ADR-021-metrics-and-audit-boundaries.md) |

## Phase G — Verification

| Sprint / outcome | Scope | Status |
| --- | --- | --- |
| Sprint 17 — Evaluation Runtime | `@aao/evaluation`, a separate non-authoritative layer outside the Runtime:<br>• the Sprint 2 Eval placeholders migrated (not duplicated) to `EvalDefinition` v2 (exact `graderRef`, `supportedModes[]`, `targetType`, JSON config) and `EvalResult` v2 (deterministic `resultId`, `evidenceFingerprint`, bounded assertions and evidence references, `passed` / `failed` / `error`), plus `EvalDataset` v1, `EvalCase`, and `EvalDatasetRun`;<br>• a constructible Evaluator Registry of trusted graders (exact id + version, grader-validated config, no code in Eval data);<br>• one `EvalEvidenceBundle` boundary (Trace, Runtime execution state, RunMetrics, Audit, explicit subject), deep-frozen and fingerprinted;<br>• OFFLINE (recorded evidence) and RUNTIME (a real Run, after the Runtime returned) with the same graders;<br>• nine deterministic graders (trace contract, run outcome, trajectory, Tool usage, Approval, Authorization, retry, state, Metrics thresholds);<br>• an optional, bounded, provider-independent model-judge port;<br>• missing evidence never passes, and `failed` ≠ `error`;<br>• portable verification over canonical AAO semantics;<br>• a 30-case versioned foundation dataset with real and recorder-validated fixtures.<br>No Eval store, analytics, CI gate, Runtime gating, adapter contract, or side-effect enablement. | Complete (`SPRINT_17_EVALUATION_RUNTIME_COMPLETE`) — see [ADR-022](../decisions/ADR-022-evaluation-runtime-and-portable-verification.md) |
| Sprint 18 — Eval Analytics / CI Gates / Adapter Verification | Sprint 17 closure: `aao.approval-compliance` 2.0.0 binds Tool checks to an explicit `guardApprovalNodeId` (multi-Approval regressions). `@aao/evaluation` gains:<br>• `EvalComparisonKey` (logical identity; never `resultId`) and `semanticVerdictFingerprint` (provider/Run independent);<br>• case expectation verdicts (`MATCHED`/`MISMATCHED`/`ERROR`), so negative and deliberate-error cases count as successes;<br>• `EvalDataset` v2 with fingerprint-pinned OFFLINE fixtures;<br>• `EvalSuiteReport`, `EvalBaseline` (human-reviewed, never auto-updated, pinned by the policy), comparison (unchanged, regression, improvement, new, missing, incompatible), `RegressionFinding`s, and multi-run analytics;<br>• strict versioned `EvalGatePolicy` and deterministic `EvalGateDecision`: critical Approval, Authorization, safety, and Trace regressions always hard-fail, operational movement warns, and missing evidence never passes;<br>• offline `pnpm eval:ci` in CI;<br>• adapter verification through the same Eval Runtime (native Tool, MCP, native model, Vercel AI SDK; LangGraph deferred), with the `aao.model-call` grader.<br>No dashboard, Eval database, public Adapter contract, framework surface, model-judge merge gate, or Runtime authority. | Complete (`SPRINT_18_EVAL_ANALYTICS_CI_ADAPTER_VERIFICATION_COMPLETE`) — see [ADR-023](../decisions/ADR-023-eval-analytics-ci-gates-and-adapter-verification.md) |

## Phase H — Developer surface

| Sprint / outcome | Scope | Status |
| --- | --- | --- |
| Sprint 19 — Framework Surface | Proof-layer closure: `validateEvalSuiteReportIntegrity` recomputes a suite report's derived fields from its own cases, and the gate, comparison, baseline proposal, and analytics reject self-attested reports. `@aao/framework` is the recommended consumer façade over AAO Core:<br>• an explicit, snapshot-pinned root (`AAO_FRAMEWORK_API_VERSION` 1, no `export *`);<br>• `define*` helpers that validate the canonical contracts (Workflow, Tool, Governance, Eval, and declarative Agent / Model Policy);<br>• `createAAO`, an isolated, construction-time host that composes the existing Governance, Tool Runtime, Authorization, Approval Engine, and Runtime, with identity only from the host's `principalForRun`;<br>• `prepareWorkflow` through the canonical compiler, with `execute`/`continue` returning canonical Runtime results, and deep-equal equivalence with hand-composed Core;<br>• a truthful V1 scope: `tool`, `approval`, and `final_output` nodes, with other kinds refused at preparation;<br>• the canonical TypeScript `aao` CLI (`workflow validate|compile`, `eval ci|adapters|baseline propose`), replacing the Sprint 18 JavaScript host. `pnpm eval:*` are aliases that need no prior build, and their output is byte-identical to Sprint 18.<br>No adapter API, LangGraph support, durable framework host, file runner, plugin loading, Toolbox, UI, or publication. | Complete (`SPRINT_19_FRAMEWORK_SURFACE_COMPLETE`) — see [ADR-024](../decisions/ADR-024-public-framework-surface.md) |
| Sprint 20 — Adapter & Portability Contract | `@aao/adapters`, the single vendor-free adapter-contract owner:<br>• `AAO_ADAPTER_CONTRACT_VERSION` 1 and conformance v1;<br>• `model` / `tool_provider` / `agent_runtime` kinds with kind-specific ports (no universal adapter), and MCP classified as `tool_provider`;<br>• a canonical capability catalog in AAO terms;<br>• strict, JSON-safe `AdapterManifest` V1 that is a claim, never authority;<br>• exact `id@version` refs, no runtime discovery or module loading, and deterministic compatibility checks;<br>• the canonical conformance suite as package data;<br>• `AdapterConformanceReport` V1 (`PASSED`/`FAILED`/`UNSUPPORTED`/`NOT_APPLICABLE`) with integrity validation;<br>• a generated compatibility matrix with no authority.<br>`ModelAdapter` (one owner, `@aao/model-runtime`) receives the Runtime attempt's `AbortSignal`, which the Vercel AI SDK adapter forwards to the provider. The Agent Runtime stops iterating once aborted. MCP retry safety is host-owned only, and retry safety ≠ recovery safety. `@aao/framework` registers model adapters, bindings, policies, Agents, and deterministic executors, and executes `model`, `agent`, and `deterministic` nodes. Continuation is non-mutating. Cross-adapter portability is proven end to end (native vs Vercel AI SDK + MCP). Official subjects use explicit package exports, and `@aao/framework/conformance` serves third parties.<br>No LangGraph adapter, marketplace, plugin discovery, Toolbox, integrations, side-effect enablement, or UI. | Complete (`SPRINT_20_ADAPTER_PORTABILITY_CONTRACT_COMPLETE`) — see [ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md) |

## Forward roadmap

| Sprint | Outcome | Status |
| --- | --- | --- |
| 13 | Reliability Runtime | Complete |
| 14 | Durable Execution — persistent Runs, checkpoints, recovery and resume after restart, durable approval state, durable retry accounting, idempotency / replay protection | Complete |
| 15 | Trace Runtime — structured execution evidence, persistent local Trace Store, instrumentation, Trace-contract validation | Complete |
| 16 | Metrics & Audit — trace-derived metrics, latency and token/cost aggregation (explicit pricing profiles), retry/failure rates, source-time audit events (approvals, denied attempts, Tool access, cancellation), hash-chained Audit Store; operator-override audit waits for operator overrides to exist | Complete |
| 17 | Evaluation Runtime — versioned Eval definitions and datasets, deterministic and trajectory graders, OFFLINE/RUNTIME modes, `EvalResult` v2, Tool/Approval/Authorization/retry/state/Metrics graders, optional bounded model-judge port, portable verification | Complete |
| 18 | Eval Analytics / CI Gates / Adapter Verification — comparison identity and semantic verdict fingerprints, case expectation verdicts, fingerprint-pinned fixtures (EvalDataset v2), approved baselines, deterministic offline CI gate, adapter conformance foundation | Complete |
| 19 | Framework Surface — public `@aao/framework` façade (`define*`, `createAAO`), canonical `aao` CLI, Eval report integrity | Complete |
| 20 | Adapter & Portability Contract ✅ | Complete |
| 21 | Toolbox Foundation | ← Next |
| 22 | Company Research Proof | Planned |
| 23 | Document Intelligence Proof | Planned |
| 24 | Operational Request Proof | Planned |
| 25 | Company Configuration & Portability | Planned |
| 26 | Capability Packs / Templates | Planned |
| 27 | Control Center Foundation | Planned |
| 28 | Guided Integration / Run Inspector | Planned |
| 29 | Security / Adapter Hardening | Planned |
| 30 | Benchmark / Docs / Local V1 | Planned |

Direction for the next portability-related sprints (documentation only; nothing here is implemented early):

- **Sprint 18 (complete)** proved the requirements for that contract with adapter verification over canonical evidence (see [adapter verification](../architecture/adapter-verification.md)):
  - The native Tool and MCP paths agree semantically, as do the native model and Vercel AI SDK paths.
  - MCP declares no retry safety.
  - A native model adapter cannot express tool calls.
  - No model adapter can propagate cancellation, because the ModelAdapter port has no abort signal.
  - LangGraph remains a deferred research spike.
- **Sprint 19 (complete)** added the public framework surface without freezing any adapter semantics: model and agent execution through `@aao/framework` is refused at preparation until Sprint 20 defines the contract. Its concrete open questions are recorded in [framework surface § Sprint 20 handoff](../architecture/framework-surface.md#sprint-20-handoff).
- **Sprint 20 (complete)** formalized the public adapter contract ([ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md), [adapter contract](../architecture/adapter-contract.md)): `AdapterManifest`, capability declaration, a generated compatibility matrix, a versioned conformance contract, and AAO port interfaces. It verifies one principle: *external substrates implement AAO interfaces; they do not define AAO semantics.*
- **Sprint 21 — Toolbox Foundation** can assume:
  - provider-independent Tool capability;
  - a stable Framework, adapter manifest, and conformance contract;
  - a stable Tool-provider boundary: host binds a canonical `ToolSpec`, the Tool Runtime executes it, and retry safety is host-owned.

  Toolbox Tools are AAO-native capabilities that need not know whether execution ultimately uses a local handler, MCP, REST, or a future provider.
- **Toolbox (Sprint 21+) evaluators stay provider-neutral.** They assert the right *capability* was used (e.g. `crm.accounts.search`), not that a vendor SDK method was called, except in an explicit adapter-conformance eval.

The framework surface (Sprint 19) already uses that governance boundary unchanged; the generic Toolbox, Integration Fabric, capability packs, and Control Center will use the same governance boundary and the same portable verification invariant (evaluation policies attach to AAO contracts and execution semantics, not to individual model, Tool, or orchestration frameworks). This roadmap adds no implementation or deployment commitment for those future layers.

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
