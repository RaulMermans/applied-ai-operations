# Applied AI Operations

**Applied AI Operations (AAO)** is a reusable runtime and control layer for configuring, executing, governing, observing, and evaluating AI-powered operational workflows inside organisations.

AAO sits between business requests, events, processes, and software on one side, and models, MCP servers, APIs, databases, SaaS platforms, and internal systems on the other. It makes governed operational work reliable: workflow structure, permissions, approvals, durable recovery boundaries, integrations, evaluation, and audit surround model reasoning.

AAO is a layer, not an operating system, chatbot, agent marketplace, no-code workflow builder, ERP, CRM, RAG product, or generic SaaS product.

## Current status

Sprint 0 architecture contract complete. Sprint 1 engineering foundation complete (`SPRINT_01_ENGINEERING_FOUNDATION_COMPLETE`). Sprint 2 canonical domain contracts complete (`SPRINT_02_CANONICAL_DOMAIN_CONTRACTS_COMPLETE`). Sprint 3 workflow DSL and compiler complete (`SPRINT_03_WORKFLOW_DSL_COMPILER_COMPLETE`). Sprint 4 Node Registry and Runtime V1 complete (`SPRINT_04_RUNTIME_V1_COMPLETE`). Sprint 5 managed runtime state and lifecycle complete (`SPRINT_05_MANAGED_RUNTIME_STATE_COMPLETE`). Sprint 6 model abstraction and capability routing complete (`SPRINT_06_MODEL_RUNTIME_COMPLETE`). Sprint 7 bounded Agent Runtime complete (`SPRINT_07_BOUNDED_AGENT_RUNTIME_COMPLETE`). Sprint 8 Tool Registry and safe Tool execution boundary complete (`SPRINT_08_TOOL_RUNTIME_COMPLETE`). Sprint 9 authorization and permission enforcement boundary complete (`SPRINT_09_AUTHORIZATION_BOUNDARY_COMPLETE`). Sprint 10 MCP integration boundary and governed Tool adapter sessions complete (`SPRINT_10_MCP_INTEGRATION_BOUNDARY_COMPLETE`). Sprint 11 Actor, Role & Policy Governance complete (`SPRINT_11_GOVERNANCE_MODEL_COMPLETE`). Sprint 12 Approval Engine is next.

Available:

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
- a generic safe executor-failure protocol: a node failure stays `NODE_EXECUTION_FAILED` but carries bounded, machine-readable `executorFailure: { namespace, code }` causality (e.g. `model` / `MODEL_ROUTE_NOT_FOUND`)
- an independent build per package/app, run from compiled JavaScript
- CI mirroring local verification (`typecheck → lint → build → test`)

Not yet implemented:

- Agent capabilities beyond bounded reasoning. Agents have NO tool use, NO external actions, NO MCP, NO delegation, NO long-term memory, NO durable Agent recovery, NO automatic retries, and NO Reflexion — they are bounded reasoning components, not autonomous workers
- approval or evaluator node execution
- Tools requiring `external_side_effect`, `destructive`, or `sensitive_data` (refused by the Tool Runtime), Tool retries, timeouts/cancellation, idempotency, rollback, and durable Tool recovery
- general Integration Fabric, enterprise provider integrations, MCP HTTP/resources/prompts/sampling, OAuth, and credentials
- authentication, IAM/SSO, and durable authorization state (the host attests the principal; governance configuration is in memory)
- a dynamic policy language, and approval gates or approval workflow
- Agent Tool calls
- model retries, fallback, adaptive/cost routing, streaming, prompt templating, or any configured live model provider/credentials
- conditional routing evaluation
- integrations (Integration Fabric)
- persistence, durability, retries, recovery, resume, cancellation execution, or approval/retry execution
- observability/tracing
- runtime evals
- Control Center UI

AAO can now take a declarative workflow through workflow compilation → managed deterministic execution → provider-neutral model execution → bounded multi-iteration Agent execution → authorized, schema-validated Tool execution: `model` nodes (one validated invocation each), `agent` nodes (a deterministic controller over at most `maxIterations` structured model decisions, applied as one Runtime-managed state patch), and `tool` nodes (one authorized, validated call to a registered, trusted, `read_only`/`write_draft` Tool). It still executes only unconditional workflows, and only node kinds whose executors the caller registers explicitly; approval and evaluator nodes have no implementation and fail a deterministic preflight check rather than partially executing. No live model provider is configured — model validation uses deterministic `ai/test` models offline; MCP tests use a real local SDK stdio server. Runtime snapshots are recovery-ready data structures, not a durable-recovery guarantee — nothing is persisted.

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
pnpm check               # typecheck -> lint -> build -> test
```

See [docs/engineering/local-development.md](docs/engineering/local-development.md) for the full command reference, configuration, and compiled-build smoke verification.

No deployment target, cloud infrastructure, live model provider, or enterprise MCP server is configured. The current `packages/substrate-*` packages and `experiments/` documentation are research evidence, not production AAO architecture.
