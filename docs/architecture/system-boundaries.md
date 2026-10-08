# System boundaries

This document assigns responsibility among AAO architectural layers. The workflow runtime is the primary execution layer; all layers retain AAO-owned contracts even when infrastructure is used underneath.

## Control Plane

Owns workflow and agent definitions, tool registrations, model policies, company configuration, permissions, approvals, run inspection, and evaluation configuration. Future user interfaces consume this layer.

## Workflow Runtime

Loads, validates, and compiles workflow specifications; executes nodes and routes edges; manages the run lifecycle and state; enforces budgets; coordinates pause/resume; and emits canonical runtime events. LangGraph may support this layer but cannot define AAO's public contract.

## Model Layer

Transforms an AAO model request through AAO policy and provider/model resolution to a provider adapter, then returns a canonical model result. Vercel AI SDK may operate behind this boundary; provider SDK types cannot become AAO contracts.

## Tool Layer and MCP Connector Layer

The Tool Layer owns canonical tool contracts, input/output validation, namespaces, risk classes, permissions, invocation, canonical errors, and audit metadata. The MCP Connector Layer (`@aao/mcp-connector`, Sprint 10) implements Tools only: explicit host-controlled stdio sessions, bounded discovery, and trusted bindings into the existing Tool Runtime. Resources, prompts, sampling, HTTP, and OAuth are deferred. AAO owns MCP host behavior, authorization, exposure, orchestration, approval, state, traces, and evaluation; MCP is not the workflow engine.

## Governance Layer

Owns actors, roles, permissions, policies, risk classification, approval requirements, sensitive-data rules, and side-effect authorization. It remains deterministic.

Current `@aao/governance` resolves host-attested actors through explicit role bindings and deny policies into effective permission classes. Existing `@aao/authorization` then checks requested authority and the Agent ceiling. Tool Runtime separately gates unsupported permission classes. Approval waitpoints are implemented in `@aao/approval`; sensitive-data execution controls and side-effect authority remain future work; no model, workflow state, Tool input, MCP metadata, or memory may grant them.

## Durability Layer

Owns run persistence, checkpoints, resume, interruption recovery, persisted operation records, and replay protection. AAO owns the semantics while storage technology remains replaceable. AAO makes no exactly-once claim.

Implemented by `@aao/durability` (Sprint 14) behind a storage-neutral `DurabilityStore` port, with a local, single-host, single-writer filesystem reference store. The Runtime exposes only a generic durability port and `resumeWorkflow`; Approval exposes only a repository port. Tool Runtime and Governance contain no durability logic. Durability does not enable external side effects. See [durable execution](durable-execution.md).

## Observability and Evaluation Layers

Observability owns canonical execution truth: run and node events, model and tool calls, retries, approvals, checkpoints, latency, measurable token and cost use, evaluation results, errors, and artifacts. It is part of correctness, not decorative monitoring.

Since Sprint 15, `@aao/observability` owns the Trace Runtime. Execution packages emit through an optional, emit-only port, and observability depends only on `@aao/contracts`. Trace records authoritative decisions but never makes them. See [trace runtime](trace-runtime.md).

Since Sprint 16, Metrics are deterministic projections of Trace. They cover latency, retries, Tool/model usage, tokens, recovery, and modelled cost from explicit pricing, with no Metrics store. Audit is separate accountability evidence, recorded at authoritative source boundaries through an emit-only port into a hash-chained local `AuditStore`. Trace = chronology, Metrics = measurement, Audit = accountability, and none of them is execution authority. See [metrics](metrics.md), [audit](audit.md), and [ADR-021](../decisions/ADR-021-metrics-and-audit-boundaries.md).

Evaluation owns workflow and schema evaluation, tool-use and trace assertions, authorization tests, regression cases, safety tests, and model/capability benchmarks. A final response does not establish correct execution.

The [MCP connector](mcp-connector.md) owns protocol/session infrastructure. SDK objects and transport configuration never enter canonical contracts or workflow state. Discovery metadata cannot supply permissions, grants, capability assignments, or AAO state mutations; `executeTool` owns the governed invocation path.
