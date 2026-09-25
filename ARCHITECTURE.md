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
  approval --> execution[External execution and verification]
  execution --> evidence[Trace, audit, artifacts, and evaluation]
  runtime --> state[AAO state and checkpoint contracts]
  runtime --> model[AAO model policy and provider adapters]
  runtime --> tools[AAO tool and capability adapters]
  tools --> external[APIs, MCP servers, databases, SaaS, and internal systems]
  model --> external
```

## Canonical domain contracts

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

Runtime V1 executes only unconditional routing with explicitly registered executors; conditional workflows and node kinds without a registered executor (`tool`, `approval`, `evaluator` — and `model`/`agent` unless the caller registers the Model Runtime's/Agent Runtime's executor) fail a deterministic preflight check before any node executes, rather than partially executing. See [ADR-009](docs/decisions/ADR-009-node-registry-and-runtime-v1.md) and [runtime V1](docs/architecture/runtime-v1.md) for the full pipeline, state semantics, and failure taxonomy, and what remains deliberately deferred (conditional routing, tool/approval/evaluator execution, retries, persistence, durability, parallel execution).

## Managed runtime state and lifecycle

`@aao/runtime` also maintains one authoritative representation of execution state at every safe boundary: an authoritative Run lifecycle (`RunRecord`), an authoritative Node lifecycle (`NodeStatusMap`), revisioned `RunState`, and a safe, in-memory `RuntimeExecutionSnapshot` — never a durable checkpoint. See [ADR-010](docs/decisions/ADR-010-managed-runtime-state-and-lifecycle.md) and [runtime state management](docs/architecture/runtime-state-management.md) for the full model and what remains deliberately deferred (resume, persistence, cancellation/approval/retry execution, tracing).

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

## Canonical architecture documents

- [Product contract](docs/product/product-contract.md) — product purpose, boundaries, V1 proof, and success criteria.
- [Domain contracts](docs/architecture/domain-contracts.md) — the canonical `@aao/contracts` inventory and ownership matrix.
- [Workflow DSL](docs/architecture/workflow-dsl.md) — YAML/JSON authoring, parsing, semantic validation, and compilation into a `CompiledWorkflowPlan`.
- [Runtime V1](docs/architecture/runtime-v1.md) — Node Registry, runtime preflight, deterministic execution, and state/failure semantics.
- [Runtime state management](docs/architecture/runtime-state-management.md) — managed Run/Node lifecycle, the clock boundary, and safe execution snapshots.
- [Model runtime](docs/architecture/model-runtime.md) — model request/result contracts, capability routing, the AI SDK adapter boundary, and the model node.
- [Agent runtime](docs/architecture/agent-runtime.md) — bounded Agent registry, limits, deterministic controller, decision contract, iteration evidence, and the agent node.
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
| Workflow semantics | Yes | LangGraph.js behind an adapter |
| Model policy and contracts | Yes | Vercel AI SDK behind an adapter |
| MCP policy and exposure | Yes | Official MCP TypeScript SDK as connector protocol |
| Durability semantics | Yes | Backing store deferred |
| Canonical integrations | Yes | Provider capability adapters |
| Visualization truth | Yes | xyflow may visualize backend truth later |
| Authorization | Yes | Implementation deferred |
| Evaluation | Yes | Implementation deferred |
| Trace model | Yes | Implementation deferred |

The repository's `packages/substrate-contracts`, `packages/substrate-spikes`, and `experiments` remain Sprint 0A research evidence. They are not production packages or final public contracts. A later sprint must explicitly promote, rewrite, migrate, delete, or archive each concept.

## Operating rules

The source-of-truth hierarchy is: executable contracts and schemas once implemented; canonical ADRs; this overview; domain-specific canonical documents; `AGENTS.md`; README summaries; then experiments and research. Architecture changes require ADR updates. Mock and live execution remain distinct.

## Anti-corruption rules

- Maintain one canonical implementation and contract per concept; do not create duplicate runtime paths without an explicit migration plan.
- Delete, migrate, or explicitly deprecate superseded code; remove or clearly mark superseded documents as historical.
- Do not conflate mock and live execution, weaken tests to make implementation pass, or let demo hardcoding leak into reusable core architecture.
- Keep framework-specific types behind adapter boundaries and prevent company-specific requirements from silently changing core semantics.
- A correct-looking final response is not evidence of reliable execution; evaluate the workflow, tool use, authorization, state, traces, and artifact where applicable.
- Do not enable side effects without authorization policy or durable side effects without an idempotency and recovery design.
- Add no infrastructure without a demonstrated requirement.

## Local-first contract

Current development is local-first: Local Control Center → Local Control Plane → Local AAO Runtime / Worker → Local persistence. External APIs, models, and MCP servers are exercised intentionally. No deployment target is selected; no serverless, Vercel, cloud-infrastructure, or hosted-dependency assumption defines the architecture.
