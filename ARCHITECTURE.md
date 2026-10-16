# AAO architecture

Applied AI Operations (AAO) is a reusable runtime and control layer for governed AI-powered operational workflows. AAO is a layer, not an operating system or a generic application product.

The workflow is AAO's primary execution unit. Agents are optional, bounded components that perform open-ended reasoning only where a workflow needs them. Deterministic infrastructure controls the lifecycle and every external action.

```mermaid
flowchart TB
  input[Business users, events, processes, and company software] --> intake[Deterministic intake and workflow selection]
  intake --> spec[AAO workflow specification]
  spec --> validator[Validator / compiler]
  validator --> runtime[AAO workflow runtime]
  runtime --> nodes[Deterministic, model, bounded-agent, tool, approval, and evaluator nodes]
  nodes --> governance[Deterministic governance and authorization]
  governance --> approval[Human approval where policy requires]
  approval --> execution[Supported Tool execution; external effects deferred]
  execution --> evidence[Trace, audit, artifacts, and evaluation]
  runtime --> state[AAO state and checkpoint contracts]
  runtime --> model[AAO model policy and provider adapters]
  runtime --> tools[AAO tool and capability adapters]
  tools --> external[APIs, MCP servers, databases, SaaS, and internal systems]
  model --> external
```

## Framework surface

`@aao/framework` (`packages/framework`, Sprint 19, [ADR-024](docs/decisions/ADR-024-public-framework-surface.md)) is the recommended developer entry point. It is a façade over AAO Core, not a second implementation:

- **Definitions.** `define*` helpers validate the canonical contracts.
- **Application host.** `createAAO` composes the existing Governance, Tool Runtime, Authorization, Approval Engine, and Runtime, with identity only from the host's `principalForRun`.
- **CLI.** The canonical `aao` CLI owns workflow validation/compilation and the Eval commands.

```text
Developer → @aao/framework (definitions · app host · CLI) → AAO Core → Runtime / Governance / Evaluation
```

Dependencies run one way, `framework → core`, and Core never imports it. The root exports an explicit, snapshot-pinned allowlist with no vendor types. Framework errors cover preparation only, and Runtime failures stay canonical. Since Sprint 20 the Framework executes `tool`, `approval`, `model`, `agent`, `deterministic`, and `final_output` nodes, through the adapter contract below. See [framework surface](docs/architecture/framework-surface.md).

## Toolbox

`@aao/toolbox` (`packages/toolbox`, Sprint 21, [ADR-026](docs/decisions/ADR-026-toolbox-foundation.md)) is a curated, versioned, provider-neutral library of reusable Tools above the Framework. It is not a runtime:

```text
Toolbox (manifest · discovery metadata · normal Tool definitions) → explicit selection → createAAO → Tool Registry → Tool Runtime → Governance / Authorization
Capability Packs (future) → Toolbox + Integration Fabric (Sprint 22: public web) → Tool Registry → Tool Runtime
```

- **Normal Tools only.** Toolbox Tools are `defineTool` definitions. Hosts select exact refs (`selectToolboxTools`) and register them with `createAAO`. Execution, the support gate, Authorization, validation, retries, Trace, and Audit are unchanged.
- **Metadata is never authority.** `ToolboxManifest` V1 is strict, and authority fields are rejected. Discovery (list, get, deterministic lexical search) grants no permission and registers nothing.
- **AAO Core Toolbox `aao.core@1.0.0`.** Six deterministic, bounded, `read_only` Tools for supplied text and JSON records.
- **Boundaries.** Toolbox ≠ Integration Fabric ≠ Capability Pack ≠ Skill ≠ Memory. Dependencies run `@aao/toolbox → @aao/framework → Core`, and Core never imports it.

See [toolbox](docs/architecture/toolbox.md).

## Integration Fabric and Proof Applications

The Integration Fabric is externally connected capabilities exposed as normal governed AAO Tools (Sprint 22, [ADR-027](docs/decisions/ADR-027-company-research-proof.md); Sprint 23, [ADR-028](docs/decisions/ADR-028-document-intelligence-proof.md)). Its capabilities include:
- `@aao/integration-public-web`: `public_web.search` and `public_web.fetch_pages` (`read_only`).
- `@aao/integration-documents`: `document.extract_text` (`read_only`), ingesting opaque document references through host-supplied `DocumentSourceProvider` with safe local extraction (`unpdf`, plain text). Raw document bytes never enter Run state or Trace.

```text
Company Research (example)      → @aao/integration-public-web + @aao/toolbox → @aao/framework → Core
Document Intelligence (example) → @aao/integration-documents                 → @aao/framework → Core
```

- **Integration ≠ Tool Runtime ≠ adapter contract ≠ Toolbox ≠ Capability Pack.** The Toolbox never depends on an integration, and no Core package depends on either.
- **The Company Research proof** (`examples/company-research`) is a linear Workflow of 16 nodes planning and synthesizing public-web research.
- **The Document Intelligence proof** (`examples/document-intelligence`) is a linear 9-node Workflow: intake → extract_document → validate_document → segment_document → admit_evidence → synthesize (model) → validate_grounding → render → final. Offsets are UTF-16 code units into canonical normalized page text; citations resolve to precomputed evidence-span IDs (`ev.<16-hex>`). It uses no vector database, RAG framework, OCR, or branching DSL.

See [Integration Fabric](docs/architecture/integration-fabric.md), [Company Research proof](docs/proofs/company-research.md), and [Document Intelligence proof](docs/proofs/document-intelligence.md).

## Canonical domain contracts

Company configuration supplies actors, roles, bindings, and deny policies to `@aao/governance`. Its deterministic resolver turns host-attested identity into effective authority. Existing `@aao/authorization` checks requested permissions and the Agent ceiling; `@aao/tool-runtime` enforces runtime support and executes supported Tools. See [governance](docs/architecture/governance.md) and [ADR-016](docs/decisions/ADR-016-actor-role-policy-governance.md). Approval is a separate, process-local gate after Governance and Authorization (ADR-017); it never grants authority. Approver eligibility is trusted identity plus required-role membership, not possession of the action's permissions.

`@aao/contracts` (`packages/contracts`) is the canonical, framework-neutral, vendor-neutral semantic boundary for AAO: runtime-validatable Zod schemas, with TypeScript types inferred from them, for Workflow, Node, Edge, Run, State, Checkpoint, Agent, Skill, Model Policy, Tool, Capability, Permission, Policy Decision, Approval, Eval, Trace, Artifact, Capability Pack references, and Company Configuration. The dependency direction is one-way:

```text
AAO runtime, integrations, governance, evals, packs, deployments
                              ↓
                       @aao/contracts
                              ↓
                              ✕
              external frameworks / vendors / providers
```

See [ADR-007](docs/decisions/ADR-007-canonical-domain-contracts.md) and [domain contracts](docs/architecture/domain-contracts.md) for the full contract inventory, ownership matrix, and what remains deliberately deferred (graph/runtime semantic validation, persistence, execution).

## Workflow DSL and compiler

`@aao/workflow-dsl` (`packages/workflow-dsl`) authors, parses, schema-validates, semantically validates, and compiles a Workflow before any runtime exists to execute it:

```text
Workflow Source (YAML/JSON)
      ↓
Workflow DSL (parse + canonical schema + semantic graph validation)
      ↓
Validator / Compiler
      ↓
CompiledWorkflowPlan
      ↓
Runtime V1 (@aao/runtime — see below)
```

`CompiledWorkflowPlan` is a framework-neutral, JSON-safe, deterministic artifact. See [ADR-008](docs/decisions/ADR-008-workflow-dsl-and-compiler.md) and [workflow DSL](docs/architecture/workflow-dsl.md) for the full pipeline, diagnostic codes, and what remains deliberately deferred (condition evaluation, node config validation, registry existence checks).

## Runtime V1 and Node Registry

`@aao/runtime` (`packages/runtime`) is the first production execution engine over a `CompiledWorkflowPlan`:

```text
CompiledWorkflowPlan
      ↓
Runtime V1 (preflight, sequential unconditional execution, state-patch application)
      ↓
Node Registry
      ↓
Registered Node Executor (trusted, code-registered — never authored by workflow source)
```

Runtime V1 executes only unconditional routing with explicitly registered executors; conditional workflows and node kinds without a registered executor (`evaluator` — and `model`/`agent`/`tool` unless the caller registers the Model Runtime's/Agent Runtime's/Tool Runtime's executor) fail a deterministic preflight check before any node executes, rather than partially executing. See [ADR-009](docs/decisions/ADR-009-node-registry-and-runtime-v1.md) and [runtime V1](docs/architecture/runtime-v1.md) for the full pipeline, state semantics, and failure taxonomy, and what remains deliberately deferred (conditional routing, evaluator execution, persistence, durability, parallel execution). Bounded in-process retries and attempt timeouts were added in Sprint 13; see below.

## Managed runtime state and lifecycle

`@aao/runtime` also maintains one authoritative representation of execution state at every safe boundary: an authoritative Run lifecycle (`RunRecord`), an authoritative Node lifecycle (`NodeStatusMap`), revisioned `RunState`, and a safe, in-memory `RuntimeExecutionSnapshot`. A snapshot is not itself a durable checkpoint; `@aao/durability` wraps it in a `DurableCheckpoint` when a host opts in. See [ADR-010](docs/decisions/ADR-010-managed-runtime-state-and-lifecycle.md) and [runtime state management](docs/architecture/runtime-state-management.md) for the full model. Durable resume and persistence live in `@aao/durability` (Sprint 14); tracing lives in `@aao/observability` (Sprint 15).

## Model Runtime and capability routing

`@aao/model-runtime` (`packages/model-runtime`) is AAO's provider-neutral model execution layer, a distinct Core subsystem outside the generic Runtime:

```text
ModelRequest → ModelPolicy → deterministic Capability Router → AAO Model Adapter → Vercel AI SDK → injected model → validated ModelResult
```

It owns `ModelRequest`/`ModelResult`/`ModelFailure`, an explicit Model Registry and Model Policy Registry (reusing canonical `ModelPolicySpec`), deterministic routing on declared model capabilities + explicit priority (no fallback, no retry), and a `model` `NodeExecutor` that callers register explicitly. The generic Runtime stays model-agnostic; its only change is an optional `NodeExecutor.validateConfig` hook called during preflight. See [ADR-011](docs/decisions/ADR-011-model-runtime-and-capability-routing.md) and [model runtime](docs/architecture/model-runtime.md).

## Bounded Agent Runtime

`@aao/agent-runtime` (`packages/agent-runtime`) is the first Agent implementation, a distinct Core subsystem layered on the Model Runtime and bridged into the workflow Runtime as an explicitly registered `agent` node:

```text
Workflow → Agent Node → Deterministic Agent Controller → Model Runtime → structured AgentDecision
                               ↑                                                ↓
                               └──── CONTINUE (only if budget permits) ─────────┤
                                                                                 COMPLETE → AgentResult → Runtime-managed state patch
```

It reuses canonical `AgentSpec` plus a runtime binding (instructions, `maxIterations ≤ 16`, per-iteration output-token ceiling), an explicit version-exact Agent Registry, and a controller that owns continuation: one iteration = at most one model call, final-iteration `CONTINUE` fails closed, and there is no retry, fallback, tools, skills, delegation, memory, or persistence. The Agent Node is atomic to the parent Runtime (one step, one patch, no mid-Agent snapshot). Sprint 7 also added a generic safe executor-failure protocol (`{ ok: false, failure: { namespace, code } }`) so `NODE_EXECUTION_FAILED` keeps machine-readable causality without the Runtime knowing what a model or agent is. Model Node = one model invocation; Agent Node = bounded controller over multiple model invocations. See [ADR-012](docs/decisions/ADR-012-bounded-agent-runtime.md) and [agent runtime](docs/architecture/agent-runtime.md).

## Tool Runtime

`@aao/tool-runtime` (`packages/tool-runtime`) is the Tool execution boundary, a distinct Core subsystem bridged into the workflow Runtime as an explicitly registered `tool` node:

```text
ToolExecutionRequest → Tool Registry → permission support gate → authorization → inputSchema → trusted handler → output JSON safety + outputSchema → ToolResult
```

It reuses canonical `ToolSpec` plus a trusted handler binding, an explicit version-exact Tool Registry that compiles both JSON Schemas with strict Ajv at registration (fail closed), and one `executeTool` path that invokes a handler at most once per call (no retry loop, fallback, or timeout race inside Tool Runtime; Runtime-owned retries are below), redacts thrown errors, and preserves only a bounded handler failure code. Tool Runtime V1 executes only Tools whose permission classes are all `read_only`/`write_draft`; `external_side_effect`, `destructive`, and `sensitive_data` fail closed, including in Tool Node preflight. That gate is not authorization: registered ≠ supported ≠ authorized. The public Tool Registry is inspection-only, so `executeTool` is the only path to a registered handler. The Tool Runtime remains MCP-unaware; the connector below supplies normal handlers. There is no general Integration Fabric, credentials, Agent Tool use, or persistence. See [ADR-013](docs/decisions/ADR-013-tool-registry-and-safe-execution-boundary.md) and [tool runtime](docs/architecture/tool-runtime.md).

## Authorization

`@aao/authorization` (`packages/authorization`) is the deterministic Authorization Boundary, enforced inside every `executeTool`:

```text
host-attested AuthorizationContext → Tool permission requirements → Agent ceiling (if present) → authorize() → ALLOW / DENY + reason code
```

The rule is `required ⊆ principal grants` and, with an Agent, `required ⊆ grants ∩ agent ceiling`. There is no permission hierarchy, superuser, default allow, generic policy language, or model involvement in Authorization. AAO does not authenticate; the host attests the principal. Missing or malformed context fails closed, the support gate runs first, and authorization runs before input validation. The workflow `tool` node gets its context from a host resolver, never from workflow state or config; the generic Runtime stays authorization-unaware. See [ADR-014](docs/decisions/ADR-014-authorization-and-permission-enforcement.md) and [authorization](docs/architecture/authorization.md).

## MCP connector boundary

`@aao/mcp-connector` (`packages/mcp-connector`, Sprint 10) is the single production MCP adapter. A trusted host creates one explicit stdio session per server, discovers Tools, and binds a selected remote name to a canonical AAO `ToolSpec`. Discovery never registers Tools or assigns permissions.

```text
Trusted host → MCP session → SDK Client → stdio → MCP server
Discovery → explicit trusted binding → Tool Registry → executeTool
→ support gate → Authorization → AAO input validation → MCP call once
→ structured output normalization → AAO output validation → ToolResult
```

SDK types, subprocess configuration, and sessions stay inside infrastructure configuration. The generic Runtime, Agent Runtime, Authorization, and Tool Runtime remain MCP-unaware. No HTTP, OAuth, resources, prompts, sampling, Agent Tool use, reconnect, or persistence is implemented. The connector never retries. Since Sprint 20 a host may declare a `read_only` binding retry-safe (never from server metadata), and then the *Runtime* may retry a transient remote failure. See [ADR-015](docs/decisions/ADR-015-mcp-integration-boundary-and-tool-adapter-sessions.md) and [MCP connector](docs/architecture/mcp-connector.md).

## Runtime reliability

Sprint 13 adds one Reliability Controller inside `@aao/runtime`, called once per Node execution from the single Runtime loop. It is not a second engine:

```text
trusted ReliabilityPolicy (host options, hard caps) → attempt (cloned state, AbortSignal, optional timeout)
→ structured failure category → retryable? + retry-safe? + budget left? → retry or terminate → ONE accepted outcome
```

The default is one attempt. A retry needs a retryable category (`TIMEOUT`, `TRANSIENT_DEPENDENCY`, `RATE_LIMIT`), a trusted executor retry-safety declaration (Tool Node: only `read_only` Tools registered `retrySafety: "safe"`), and remaining budget (`maxAttempts ≤ 3`). Unknown failures, thrown values, validation, Authorization/Governance denials, the support gate, and approval outcomes are never retried. Failed and timed-out attempts commit no state, and late results are ignored. Nodes stay `RUNNING` across attempts. Under `@aao/durability` (Sprint 14) attempt accounting survives restart. See [ADR-018](docs/decisions/ADR-018-runtime-reliability-and-bounded-retries.md) and [reliability runtime](docs/architecture/reliability-runtime.md).

## Durable execution

Sprint 14 adds `@aao/durability` around the single Runtime loop. It does not replace that loop:

```text
safe checkpoint → persist operation STARTED → executor → validate → persist accepted outcome → commit → next checkpoint
restart → load + validate plan/checkpoint/ledger → continue | commit recorded outcome | bounded safe replay | fail closed
```

The Runtime exposes a generic durability port and `resumeWorkflow`; it never touches storage. `@aao/approval` exposes an `ApprovalRepository` port. Neither depends on `@aao/durability`.

- Runs bind to a canonical plan fingerprint.
- Checkpoints are immutable, contiguous, and taken only at safe boundaries.
- Recorded outcomes are committed without re-invoking executors, and attempt numbering and `maxAttempts` survive restart.
- An ambiguous operation replays at most once, and only when its executor is trusted recovery-safe. A `write_draft` Tool needs `idempotency: "execution_id"`, keyed by the stable `toolExecutionId`.
- Durable approval continuation revalidates the subject, plan, and current Governance.

The reference store is local, single-host, and single-writer. No exactly-once claim is made, and side-effect permission classes stay unsupported. See [ADR-019](docs/decisions/ADR-019-durable-execution-checkpoints-and-replay.md) and [durable execution](docs/architecture/durable-execution.md).

## Trace Runtime

Sprint 15 adds `@aao/observability`, the canonical Trace Runtime. Trace is an observational projection of authoritative execution, never a second source of truth:

```text
Runtime / Governance / Approval / Durability ──emit──► RuntimeTracePort ──► recorder ──► TraceStore (in-memory | local file)
                                                                                    └─► validateTrace · compareTraceWithExecution
```

- The Runtime, Node executors (through `NodeExecutionContext.trace`), the approval bridge, and the durable host report what they already decided through an optional, emit-only port. Nothing reads Trace to decide anything, and recovery reads only the durability ledger.
- Events use the migrated `TraceEvent` schema version 2, with a closed dot-namespaced catalog and strict, metadata-only typed payloads.
- Identity is deterministic: trace, span, and event ids survive restart. Each Run has a contiguous per-Run `sequence`, and appends are idempotent and append-only.
- Trace failure degrades trace health and never changes Run outcome or triggers a retry.
- The schema is designed for OpenTelemetry-compatible mapping. No OTel SDK or exporter exists.

See [ADR-020](docs/decisions/ADR-020-trace-runtime-and-observability-boundary.md) and [trace runtime](docs/architecture/trace-runtime.md).

## Metrics and Audit

Sprint 16 extends `@aao/observability` with two more evidence concepts, kept separate from Trace and from every execution authority:

```text
EXECUTION TRUTH ──► Trace ──► validateTrace ──► deriveRunMetrics ──► RunMetrics ──► aggregateRunMetrics ──► AggregateMetrics
SECURITY / ACCOUNTABILITY ACTION ──emit──► AuditPort ──► Audit recorder ──► AuditStore (in-memory | local file, hash-chained)
```

- **Trace = chronology, Metrics = derived measurement, Audit = accountability evidence.** None is execution authority. Metrics never decide execution, Audit never grants authority, and Trace never recovers Runs.
- **Metrics** are pure, deterministic projections of validated Trace plus explicit trusted pricing.
  - There is no Metrics store.
  - Missing evidence stays missing (`null` or partial, never zero).
  - Run latency is `run.started` → terminal event, never checkpoint timing.
  - Cost is computed only from exact-match `ModelPricingProfile`s in integer nano-units. It is a modelled estimate, not billing.
- **Audit** is recorded at the authoritative source boundary: the Approval repository transition (true `resolvedAt` / `resolvedBy`), the Tool Authorization decision, and the attributed durable cancellation request and application.
  - It flows through an emit-only `AuditPort` defined in `@aao/contracts`, so execution packages never import observability.
  - `AuditStore` is separate from `TraceStore` and `DurabilityStore`: append-only, with a contiguous sequence per stream and a SHA-256 hash chain. The chain is tamper-evident, not tamper-proof.
  - Audit failure degrades Audit health and never changes or retries an action.

See [ADR-021](docs/decisions/ADR-021-metrics-and-audit-boundaries.md), [metrics](docs/architecture/metrics.md), and [audit](docs/architecture/audit.md).

## Evaluation Runtime

Sprint 17 adds `@aao/evaluation`, a separate layer that observes and judges AAO execution evidence. It never becomes execution authority:

```text
Trace · Runtime execution state · RunMetrics · Audit · (explicit subject)
      ↓ host hands over after the Runtime returned (RUNTIME) or from recorded fixtures (OFFLINE)
EvalEvidenceBundle (deep-frozen, fingerprinted) → EvalDefinition v2 → Evaluator Registry (exact grader id + version)
      → deterministic grader (default) | bounded model judge (optional, injected port) → EvalResult v2
```

- **Non-authoritative.** No execution package depends on Evaluation, and the Runtime has no eval hook. Evaluation writes no Trace, Audit, or Metrics. An `EvalResult` cannot approve, authorize, change Run state, call a Tool, retry, recover, or enable a side effect.
- **One contract family.** The Sprint 2 placeholders were migrated in `@aao/contracts`:
  - `EvalDefinition` and `EvalResult` (both schema version 2);
  - `EvalDataset` (schema version 1), `EvalCase`, and `EvalDatasetRun`.
- **Trusted graders only.** Definitions select registered graders by exact id and version, and Eval data can never name code.
- **Deterministic by default.** The nine deterministic graders cover the trace contract, Run outcome, trajectory, Tool usage (physical vs logical, blocked ≠ invoked), Approval, Authorization, retries, state assertions, and Metrics thresholds.
- **Fail closed.** Missing, corrupt, or incomplete evidence never passes. `failed` (behavior violated) and `error` (no trustworthy judgment) stay distinct.
- **Portable verification is a permanent invariant:** evaluation policies attach to AAO contracts and execution semantics, not to individual model, Tool, or orchestration frameworks. The evaluation core imports no framework, provider SDK, or MCP code.

See [ADR-022](docs/decisions/ADR-022-evaluation-runtime-and-portable-verification.md), [evaluation runtime](docs/architecture/evaluation-runtime.md), and [`evals/`](evals/README.md).

## Eval analytics, CI gates, and adapter verification

Sprint 18 turns evaluation evidence into deterministic quality control, still outside execution authority:

- **Comparison identity.** Cases are compared by a logical comparison key (Eval, grader, dataset, case, mode, target) and a semantic verdict fingerprint. `resultId` stays observation identity.
- **Case expectations.** The verdict (`MATCHED`/`MISMATCHED`/`ERROR`), not `EvalResult.status`, decides CI. Offline fixtures are fingerprint-pinned.
- **Baselines.** An approved, human-reviewed baseline is compared under a strict, versioned gate policy. Approval, Authorization, safety, and Trace regressions always hard-fail.
- **Offline merge gate.** `pnpm eval:ci` runs offline in CI. Its only effect is an exit code; it never writes a baseline and never changes a Run.
- **Adapter verification.** Substrate test drivers produce canonical evidence that the same Eval definitions judge. Support may be partial and is reported truthfully. The public Adapter contract is Sprint 20.

See [ADR-023](docs/decisions/ADR-023-eval-analytics-ci-gates-and-adapter-verification.md), [eval analytics & CI](docs/architecture/eval-analytics-ci.md), and [adapter verification](docs/architecture/adapter-verification.md).

## Adapter and portability contract

Sprint 20 makes substrate independence a public, versioned contract. AAO business logic, workflow semantics, governance, evaluation, and durability remain independent of concrete model, Tool, and agent frameworks. Adapters map external substrate behavior into canonical AAO contracts, and never redefine them.

```text
AAO semantics → Adapter Contract (@aao/adapters, v1) → Model Adapter | Tool Provider | Agent Runtime (none yet) → provider / MCP / future
Manifest claim → canonical conformance (real AAO Runs, Evaluation Runtime) → AdapterConformanceReport v1 → generated compatibility matrix
```

- **One vendor-free owner.** `@aao/adapters` holds the contract version, kinds, capability catalog, `AdapterManifest` V1, exact refs, compatibility, the conformance suite, the report with integrity validation, and the matrix. It depends only on `@aao/contracts`.
- **Kind-specific ports.** `ModelAdapter` stays in `@aao/model-runtime` and now carries the Runtime attempt's `AbortSignal` to the provider. Tool providers bind to the Tool Runtime's `RegisteredTool`. MCP is a `tool_provider`.
- **Claims are not authority.** A manifest grants nothing. Compatibility is not authorization. A false claim fails conformance, and the matrix has no runtime authority.
- **Explicit everything.** Registration is explicit and version-exact, with no discovery, dynamic loading, or autonomous adapter selection. Continuation is non-mutating. Deterministic executors are trusted host code, not adapters.

See [ADR-025](docs/decisions/ADR-025-adapter-and-portability-contract.md), [adapter contract](docs/architecture/adapter-contract.md), [portability](docs/architecture/portability.md), and the generated [compatibility matrix](docs/framework/adapter-compatibility.md).

## Canonical architecture documents

- [Product contract](docs/product/product-contract.md) — product purpose, boundaries, V1 proof, and success criteria.
- [Domain contracts](docs/architecture/domain-contracts.md) — the canonical `@aao/contracts` inventory and ownership matrix.
- [Workflow DSL](docs/architecture/workflow-dsl.md) — YAML/JSON authoring, parsing, semantic validation, and compilation into a `CompiledWorkflowPlan`.
- [Runtime V1](docs/architecture/runtime-v1.md) — Node Registry, runtime preflight, deterministic execution, and state/failure semantics.
- [Runtime state management](docs/architecture/runtime-state-management.md) — managed Run/Node lifecycle, the clock boundary, and safe execution snapshots.
- [Model runtime](docs/architecture/model-runtime.md) — model request/result contracts, capability routing, the AI SDK adapter boundary, and the model node.
- [Agent runtime](docs/architecture/agent-runtime.md) — bounded Agent registry, limits, deterministic controller, decision contract, iteration evidence, and the agent node.
- [Tool runtime](docs/architecture/tool-runtime.md) — Tool Registry, JSON Schema policy, permission support gate, handler contract, and the tool node.
- [Authorization](docs/architecture/authorization.md) — host-attested Authorization Context, the deterministic evaluator, Agent ceiling, and enforcement inside `executeTool`.
- [Approval engine](docs/architecture/approval-engine.md) — human resolution and Runtime waitpoints.
- [Reliability runtime](docs/architecture/reliability-runtime.md) — trusted bounded retry policy, failure taxonomy, retry safety, attempt timeouts, and late-result protection.
- [Durable execution](docs/architecture/durable-execution.md) — durable checkpoints, write-ahead operation records, crash recovery, recovery safety, Tool idempotency, durable approvals, and safe-boundary cancellation.
- [Trace runtime](docs/architecture/trace-runtime.md) — Trace Event V2, the emit-only trace port, recorder, Trace Stores, identity, content policy, validation, and the OpenTelemetry mapping.
- [Metrics](docs/architecture/metrics.md) — Trace-derived RunMetrics and AggregateMetrics, completeness, latency, token usage, explicit pricing and cost coverage, denominators, and nearest-rank percentiles.
- [Audit](docs/architecture/audit.md) — source-time accountability events, the emit-only Audit port, the hash-chained Audit Store, verification, failure isolation, and retention limits.
- [Evaluation runtime](docs/architecture/evaluation-runtime.md) — non-authoritative OFFLINE/RUNTIME evaluation, Eval Definition/Result v2, datasets, the Evaluator Registry, deterministic graders, the bounded model-judge port, and portable verification.
- [Eval analytics & CI gates](docs/architecture/eval-analytics-ci.md) — comparison identity, case expectation verdicts, suite reports, baselines, comparison, and the deterministic offline gate.
- [Adapter verification](docs/architecture/adapter-verification.md) — Sprint 18 verification history, now running through the public adapter contract.
- [Adapter contract](docs/architecture/adapter-contract.md) — `@aao/adapters`: manifests, kinds, capabilities, ports, cancellation, conformance vocabulary, report integrity, and the generated matrix.
- [Portability](docs/architecture/portability.md) — the portability invariant, where substrate choice lives, and the cross-adapter proof.
- [Framework surface](docs/architecture/framework-surface.md) — the public `@aao/framework` façade, application host, identity ownership, and model/agent/deterministic registration; with the developer [quickstart](docs/framework/quickstart.md) and [CLI](docs/framework/cli.md).
- [Integration Fabric](docs/architecture/integration-fabric.md) — externally connected capabilities as normal governed Tools; `@aao/integration-public-web`, `@aao/integration-documents`.
- [Company Research proof](docs/proofs/company-research.md) — the Sprint 22 end-to-end proof Workflow.
- [Document Intelligence proof](docs/proofs/document-intelligence.md) — the Sprint 23 end-to-end proof Workflow.
- [Toolbox](docs/architecture/toolbox.md) — `@aao/toolbox`: the curated reusable Tool library, manifest contract, non-authoritative catalog and search, the AAO Core Toolbox, and its boundaries; with the generated [Core Tools catalog](docs/toolbox/core-tools.md).
- [Governance](docs/architecture/governance.md) — host-attested actors, role bindings, deny policies, and resolved authority before Authorization.
- [MCP connector](docs/architecture/mcp-connector.md) — isolated stdio sessions, bounded discovery, explicit Tool bindings, and normalized failures.
- [System boundaries](docs/architecture/system-boundaries.md) — architectural layers and ownership.
- [Core vs company](docs/architecture/core-vs-company.md) — portability boundary and configuration responsibilities.
- [Execution model](docs/architecture/execution-model.md) — workflow-first design, responsibility split, and patterns.
- [Runtime lifecycle](docs/architecture/runtime-lifecycle.md) — run and node states.
- [State, memory, and durability](docs/architecture/state-memory-durability.md) — persistence and evidence boundaries.
- [Integration model](docs/architecture/integration-model.md) — capability adapters, provider boundaries, and MCP.
- [Permission model](docs/security/permission-model.md) — authority, approval, and sensitive-data rules.
- [Flagship V1 roadmap](docs/roadmap/flagship-v1.md) — the single canonical roadmap.

## Dependency ownership

Dependencies implement infrastructure; AAO defines product semantics.

| Capability | AAO owns | Current substrate stance |
| --- | --- | --- |
| Adapter contract | Yes | `@aao/adapters`: vendor-free manifests, capabilities, conformance, matrix (Sprint 20); adapters own external substrate compatibility |
| Workflow semantics | Yes | Native AAO Runtime; LangGraph.js deferred (no `agent_runtime` adapter exists) |
| Model policy and contracts | Yes | Vercel AI SDK behind the conformance-verified `model` adapter contract |
| MCP policy and exposure | Yes | Official MCP TypeScript SDK as a conformance-verified `tool_provider` |
| Durability semantics | Yes | `@aao/durability`; local filesystem reference store, single host / single writer (Sprint 14) |
| Integration Fabric (external system capability access) | Yes | `@aao/integration-public-web` (Sprint 22) and `@aao/integration-documents` (Sprint 23): normal governed Tools around host-injected providers, no vendor SDK; MCP via `@aao/mcp-connector` |
| Visualization truth | Yes | xyflow may visualize backend truth later |
| Authorization | Yes | `@aao/authorization`, no external dependency (Sprint 9) |
| Governance | Yes | `@aao/governance`, canonical contracts and deterministic validation (Sprint 11) |
| Evaluation | Yes | `@aao/evaluation`: trusted deterministic graders over canonical evidence, no eval framework or vendor (Sprint 17); optional model judge only through an injected port; analytics, CI gates, and adapter verification (Sprint 18); report integrity (Sprint 19) |
| Developer surface | Yes | `@aao/framework`: an explicit façade and the `aao` CLI over AAO Core, no framework SDK (Sprint 19) |
| Reusable Tool package / catalog (generic reusable computation) | Yes | `@aao/toolbox`: curated Tool definitions + non-authoritative catalog, no vendor SDK (Sprint 21) |
| Company Research proof (example application) | Yes | `examples/company-research`, private; consumes public packages only; nothing depends on it (Sprint 22) |
| Document Intelligence proof (example application) | Yes | `examples/document-intelligence`, private; consumes public packages only; nothing depends on it (Sprint 23) |
| Callable Tool definitions | Yes | Tool Registry (`@aao/tool-runtime`): authoritative schemas, handlers, permission classes, versions |
| Tool execution | Yes | Tool Runtime (`@aao/tool-runtime`): support gate, Authorization, validation (Sprint 8–9) |
| Trace model | Yes | `@aao/observability`: local Trace Stores, no external dependency (Sprint 15); OTel export deferred |
| Metrics | Yes | `@aao/observability`: pure projections of Trace, no Metrics store or metrics SDK (Sprint 16); exporters deferred |
| Audit | Yes | `@aao/observability`: local hash-chained Audit Store, no SIEM or audit vendor (Sprint 16) |

The repository's `packages/substrate-contracts`, `packages/substrate-spikes`, and `experiments` remain Sprint 0A research evidence. They are not production packages or final public contracts. The MCP spike is `KEEP_AS_HISTORICAL_EVIDENCE`; production MCP is exclusively `@aao/mcp-connector` (ADR-015). Other concepts still need explicit promotion, migration, deletion, or archival.

## Operating rules

The source-of-truth hierarchy is: executable contracts and schemas once implemented; canonical ADRs; this overview; domain-specific canonical documents; `AGENTS.md`; README summaries; then experiments and research. Architecture changes require ADR updates. Mock and live execution remain distinct.

## Anti-corruption rules

- Maintain one canonical implementation and contract per concept; do not create duplicate runtime paths without an explicit migration plan.
- Delete, migrate, or explicitly deprecate superseded code; remove or clearly mark superseded documents as historical.
- Do not conflate mock and live execution, weaken tests to make implementation pass, or let demo hardcoding leak into reusable core architecture.
- Keep framework-specific types behind adapter boundaries and prevent company-specific requirements from silently changing core semantics.
- A correct-looking final response is not evidence of reliable execution; evaluate the workflow, tool use, authorization, state, traces, and artifact where applicable.
- Do not enable side effects without authorization policy or durable side effects without an idempotency and recovery design.
- Evaluation never gates execution, and Eval criteria never encode a framework or provider; external evidence is normalized into AAO semantics first.
- Add no infrastructure without a demonstrated requirement.

## Local-first contract

Current development is local-first: Local Control Center → Local Control Plane → Local AAO Runtime / Worker → Local persistence. External APIs, models, and MCP servers are exercised intentionally. No deployment target is selected; no serverless, Vercel, cloud-infrastructure, or hosted-dependency assumption defines the architecture.
