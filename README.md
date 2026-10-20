# Applied AI Operations

**Applied AI Operations (AAO)** is a reusable runtime and control layer for configuring, executing, governing, observing, and evaluating AI-powered operational workflows inside organisations.

AAO sits between business requests, events, processes, and software on one side, and models, MCP servers, APIs, databases, SaaS platforms, and internal systems on the other. It makes governed operational work reliable: workflow structure, permissions, approvals, durable recovery boundaries, integrations, evaluation, and audit surround model reasoning.

AAO is a layer, not an operating system, chatbot, agent marketplace, no-code workflow builder, ERP, CRM, RAG product, or generic SaaS product.

## Current status

Sprint 0 architecture contract complete. Sprint 1 engineering foundation complete (`SPRINT_01_ENGINEERING_FOUNDATION_COMPLETE`). Sprint 2 canonical domain contracts complete (`SPRINT_02_CANONICAL_DOMAIN_CONTRACTS_COMPLETE`). Sprint 3 workflow DSL and compiler complete (`SPRINT_03_WORKFLOW_DSL_COMPILER_COMPLETE`). Sprint 4 Node Registry and Runtime V1 complete (`SPRINT_04_RUNTIME_V1_COMPLETE`). Sprint 5 managed runtime state and lifecycle complete (`SPRINT_05_MANAGED_RUNTIME_STATE_COMPLETE`). Sprint 6 model abstraction and capability routing complete (`SPRINT_06_MODEL_RUNTIME_COMPLETE`). Sprint 7 bounded Agent Runtime complete (`SPRINT_07_BOUNDED_AGENT_RUNTIME_COMPLETE`). Sprint 8 Tool Registry and safe Tool execution boundary complete (`SPRINT_08_TOOL_RUNTIME_COMPLETE`). Sprint 9 authorization and permission enforcement boundary complete (`SPRINT_09_AUTHORIZATION_BOUNDARY_COMPLETE`). Sprint 10 MCP integration boundary and governed Tool adapter sessions complete (`SPRINT_10_MCP_INTEGRATION_BOUNDARY_COMPLETE`). Sprint 11 Actor, Role & Policy Governance complete (`SPRINT_11_GOVERNANCE_MODEL_COMPLETE`). Sprint 12 Approval Engine complete (`SPRINT_12_APPROVAL_ENGINE_COMPLETE`). Sprint 13 Reliability Runtime complete (`SPRINT_13_RELIABILITY_RUNTIME_COMPLETE`). Sprint 14 Durable Execution complete (`SPRINT_14_DURABLE_EXECUTION_COMPLETE`). Sprint 15 Trace Runtime complete (`SPRINT_15_TRACE_RUNTIME_COMPLETE`). Sprint 16 Metrics & Audit complete (`SPRINT_16_METRICS_AUDIT_COMPLETE`). Sprint 17 Evaluation Runtime complete (`SPRINT_17_EVALUATION_RUNTIME_COMPLETE`). Sprint 18 Eval Analytics / CI Gates / Adapter Verification complete (`SPRINT_18_EVAL_ANALYTICS_CI_ADAPTER_VERIFICATION_COMPLETE`). Sprint 19 Framework Surface complete (`SPRINT_19_FRAMEWORK_SURFACE_COMPLETE`). Sprint 20 Adapter & Portability Contract complete (`SPRINT_20_ADAPTER_PORTABILITY_CONTRACT_COMPLETE`). Sprint 21 Toolbox Foundation complete (`SPRINT_21_TOOLBOX_FOUNDATION_COMPLETE`). Sprint 22 Company Research Proof complete (`SPRINT_22_COMPANY_RESEARCH_PROOF_COMPLETE`). Sprint 23 Document Intelligence Proof complete (`SPRINT_23_DOCUMENT_INTELLIGENCE_PROOF_COMPLETE`). Sprint 24 Operational Request Proof complete (`SPRINT_24_OPERATIONAL_REQUEST_PROOF_COMPLETE`). Sprint 25 Company Configuration & Portability implementation exists; Sprint 25C closure is pending because cross-company Research reaches its planning model before Tool authorization. Sprint 26 remains planned.

## Start here: `@aao/framework`

AAO provides a public TypeScript framework surface for defining and running governed workflows with canonical AAO contracts. It covers Tool, model, bounded Agent, and deterministic execution, Governance, Approval, and deterministic workflow compilation, and comes with a unified CLI for workflow validation, evaluation gates, and adapter conformance.

AAO provides versioned, capability-declared adapter contracts for model providers and Tool-provider protocols. It verifies them with deterministic conformance, and its Framework registration keeps workflow, governance, and evaluation semantics independent of the underlying substrates.

```ts
import { createAAO, defineGovernance, defineTool, defineWorkflow } from "@aao/framework";

const app = createAAO({ governance: defineGovernance(config), principalForRun: ({ runId }) => sessionUser(runId), tools: [defineTool(searchAccounts)] });
const lookup = app.prepareWorkflow(defineWorkflow(workflow));
const result = await lookup.execute({ runId: "run-001", initialState: { runId: "run-001", revision: 0, values: { request } } });
```

- **One import, real execution.** The `define*` helpers validate the canonical contracts. `createAAO` composes the existing Runtime, Tool Runtime, Governance, Authorization, and Approval Engine. Results are the Runtime's own `WorkflowExecutionResult`. The framework is a façade, not a second implementation, and no Core package depends on it.
- **Identity comes from your host.** `principalForRun` is the only principal source; workflow state, Tool input, and model output can never set it.
- **The `aao` CLI.** It provides `aao workflow validate|compile` and `aao eval ci|adapters|baseline propose`. `pnpm eval:*` are aliases, and none needs a prior `pnpm build`.
- **Truthful scope.**
  - The framework executes `tool`, `approval`, `model`, `agent` (the native bounded Agent Runtime), `deterministic` (trusted host executors by exact `executorRef`), and `final_output` nodes. `evaluator` nodes are refused at preparation.
  - Model adapters register explicitly (`defineModelAdapter` + a binding's exact `adapterRef`). Concrete adapters come from their own packages (`@aao/model-runtime/vercel-ai`, `@aao/mcp-connector`), never from the framework root.
  - There is no LangGraph support, no third-party plugin discovery, no universal adapter compatibility, and no external side-effect support.
  - The package is local and unpublished.

Read the [quickstart](docs/framework/quickstart.md) (including the Approval flow and a model adapter), the [CLI](docs/framework/cli.md), the [framework surface](docs/architecture/framework-surface.md), [ADR-024](docs/decisions/ADR-024-public-framework-surface.md), the [adapter contract](docs/architecture/adapter-contract.md), [portability](docs/architecture/portability.md), the generated [adapter compatibility matrix](docs/framework/adapter-compatibility.md), and [ADR-025](docs/decisions/ADR-025-adapter-and-portability-contract.md). The package-by-package internals below remain available for advanced use.

## Reusable Tools: `@aao/toolbox`

AAO Toolbox provides reusable provider-neutral Tool definitions that plug into the same governed Tool Runtime as application-specific Tools.

```ts
import { createAAO } from "@aao/framework";
import { coreToolbox, selectToolboxTools } from "@aao/toolbox";

const tools = selectToolboxTools(coreToolbox, [{ id: "text.chunk", version: "1.0.0" }, { id: "records.dedupe", version: "1.0.0" }]);
const app = createAAO({ governance, principalForRun, tools });
```

- **The AAO Core Toolbox (`aao.core@1.0.0`)** has six deterministic, bounded, `read_only` Tools: `text.normalize`, `text.chunk`, `records.dedupe`, `records.project`, `records.sort`, and `records.count_by`. They use no model, network, filesystem, environment, or credentials.
- **Explicit selection.** Importing the package registers nothing. Hosts pick exact Tool versions, and Authorization still decides every call.
- **Metadata is not authority.** Discovery metadata (category, tags, when to use and when not to use, examples) feeds a read-only catalog with deterministic lexical search. A search result grants no permission.
- **Custom Toolboxes.** `defineToolbox` validates your own manifest and Tool definitions as one versioned package.
- **Truthful scope.** It is a small curated library. There are no integrations, marketplace, semantic Tool discovery, or automatic agent Tool selection.

See the [Toolbox architecture](docs/architecture/toolbox.md), [ADR-026](docs/decisions/ADR-026-toolbox-foundation.md), and the generated [Core Tools catalog](docs/toolbox/core-tools.md).

## Proof application: Company Research

AAO includes an end-to-end Company Research proof. It combines model planning, governed public-web integration Tools, reusable Toolbox utilities, structured synthesis, deterministic citation validation, and the existing Evaluation and Trace infrastructure.

```sh
pnpm proof:company-research   # deterministic fixture demo: no credentials, no network
```

- **Workflow plus Tools, not an Agent.** It is one linear Workflow with two bounded model calls (plan, synthesis) and four `read_only` Tools: `public_web.search`, `records.dedupe`, `public_web.fetch_pages`, and `records.project`.
- **Integration Fabric.** `@aao/integration-public-web` exposes public-web search and fetch as normal governed Tools around a host-injected provider. No search vendor ships, and CI uses fixtures.
- **Citation integrity.** Every cited source id must exist in the admitted evidence. This proves the reference exists, not that the claim is true.

It is not a production search provider, an autonomous research agent, semantic claim verification, browser automation, or a company-intelligence product. See [the proof](docs/proofs/company-research.md), [ADR-027](docs/decisions/ADR-027-company-research-proof.md), and [Integration Fabric](docs/architecture/integration-fabric.md).

## Proof application: Document Intelligence

AAO includes a second end-to-end proof: governed document ingestion, deterministic page segmentation, bounded model extraction, and deterministic evidence-anchored grounding validation.

```sh
pnpm proof:document-intelligence   # deterministic fixture demo: no credentials, no network
```

- **Workflow plus one Tool and one Model call, not a RAG agent.** A linear Workflow of 9 nodes (`intake` → `extract_document` → `validate_document` → `segment_document` → `admit_evidence` → `synthesize` → `validate_grounding` → `render` → `final`) with one governed Tool (`document.extract_text@1.0.0`) and one bounded model call (`document_intelligence.synthesis`).
- **Integration Fabric.** `@aao/integration-documents` handles opaque host document references (`documentRef`), bounded bytes (10 MiB), bounded pages (100) and characters (50k/page, 200k total), and normalized UTF-16 text extraction via `unpdf` and `text/plain` around a host-injected `DocumentSourceProvider`. No raw bytes enter workflow state.
- **Evidence provenance and precomputed span IDs.** Document text is deterministically segmented into precomputed evidence spans (`ev.<16-hex>`). The model cites precomputed IDs only; it never invents page numbers, offsets, or URLs.
- **Strict grounding validation.** Every citation is deterministically validated against admitted evidence spans. If evidence is missing, answers are marked unanswerable; answer assertions must not be empty. Markdown rendering escapes untrusted injections.

It introduces no vector database, RAG framework, OCR engine, document-memory system, autonomous document agent, or conditional routing DSL. See [the proof](docs/proofs/document-intelligence.md), [ADR-028](docs/decisions/ADR-028-document-intelligence-proof.md), and [Integration Fabric](docs/architecture/integration-fabric.md).

## Proof application: Operational Request

AAO includes a third end-to-end proof: governed business action proposals, deterministic proposal validation, human approval waitpoints, authority revalidation, and safe draft execution.

```sh
pnpm proof:operational-request   # deterministic fixture demo: no credentials, no network
```

- **Workflow plus Bounded Model call, not an Autonomous Agent.** A linear 9-node Workflow (`intake` → `interpret` → `validate_proposal` → `bind_approval_subject` → `require_approval` → `revalidate_authority` → `execute_draft` → `render` → `final`) with one bounded model call (`operational_request.interpret`) and one governed draft Tool call (`operations.create_change_draft@1.0.0`).
- **Core Governance Invariant.** Model proposal ≠ Permission grant; Human approval ≠ Permission grant; Approved external action ≠ Executable external action in AAO V1. Tools requiring `external_side_effect` fail closed unconditionally at the Tool Runtime preflight gate (0 handler calls).
- **Exact Approval Fingerprinting.** Canonical Approval Engine binds a cryptographic SHA-256 fingerprint over the proposal subject. Modifying the target account, proposed field, operation, or execution mode halts continuation immediately.
- **Separation of Duties.** Requester (`operations.requester`) and approver (`operations.approver`) must be distinct principals; self-approval is forbidden (`APPROVAL_SELF_APPROVAL_FORBIDDEN`). Machine/agent actors cannot approve (`APPROVAL_HUMAN_REQUIRED`).
- **Draft Execution Only.** No external CRM or ERP system is modified (`externalSystemUpdated: false`). An immutable local draft artifact is recorded in host storage.

See [the proof](docs/proofs/operational-request.md), [ADR-029](docs/decisions/ADR-029-operational-request-proof.md), and [governance](docs/architecture/governance.md).

## Proof application: Company Portability

AAO includes a multi-company configuration and portability proof demonstrating that the three existing flagship workflows can be configured and operated for two independent companies using the same underlying implementations:

```sh
pnpm proof:company-portability   # deterministic multi-company demo: no credentials, no network
```

- **Two Distinct Companies, Zero Workflow Forks.** Northstar Commerce (retail inventory sync, native model adapter, supplier agreements, inventory updates) and Arbor Consulting (management advisory, Vercel AI SDK mock model, client MSA, display name updates) execute the exact same three workflow proofs without code duplication or forks of AAO Core.
- **Workflow Plan Fingerprint vs Configuration Fingerprint.** Workflow plan fingerprints are mathematically identical across both companies for all three workflows (Company Research: `d31688...`, Document Intelligence: `ea4150...`, Operational Request: `8323d4...`), while company configuration fingerprints are strictly distinct (Northstar: `8144c5...`, Arbor: `dd5477...`).
- **Complete Isolation Boundary.** Web providers, document providers with overlapping references (`fixture.contract-001`), in-memory draft repositories, Governance principals, and Approval records are strictly partitioned. Cross-company principal invocations fail closed and cross-company approval attempts are rejected.
- **Strict Declarative Manifests (`@aao/config`).** Governed by `CompanyManifestV1` with a 12-step deterministic preflight validator and immutable host capability catalog lookup. Unknown capabilities or unassigned permissions fail closed at composition.

See [the proof](docs/proofs/company-portability.md), [ADR-030](docs/decisions/ADR-030-company-configuration-portability.md), and [company configuration](docs/architecture/company-configuration.md).

## Available

- the public framework surface (`packages/framework`, `@aao/framework`, Sprint 19): `define*` helpers, the `createAAO` application host, and the `aao` CLI — see above
- the AAO Toolbox (`packages/toolbox`, `@aao/toolbox`, Sprint 21): curated, versioned, provider-neutral Tool definitions with a strict manifest, non-authoritative discovery metadata, a deterministic read-only catalog, explicit exact-ref selection, and the six-Tool AAO Core Toolbox, all executed only through the canonical Tool Runtime — see above, [ADR-026](docs/decisions/ADR-026-toolbox-foundation.md), and [toolbox](docs/architecture/toolbox.md)
- the adapter and portability contract (`packages/adapters`, `@aao/adapters`, Sprint 20): a vendor-free package with `AAO_ADAPTER_CONTRACT_VERSION` 1, the `model` / `tool_provider` / `agent_runtime` kinds, a canonical capability catalog, strict `AdapterManifest` V1 (a claim, never authority), exact adapter refs, deterministic compatibility checks, the canonical conformance suite, `AdapterConformanceReport` V1 with integrity validation and a separate full-conformance check (`PASSED` / `FAILED` / `UNSUPPORTED` / `NOT_APPLICABLE`; an intact but partial report is never a PASS), and a generated compatibility matrix. `ModelAdapter` carries the Runtime attempt's `AbortSignal` to the provider. MCP retry safety is host-owned only. Third-party verification uses `@aao/framework/conformance`. See [ADR-025](docs/decisions/ADR-025-adapter-and-portability-contract.md) and [adapter contract](docs/architecture/adapter-contract.md)
- deterministic Actor, Role, and Policy governance (`packages/governance`, `@aao/governance`): trusted host identity is resolved through explicit role bindings and deny policies into effective permission classes before the existing Authorization and Tool execution path — see [ADR-016](docs/decisions/ADR-016-actor-role-policy-governance.md) and [governance](docs/architecture/governance.md)
- a local Control Plane (`apps/control-plane`, Fastify, `/health/live` and `/health/ready`)
- a local Worker (`apps/worker`, a separate process with a `CREATED → RUNNING → STOPPED` lifecycle)
- deterministic typed configuration (`packages/config`)
- canonical, runtime-validatable domain contracts (`packages/contracts`, `@aao/contracts`) for Workflow, Node, Edge, Run, State, Checkpoint, Agent, Skill, Model Policy, Tool, Capability, Permission, Policy Decision, Approval, Eval, Trace, Artifact, Capability Pack references, and Company Configuration — see [ADR-007](docs/decisions/ADR-007-canonical-domain-contracts.md) and [domain contracts](docs/architecture/domain-contracts.md)
- a Workflow DSL and compiler (`packages/workflow-dsl`, `@aao/workflow-dsl`) that parses YAML/JSON workflow definitions, validates them against `WorkflowSchema`, performs graph-level semantic validation (reachability, termination, routing ambiguity, cycle rejection), and compiles a valid workflow into a framework-neutral `CompiledWorkflowPlan` — see [ADR-008](docs/decisions/ADR-008-workflow-dsl-and-compiler.md) and [workflow DSL](docs/architecture/workflow-dsl.md)
- a Node Registry and deterministic Runtime V1 (`packages/runtime`, `@aao/runtime`) that executes a `CompiledWorkflowPlan`: runtime preflight, sequential unconditional routing, explicit state-patch application, and a structured failure taxonomy — see [ADR-009](docs/decisions/ADR-009-node-registry-and-runtime-v1.md) and [runtime V1](docs/architecture/runtime-v1.md)
- managed Runtime state and lifecycle (`@aao/runtime`): an authoritative Run lifecycle (`CREATED → VALIDATING → QUEUED → RUNNING → COMPLETED | FAILED`), an authoritative Node lifecycle, an explicit clock boundary, and safe in-memory execution snapshots at every safe boundary — see [ADR-010](docs/decisions/ADR-010-managed-runtime-state-and-lifecycle.md) and [runtime state management](docs/architecture/runtime-state-management.md)
- a provider-neutral Model Runtime (`packages/model-runtime`, `@aao/model-runtime`): validated text and structured (JSON Schema) model requests, deterministic model capability routing by declared capabilities and explicit priority, a Vercel AI SDK adapter over an injected model, safe failure normalization, and an explicitly registered `model` node that reads a `ModelRequest` from workflow state and writes a validated `ModelResult` back as a Runtime-managed state patch — see [ADR-011](docs/decisions/ADR-011-model-runtime-and-capability-routing.md) and [model runtime](docs/architecture/model-runtime.md)
- a bounded Agent Runtime (`packages/agent-runtime`, `@aao/agent-runtime`): canonical `AgentSpec` plus a registered binding (instructions and explicit limits, `maxIterations ≤ 16`), an explicit version-exact Agent Registry, and a deterministic controller that runs one Agent for at most `maxIterations` Model Runtime invocations, each returning a structured `CONTINUE`/`COMPLETE` decision; an explicitly registered `agent` node reads a task from workflow state and writes a validated `AgentResult` back as one Runtime-managed state patch — see [ADR-012](docs/decisions/ADR-012-bounded-agent-runtime.md) and [agent runtime](docs/architecture/agent-runtime.md)
- a schema-validated, safe Tool Runtime (`packages/tool-runtime`, `@aao/tool-runtime`): canonical `ToolSpec` plus a trusted handler binding, an explicit version-exact Tool Registry that compiles Tool input/output JSON Schemas with strict Ajv at registration, and one `executeTool` path (input validated before the handler, output validated before success, handler invoked at most once, thrown errors redacted); an explicitly registered `tool` node reads input from workflow state and writes a validated `ToolResult` back as one Runtime-managed state patch. It currently executes only explicitly registered trusted Tools (local or MCP-backed) whose permission classes are limited to `read_only` and `write_draft`; this is a support gate, not authorization — see [ADR-013](docs/decisions/ADR-013-tool-registry-and-safe-execution-boundary.md) and [tool runtime](docs/architecture/tool-runtime.md)
- deterministic authorization (`packages/authorization`, `@aao/authorization`): schema-validated Tool execution is now protected by deterministic permission enforcement using host-attested authorization contexts. Every `executeTool` requires an Authorization Context, and every Tool permission must be explicitly granted to the principal (and, if an Agent acts, fall within its registered permission ceiling). There is no hierarchy, superuser, or default allow. The runtime support gate still runs first, so grants cannot enable unsupported classes. Workflow `tool` nodes get their context from a host resolver, never from workflow state — see [ADR-014](docs/decisions/ADR-014-authorization-and-permission-enforcement.md) and [authorization](docs/architecture/authorization.md)
- an MCP connector (`packages/mcp-connector`, `@aao/mcp-connector`): MCP Tools can be explicitly bound as AAO Tools and executed through the same schema-validation and authorization boundary as local Tools. One host-controlled stdio session per server, bounded discovery, structured output only, no automatic registration or retries — see [ADR-015](docs/decisions/ADR-015-mcp-integration-boundary-and-tool-adapter-sessions.md) and [MCP connector](docs/architecture/mcp-connector.md)
- durable execution (`packages/durability`, `@aao/durability`): AAO can persist workflow progress at safe execution boundaries, recover Runs after process restart, preserve Approval waits and retry accounting, avoid re-executing durably recorded completed operations, and replay ambiguous work only when an explicit recovery/idempotency contract makes that safe. The reference store is local filesystem storage for a single host and a single writer — see [ADR-019](docs/decisions/ADR-019-durable-execution-checkpoints-and-replay.md) and [durable execution](docs/architecture/durable-execution.md)
- a Trace Runtime (`packages/observability`, `@aao/observability`). AAO emits structured, privacy-minimized execution traces across workflow lifecycle, Nodes, model calls, Tool calls, retries, approvals, checkpoints, and durable recovery. Traces are persisted in local Trace storage and checked by deterministic Trace-contract validation. Trace is an observational projection: execution and recovery never read it, and a trace failure never changes a Run. The schema is designed for OpenTelemetry-compatible mapping, but no exporter exists. See [ADR-020](docs/decisions/ADR-020-trace-runtime-and-observability-boundary.md) and [trace runtime](docs/architecture/trace-runtime.md)
- Metrics and Audit (`@aao/observability`, Sprint 16): AAO derives deterministic operational metrics from structured execution traces—including latency, retries, Tool/model usage, tokens, recovery and explicit cost coverage—and records security/accountability actions in a separate immutable, hash-chained local Audit stream. Metrics are pure projections of Trace, with no Metrics store. Missing evidence stays `null` or partial, never zero, and cost is a modelled estimate from explicit pricing profiles, not billing. Audit is recorded where Approval, Tool Authorization, and attributed cancellation decisions happen. It is tamper-evident (not tamper-proof), and nothing reads it as authority. See [ADR-021](docs/decisions/ADR-021-metrics-and-audit-boundaries.md), [metrics](docs/architecture/metrics.md), and [audit](docs/architecture/audit.md)
- an Evaluation Runtime (`packages/evaluation`, `@aao/evaluation`, Sprint 17). AAO evaluates workflow behavior against versioned evaluation definitions and datasets. It uses deterministic graders over canonical Trace, Runtime, Metrics, and Audit evidence:
  - It has two modes: offline over recorded evidence, and live-Run evaluation after the Runtime returned.
  - An optional, bounded, provider-independent model-judge interface is available through a host-injected port.
  - Evaluation is non-authoritative: a result never approves, authorizes, changes a Run, or enables a side effect.
  - Missing or incomplete evidence never passes.
  - Results reference evidence rather than copying it.
  - The versioned definitions, datasets, and fixtures live in [`evals/`](evals/README.md).

  See [ADR-022](docs/decisions/ADR-022-evaluation-runtime-and-portable-verification.md) and [evaluation runtime](docs/architecture/evaluation-runtime.md).
- Eval analytics, a deterministic CI quality gate, and adapter verification (`@aao/evaluation`, Sprint 18):
  - Cases are compared by a logical comparison key and a semantic verdict fingerprint, never by result id or provider.
  - Expectations are judged per case, so negative and deliberate-error cases count as successes.
  - Offline fixtures are fingerprint-pinned.
  - An approved, human-reviewed baseline (`evals/baselines/`) is compared under a strict, versioned gate policy. Approval, Authorization, safety, and Trace regressions always hard-fail; operational movement warns.
  - `pnpm eval:ci` and `pnpm eval:adapters` (aliases of `aao eval ci` / `aao eval adapters` since Sprint 19) run offline in CI and never write a baseline. Since Sprint 19 every public analytics path also rejects self-inconsistent suite reports.
  - Adapter verification judges canonical evidence from the native Tool, MCP connector, native model, and Vercel AI SDK paths with the same Eval definitions. Partial support is reported truthfully.
  - None of this is Runtime authority. Since Sprint 20 adapter verification runs through the public adapter contract (`@aao/adapters`). See [ADR-023](docs/decisions/ADR-023-eval-analytics-ci-gates-and-adapter-verification.md), [eval analytics & CI](docs/architecture/eval-analytics-ci.md), and [adapter verification](docs/architecture/adapter-verification.md).
- the document intelligence proof and document integration (`examples/document-intelligence`, `packages/integration-documents`, Sprint 23): `@aao/integration-documents` exposes `document.extract_text@1.0.0` as a normal governed `read_only` Tool with opaque host document references, byte/page/character limits, and normalized UTF-16 extraction; `examples/document-intelligence` provides a 9-node governed Workflow with deterministic page segmentation, precomputed evidence IDs (`ev.<16-hex>`), strict grounding validation, and injection-safe Markdown rendering. Verified with 27 evaluation cases, portability across native/Vercel AI SDK adapters, and a compiled smoke test. See [ADR-028](docs/decisions/ADR-028-document-intelligence-proof.md), [document intelligence proof](docs/proofs/document-intelligence.md), and [integration fabric](docs/architecture/integration-fabric.md)
- a generic safe executor-failure protocol: a node failure stays `NODE_EXECUTION_FAILED` but carries bounded, machine-readable `executorFailure: { namespace, code }` causality (e.g. `model` / `MODEL_ROUTE_NOT_FOUND`)
- an independent build per package/app, run from compiled JavaScript
- CI mirroring local verification (`typecheck → lint → build → test → eval:ci → eval:adapters`)

## Not yet implemented

- an `agent_runtime` adapter (LangGraph is deferred), a general Tool-provider port in `@aao/framework`, arbitrary third-party adapter discovery or loading, adapter code attestation, a durable framework host, and npm publication of any package
- Agent capabilities beyond bounded reasoning. Agents have NO tool use, NO external actions, NO MCP, NO delegation, NO long-term memory, NO Agent-internal checkpoints (a crashed `agent` node is replayed whole), NO automatic retries, and NO Reflexion — they are bounded reasoning components, not autonomous workers
- evaluator node execution
- Tools requiring `external_side_effect`, `destructive`, or `sensitive_data` (refused by the Tool Runtime), ordinary retries of `write_draft` or side-effecting Tools, rollback, and compensation (crash replay of a `write_draft` Tool requires its explicit `execution_id` idempotency declaration)
- a general Integration Fabric beyond the public-web capability (`@aao/integration-public-web`) and document ingestion capability (`@aao/integration-documents`), host-supplied providers only, live cloud storage/connectors, vector retrieval / RAG frameworks, OCR pipelines, document memory, enterprise provider integrations, MCP HTTP/resources/prompts/sampling, OAuth, and credentials
- Toolbox integrations, Capability Packs, Skills, a Toolbox CLI, remote Toolbox registries or installers, semantic (embedding) Tool discovery, and automatic agent Tool exposure
- authentication, IAM/SSO, and durable authorization state (the host attests the principal; governance configuration is in memory)
- a dynamic policy language and automated approval-policy exceptions
- Agent Tool calls
- model or Agent retries, fallback, adaptive/cost routing, streaming, prompt templating, or any configured live model provider/credentials
- conditional routing evaluation
- exactly-once execution, distributed or multi-host durability, high availability, production queues or worker coordination, durable cloud deployment, automatic compensation, operator recovery tooling for refused ambiguous operations, or circuit breakers
- an OpenTelemetry or Prometheus exporter, Langfuse/Phoenix or other vendor integrations, provider billing reconciliation, signed or distributed Audit, SIEM integration, Audit retention policy, alerting or SLOs, and a Trace, Metrics, or Audit UI
- an Eval result database or dashboards, release gates beyond the offline merge gate, a model-judge merge gate, automated regression-case creation, a model/provider benchmarking platform, universal adapter compatibility certification, Eval-driven self-improvement or autonomous optimization (Evaluation judges; it never revises or gates execution)
- LangGraph support and portable Skill execution
- semantic grading of Tool arguments (Trace deliberately excludes them; schema validity is enforced by the Tool Runtime)
- Control Center UI

## What runs today

AAO can now take a declarative workflow through workflow compilation → managed deterministic execution → provider-neutral model execution → bounded multi-iteration Agent execution → authorized, schema-validated Tool execution: `model` nodes (one validated invocation each), `agent` nodes (a deterministic controller over at most `maxIterations` structured model decisions, applied as one Runtime-managed state patch), and `tool` nodes (one authorized, validated call to a registered, trusted, `read_only`/`write_draft` Tool). It still executes only unconditional workflows, and only node kinds whose executors the caller registers explicitly; approval nodes can wait and continue with a registered executor; evaluator nodes remain unsupported and fail preflight. No live model provider is configured — model validation uses deterministic `ai/test` models offline; MCP tests use a real local SDK stdio server. Runtime snapshots are in-memory unless a host opts into `@aao/durability`, which persists them as durable checkpoints.

The repository remains local-first. `packages/substrate-contracts`, `packages/substrate-spikes`, and `experiments/` are Sprint 0A research evidence, not production AAO architecture; production code does not depend on them. See [docs/engineering/local-development.md](docs/engineering/local-development.md) to run everything, and [docs/engineering/repository-structure.md](docs/engineering/repository-structure.md) for what exists today.

## Architecture at a glance

AAO uses a hybrid workflow-agent architecture:

- A **workflow** is the primary execution unit.
- An **agent** is an optional, bounded component inside a workflow.
- Deterministic AAO software owns validation, routing, permissions, policy, approvals, state transitions, retry and budget limits, and final side-effect authority.
- Models may interpret, plan, synthesize, and make bounded proposals; they never grant themselves permission to act.

AAO Core owns reusable workflow, runtime, governance, observability, evaluation, and capability contracts. Company configuration supplies workflows, terminology, policies, prompts, provider bindings, knowledge sources, and evaluation scenarios without requiring a fork of the core.

Read the [architecture overview](ARCHITECTURE.md), [product contract](docs/product/product-contract.md), [system boundaries](docs/architecture/system-boundaries.md), and [Flagship V1 roadmap](docs/roadmap/flagship-v1.md) for the canonical contract.

## Substrate decisions

The Sprint 0A evidence remains authoritative for infrastructure selection: LangGraph.js, Vercel AI SDK, and the MCP TypeScript SDK may be adopted behind AAO adapters; AAO owns durability semantics and canonical capability adapters; Trigger.dev and Nango are deferred; Composio needs a further spike; xyflow, Mastra, and Langflow are references only; Flowise and Dify are not foundations. See [ADR-000](docs/decisions/ADR-000-substrate-recommendation.md).

## Local use

```sh
pnpm install --frozen-lockfile
pnpm dev:control-plane   # local Control Plane, http://127.0.0.1:4000
pnpm dev:worker          # local Worker process
pnpm check               # typecheck -> lint -> build -> test -> eval gate -> adapter verification
pnpm aao --help          # the aao CLI (builds what it needs first)
```

See [docs/engineering/local-development.md](docs/engineering/local-development.md) for the full command reference, configuration, and compiled-build smoke verification.

No deployment target, cloud infrastructure, live model provider, or enterprise MCP server is configured. The current `packages/substrate-*` packages and `experiments/` documentation are research evidence, not production AAO architecture.

## Human approval boundary

AAO workflows can pause at an exact approval request, expose a structured pending Approval, and continue only after an eligible host-attested user resolves it. With the in-memory repository this is process-local; with `@aao/durability` pending and resolved approvals survive restart, and continuation revalidates the subject, plan, and current authority. Tool Runtime still supports only `read_only` and `write_draft`; approval does not enable external side effects, destructive operations, or sensitive-data handling. See [approval engine](docs/architecture/approval-engine.md) and [ADR-017](docs/decisions/ADR-017-human-approval-and-runtime-waitpoints.md).

## Runtime reliability

AAO provides bounded Runtime reliability with explicit retry policies, structured failure classification, attempt timeouts, retry-safety controls, and protection against late timed-out results mutating authoritative execution state. Retries are off by default (one attempt). They require trusted host configuration (`maxAttempts ≤ 3`), a structured retryable failure, and an operation explicitly declared retry-safe. Today that means `read_only` Tools registered as safe, or custom executors that declare it. Under `@aao/durability`, attempt accounting and the retry budget survive restart; there is no exactly-once execution or side-effect retry. See [reliability runtime](docs/architecture/reliability-runtime.md) and [ADR-018](docs/decisions/ADR-018-runtime-reliability-and-bounded-retries.md).

## Durable execution

AAO can persist workflow progress at safe execution boundaries, recover Runs after process restart, preserve Approval waits and retry accounting, avoid re-executing durably recorded completed operations, and replay ambiguous work only when an explicit recovery/idempotency contract makes that safe. Every executor attempt writes its intent before it runs and its validated outcome before the Runtime commits. An operation whose outcome is unknown after a crash is replayed at most once, and only when trusted metadata declares it recovery-safe; otherwise recovery fails closed. The reference store is local, single-host, and single-writer. AAO makes no exactly-once claim, and `external_side_effect`, `destructive`, and `sensitive_data` remain unsupported. See [durable execution](docs/architecture/durable-execution.md) and [ADR-019](docs/decisions/ADR-019-durable-execution-checkpoints-and-replay.md).
