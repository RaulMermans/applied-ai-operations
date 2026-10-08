# Repository structure

This document describes only what exists in the repository today. It does not describe planned future packages (AAO Core, Integration Fabric, Capability Packs, Deployments) — see [ARCHITECTURE.md](../../ARCHITECTURE.md) and the [Flagship V1 roadmap](../roadmap/flagship-v1.md) for that direction.

```text
apps/
  control-plane/     AAO Control Plane — a local Fastify HTTP process
  worker/             AAO Worker — a local, separate process boundary

packages/
  config/                  @aao/config — deterministic runtime configuration
  contracts/               @aao/contracts — canonical domain contracts (Sprint 2)
  workflow-dsl/            @aao/workflow-dsl — workflow authoring, validation, and compiler (Sprint 3)
  runtime/                 @aao/runtime — Node Registry, Runtime V1 (Sprint 4), and managed run state/lifecycle (Sprint 5)
  model-runtime/           @aao/model-runtime — model contracts, capability routing, AI SDK adapter, model node (Sprint 6)
  agent-runtime/           @aao/agent-runtime — bounded Agent registry, controller, decision contract, agent node (Sprint 7)
  tool-runtime/            @aao/tool-runtime — Tool Registry, safe Tool execution boundary, tool node (Sprint 8)
  authorization/           @aao/authorization — Authorization Context, deterministic permission evaluator (Sprint 9)
  approval/                @aao/approval — human approval engine, repository port, and node executor (Sprint 12; durable-capable Sprint 14)
  durability/              @aao/durability — durable checkpoints, operation ledger, crash recovery, file store, durable host (Sprint 14)
  observability/           @aao/observability — Trace Runtime: recorder, in-memory/file Trace Stores, identity, content policy, validator (Sprint 15)
  mcp-connector/           @aao/mcp-connector — stdio sessions, discovery, explicit governed Tool bindings (Sprint 10)
  substrate-contracts/     research evidence, not production architecture
  substrate-spikes/        research evidence, not production architecture

experiments/          research notes accompanying the substrate spikes
docs/                  architecture contract, ADRs, and engineering docs
```

## `apps/control-plane` — `@aao/control-plane`

A Fastify HTTP process. `src/app.ts` owns Fastify construction and route registration and is testable without opening a TCP port (Fastify `inject()`); `src/server.ts` owns process startup: configuration loading, `listen()`, startup logging, and graceful shutdown on `SIGINT`/`SIGTERM`.

Routes: `GET /health/live` (is the process alive) and `GET /health/ready` (have the dependencies that currently exist — none yet — initialized). There is no database, queue, workflow runtime, model provider, or configured MCP server to check readiness against yet, so readiness is not faked for systems that do not exist.

## `apps/worker` — `@aao/worker`

A separate local process establishing the process boundary that future asynchronous/runtime execution will use. `src/worker.ts` owns a small `CREATED → RUNNING → STOPPED` process-lifecycle abstraction (distinct from the canonical AAO Workflow/Run lifecycle in [runtime-lifecycle.md](../architecture/runtime-lifecycle.md), which this is not). `src/main.ts` owns process wiring: configuration loading, starting the worker, and stopping it on `SIGINT`/`SIGTERM`.

The Worker performs no polling, no queue consumption, no job processing, no model execution, and no workflow execution in this sprint. A truthful idle process is the deliberate scope.

## `packages/config` — `@aao/config`

Deterministic, typed configuration loading for the Control Plane and Worker processes (`loadControlPlaneConfig(env)`, `loadWorkerConfig(env)`). Each loader takes an explicit environment object rather than reading `process.env` internally, so callers (and tests) can pass isolated environments. Invalid configuration throws `ConfigValidationError` immediately — there is no silent fallback for a malformed value. This package is not a general utilities package; it owns configuration only.

## `packages/contracts` — `@aao/contracts`

The canonical, framework-neutral, vendor-neutral production contract package (Sprint 2). Runtime-validatable Zod schemas — with TypeScript types inferred from them — for Workflow, Node, Edge, Run, State, Checkpoint, Agent, Skill, Model Policy, Tool, Capability, Permission, Policy Decision, Approval, Eval, Trace, Artifact, Capability Pack references, and Company Configuration. Its only dependency is `zod`; it does not depend on `apps/*`, `packages/config`, or either `packages/substrate-*` package, and no app currently depends on it — adoption happens only when a real feature requires it. See [ADR-007](../decisions/ADR-007-canonical-domain-contracts.md) and [domain contracts](../architecture/domain-contracts.md).

## `packages/workflow-dsl` — `@aao/workflow-dsl`

The Workflow DSL and compiler (Sprint 3). Parses YAML/JSON workflow source into the canonical `Workflow` shape (via `@aao/contracts`'s `WorkflowSchema`), performs graph-level semantic validation deferred by ADR-007 (node uniqueness, entry/edge reference integrity, reachability, terminal semantics, routing ambiguity, cycle rejection), and compiles a valid workflow into a framework-neutral, JSON-safe, deterministic `CompiledWorkflowPlan`. Its production dependencies are `@aao/contracts`, `yaml`, and `zod` (the last for `CompiledWorkflowPlanSchema`, a defensive runtime-validatable schema for the plan it produces — see ADR-009); it does not depend on LangGraph, Fastify, `apps/*`, or either `packages/substrate-*` package. See [ADR-008](../decisions/ADR-008-workflow-dsl-and-compiler.md) and [workflow DSL](../architecture/workflow-dsl.md).

## `packages/runtime` — `@aao/runtime`

The Node Registry, Runtime V1 (Sprint 4), and managed run state/lifecycle (Sprint 5). Consumes a `CompiledWorkflowPlan` (never parses workflow source itself) and executes it as a *managed* run: a constructible, non-global Node Registry; a runtime preflight that rejects conditional routing and missing node executors before any node runs; a deterministic sequential engine that applies validated, JSON-safe state patches and follows the plan's unconditional routing; an authoritative Run lifecycle and Node lifecycle; an explicit clock boundary; safe, in-memory `RuntimeExecutionSnapshot` capture at every safe boundary; a generic durability port and `resumeWorkflow` (Sprint 14); and a small structured Runtime failure taxonomy. Its production dependencies are `@aao/contracts`, `@aao/workflow-dsl`, and `zod`; it does not depend on LangGraph, the Vercel AI SDK, the MCP SDK, Fastify, `apps/*`, or either `packages/substrate-*` package, and no app currently depends on it. Persistence lives in `@aao/durability`, which depends on it, never the reverse, and there is no run-scheduling layer yet. See [ADR-009](../decisions/ADR-009-node-registry-and-runtime-v1.md)/[ADR-010](../decisions/ADR-010-managed-runtime-state-and-lifecycle.md) and [runtime V1](../architecture/runtime-v1.md)/[runtime state management](../architecture/runtime-state-management.md).

## `packages/model-runtime` — `@aao/model-runtime`

The provider-neutral Model Runtime (Sprint 6): `ModelRequest`/`ModelResult`/`ModelFailure` contracts, an explicit Model Registry and Model Policy Registry (canonical `ModelPolicySpec`), a deterministic capability router, the `ModelAdapter` contract, the Vercel AI SDK adapter (exported only from the `@aao/model-runtime/vercel-ai` subpath — the only module importing `ai`), and `createModelNodeExecutor`, the `model` `NodeExecutor`. Production dependencies: `@aao/contracts`, `@aao/runtime`, `ai`, `ajv`, `zod`; no provider SDK, LangGraph, MCP SDK, Fastify, `apps/*`, or `packages/substrate-*`. See [ADR-011](../decisions/ADR-011-model-runtime-and-capability-routing.md) and [model runtime](../architecture/model-runtime.md).

## `packages/agent-runtime` — `@aao/agent-runtime`

The bounded Agent Runtime (Sprint 7): `RegisteredAgent` bindings (canonical `AgentSpec` + instructions + limits), an explicit version-exact `AgentRegistry`, the fail-closed `resolveExecutableAgent` support gate, the `AgentDecision` contract, the deterministic `executeAgent` controller, and `createAgentNodeExecutor`, the `agent` `NodeExecutor`. Production dependencies: `@aao/contracts`, `@aao/runtime`, `@aao/model-runtime`, `zod`; `ai` and `@aao/workflow-dsl` are test-only. It never imports the AI SDK, a provider SDK, LangGraph, MCP, Fastify, `apps/*`, or `packages/substrate-*`. See [ADR-012](../decisions/ADR-012-bounded-agent-runtime.md) and [agent runtime](../architecture/agent-runtime.md).

## `packages/tool-runtime` — `@aao/tool-runtime`

The Tool Runtime (Sprint 8): `RegisteredTool` bindings (canonical `ToolSpec` + trusted handler), an explicit version-exact `ToolRegistry` that compiles Tool JSON Schemas with strict Ajv at registration, the V1 permission support gate, the canonical `executeTool` path, deterministic workflow-owned Tool execution ids, and `createToolNodeExecutor`, the `tool` `NodeExecutor`. Since Sprint 9 every execution is authorized through `@aao/authorization`, and the public registry is inspection-only. Production dependencies: `@aao/authorization`, `@aao/contracts`, `@aao/runtime`, `ajv`, `zod`; `@aao/workflow-dsl` is test-only. It never imports the AI SDK, a provider or vendor SDK, MCP, LangGraph, Fastify, `@aao/model-runtime`, `@aao/agent-runtime`, `apps/*`, or `packages/substrate-*`. See [ADR-013](../decisions/ADR-013-tool-registry-and-safe-execution-boundary.md) and [tool runtime](../architecture/tool-runtime.md).

## `packages/authorization` — `@aao/authorization`

The Authorization Boundary (Sprint 9): strict `AuthorizationContext`, `AuthorizationRequest`, and `AuthorizationDecision` contracts, the pure `authorize()` evaluator, and `agentAuthorityFromSpec`. Production dependencies: `@aao/contracts`, `zod`. It imports no Runtime package, AI SDK, MCP, provider SDK, Fastify, or `apps/*`. See [ADR-014](../decisions/ADR-014-authorization-and-permission-enforcement.md) and [authorization](../architecture/authorization.md).

## `packages/approval` — `@aao/approval`

The Approval Engine over an `ApprovalRepository` port (in-memory by default), exact-request fingerprinting, host-attested human resolver checks through Governance, and the trusted Approval Node executor. Production dependencies: `@aao/contracts`, `@aao/runtime`, `@aao/governance`, `zod`; Workflow DSL, Tool Runtime, and Authorization are test-only. It provides validated continuation with revalidation of current authority. It does no storage of its own (the durable repository lives in `@aao/durability`), and has no scheduler, UI, notifications, or external side-effect execution. See [ADR-017](../decisions/ADR-017-human-approval-and-runtime-waitpoints.md) and [approval engine](../architecture/approval-engine.md).

## `packages/durability` — `@aao/durability`

Durable execution (Sprint 14). Its parts:

- AAO-owned `RunManifest`, `DurableCheckpoint`, `DurableOperation`, and `CancellationRecord` contracts, and the canonical plan fingerprint.
- The storage-neutral `DurabilityStore` port and the local filesystem reference store (atomic writes, single host, single writer), including a durable `ApprovalRepository`.
- The deterministic recovery planner and `createDurableRuntimeHost` (`execute`, `resume`, `getRun`, `getApproval`, `requestCancellation`).

Production dependencies: `@aao/contracts`, `@aao/runtime`, `@aao/approval`, `@aao/workflow-dsl`, `zod`. Governance and Tool Runtime are test-only. No package depends on it. After `pnpm build`, run `pnpm --filter @aao/durability smoke` for the real multi-process restart smoke. See [ADR-019](../decisions/ADR-019-durable-execution-checkpoints-and-replay.md) and [durable execution](../architecture/durable-execution.md).

## `packages/mcp-connector` — `@aao/mcp-connector`

The sole production MCP boundary (Sprint 10): explicit isolated stdio sessions, bounded Tools discovery, host-owned `McpToolBinding` → normal `RegisteredTool`, and safe structured-result/error normalization. Production dependencies: `@aao/contracts`, `@aao/tool-runtime`, official MCP SDK `1.30.0`, `zod`. Runtime/Authorization test dependencies are test-only. No direct invocation API is exported. See [ADR-015](../decisions/ADR-015-mcp-integration-boundary-and-tool-adapter-sessions.md) and [MCP connector](../architecture/mcp-connector.md). After `pnpm build`, run `pnpm --filter @aao/mcp-connector smoke` for compiled real-stdio evidence.

## `packages/substrate-contracts` and `packages/substrate-spikes`

Sprint 0A research evidence for the [substrate recommendation](../decisions/ADR-000-substrate-recommendation.md): executable spikes proving LangGraph.js, the Vercel AI SDK, and the MCP TypeScript SDK can sit behind AAO-owned contracts. **They are research evidence, not production AAO architecture.** Production code (`apps/*`, `packages/config`) does not import them. Sprint 10 classifies the MCP spike as `KEEP_AS_HISTORICAL_EVIDENCE`: its toy permission check is not production authorization, and no production package imports it. Other concepts still need classification as `PROMOTE`, `REWRITE`, `ARCHIVE`, or `DELETE`.

## `experiments/`

Narrative research notes (durability, graph runtime, integrations, MCP, model layer) accompanying the substrate spikes. Also research evidence, not production documentation.

## `docs/`

- `docs/product/`, `docs/architecture/`, `docs/security/`, `docs/roadmap/` — the frozen Sprint 0 product and architecture contract.
- `docs/decisions/` — ADRs, the canonical decision record.
- `docs/research/` — Sprint 0A substrate evaluation evidence.
- `docs/engineering/` — this document and [local-development.md](local-development.md), the Sprint 1 engineering foundation.

## Build and typecheck shape

Every runnable package (`packages/config`, `packages/contracts`, `packages/workflow-dsl`, `packages/runtime`, `packages/model-runtime`, `packages/agent-runtime`, `packages/tool-runtime`, `packages/authorization`, `packages/approval`, `packages/mcp-connector`, `apps/control-plane`, `apps/worker`) and the retained research packages each have their own `tsconfig.json` (typecheck, includes `src` and `test`) and `tsconfig.build.json` (build, excludes `test`, emits to that package's own `dist/`), both extending the shared [`tsconfig.base.json`](../../tsconfig.base.json) at the repository root. Each package builds independently; `pnpm build` runs every package's build script in dependency order (`pnpm -r`), so `@aao/config` compiles before the apps that depend on it. No `dist/` output is committed. See [local-development.md](local-development.md) for the day-to-day commands.

### `packages/observability`

The Trace Runtime (Sprint 15). It contains:

- a trace recorder implementing the Runtime's emit-only trace port;
- deterministic trace, span, and event identity;
- the metadata-only content policy;
- the `TraceStore` port with in-memory and local file (one immutable file per event) implementations;
- `validateTrace`, `compareTraceWithExecution`, and `reconstructRunTrace`;
- canonical trace fixtures in `test/fixtures/traces/`;
- a compiled two-process smoke in `smoke/`.

Its production dependencies are `@aao/contracts` and `zod` only, and no execution package depends on it. See [ADR-020](../decisions/ADR-020-trace-runtime-and-observability-boundary.md) and [trace runtime](../architecture/trace-runtime.md).
