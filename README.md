# Applied AI Operations

**Applied AI Operations (AAO)** is a reusable runtime and control layer for configuring, executing, governing, observing, and evaluating AI-powered operational workflows inside organisations.

AAO sits between business requests, events, processes, and software on one side, and models, MCP servers, APIs, databases, SaaS platforms, and internal systems on the other. It makes governed operational work reliable: workflow structure, permissions, approvals, durable recovery boundaries, integrations, evaluation, and audit surround model reasoning.

AAO is a layer, not an operating system, chatbot, agent marketplace, no-code workflow builder, ERP, CRM, RAG product, or generic SaaS product.

## Current status

Sprint 0 architecture contract complete. Sprint 1 engineering foundation complete (`SPRINT_01_ENGINEERING_FOUNDATION_COMPLETE`). Sprint 2 canonical domain contracts complete (`SPRINT_02_CANONICAL_DOMAIN_CONTRACTS_COMPLETE`). Sprint 3 workflow DSL and compiler complete (`SPRINT_03_WORKFLOW_DSL_COMPILER_COMPLETE`). Sprint 4 Node Registry and Runtime V1 complete (`SPRINT_04_RUNTIME_V1_COMPLETE`).

Available:

- a local Control Plane (`apps/control-plane`, Fastify, `/health/live` and `/health/ready`)
- a local Worker (`apps/worker`, a separate process with a `CREATED → RUNNING → STOPPED` lifecycle)
- deterministic typed configuration (`packages/config`)
- canonical, runtime-validatable domain contracts (`packages/contracts`, `@aao/contracts`) for Workflow, Node, Edge, Run, State, Checkpoint, Agent, Skill, Model Policy, Tool, Capability, Permission, Policy Decision, Approval, Eval, Trace, Artifact, Capability Pack references, and Company Configuration — see [ADR-007](docs/decisions/ADR-007-canonical-domain-contracts.md) and [domain contracts](docs/architecture/domain-contracts.md)
- a Workflow DSL and compiler (`packages/workflow-dsl`, `@aao/workflow-dsl`) that parses YAML/JSON workflow definitions, validates them against `WorkflowSchema`, performs graph-level semantic validation (reachability, termination, routing ambiguity, cycle rejection), and compiles a valid workflow into a framework-neutral `CompiledWorkflowPlan` — see [ADR-008](docs/decisions/ADR-008-workflow-dsl-and-compiler.md) and [workflow DSL](docs/architecture/workflow-dsl.md)
- a Node Registry and deterministic Runtime V1 (`packages/runtime`, `@aao/runtime`) that executes a `CompiledWorkflowPlan`: runtime preflight, sequential unconditional routing, explicit state-patch application, and a structured failure taxonomy — see [ADR-009](docs/decisions/ADR-009-node-registry-and-runtime-v1.md) and [runtime V1](docs/architecture/runtime-v1.md)
- an independent build per package/app, run from compiled JavaScript
- CI mirroring local verification (`typecheck → lint → build → test`)

Not yet implemented:

- model, agent, tool, approval, or evaluator node execution (Runtime V1 executes only explicitly registered deterministic/`final_output` executors)
- conditional routing evaluation
- integrations (Integration Fabric)
- persistence, durability, retries, or recovery
- runtime evals
- Control Center UI

AAO can now execute a validated, deterministic, unconditional workflow through a framework-neutral Node Registry and runtime engine — but Runtime V1 currently executes only explicitly registered safe/deterministic node executors and `final_output` over unconditional workflows. It does not yet execute AI workflows: no model, agent, or tool node has an implementation, and any workflow that reaches one fails a deterministic preflight check rather than partially executing.

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

No deployment target, cloud infrastructure, production model provider, or production runtime is configured. The current `packages/substrate-*` packages and `experiments/` documentation are research evidence, not production AAO architecture.
