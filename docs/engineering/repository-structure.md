# Repository structure

This document describes only what exists in the repository today. It does not describe planned future packages (AAO Core, Integration Fabric, Capability Packs, Deployments) — see [ARCHITECTURE.md](../../ARCHITECTURE.md) and the [Flagship V1 roadmap](../roadmap/flagship-v1.md) for that direction.

```text
apps/
  control-plane/     AAO Control Plane — a local Fastify HTTP process
  worker/             AAO Worker — a local, separate process boundary

packages/
  framework/               @aao/framework — public developer surface: define* helpers, createAAO host, the aao CLI (Sprint 19)
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
  observability/           @aao/observability — Trace Runtime (Sprint 15); Trace-derived Metrics and hash-chained Audit (Sprint 16)
  evaluation/              @aao/evaluation — Evaluation Runtime: Evaluator Registry, deterministic graders, datasets, model-judge port (Sprint 17)
  mcp-connector/           @aao/mcp-connector — stdio sessions, discovery, explicit governed Tool bindings (Sprint 10)
  substrate-contracts/     research evidence, not production architecture
  substrate-spikes/        research evidence, not production architecture

evals/                versioned Eval definitions, datasets, evidence fixtures (Sprint 17), approved baselines and gate policies (Sprint 18)
experiments/          research notes accompanying the substrate spikes
docs/                  architecture contract, ADRs, engineering docs, and framework (developer) docs
```

## `packages/framework` — `@aao/framework`

The recommended consumer entry point (Sprint 19, [ADR-024](../decisions/ADR-024-public-framework-surface.md), [framework surface](../architecture/framework-surface.md)). It contains:

- `src/index.ts` — the explicit public root. It has no `export *`, and an exact snapshot test pins every value and type it exports.
- `src/definitions.ts` — the `define*` helpers. Each one validates a canonical `@aao/contracts` schema (or a canonical registration) and returns a deep-frozen copy.
- `src/app.ts` — `createAAO`. It composes a Governance registry, a Tool Registry, the Approval Engine, and a Node Registry with the canonical Tool, Approval, and `final_output` executors. The host's `principalForRun` is the only identity source.
- `src/cli/` — the canonical `aao` CLI, in TypeScript, compiled to `dist/cli/main.js` (the package `bin`). It has the workflow `validate`/`compile` commands and the Eval host (`eval/host.ts`, `ci.ts`, `adapters.ts`, `baseline.ts`, `network-guard.ts`). This is the only code that reads `evals/` from disk. It loads the test-owned adapter drivers by relative path from the sibling substrate packages' `conformance/` directories.
- `test/` — framework tests:
  - definitions, application host and security, Framework/lower-level equivalence, public API snapshot and boundaries, CLI, packaging, and executable quickstart examples;
  - `test/consumer/`, a fixture that imports only `@aao/framework`.
- `smoke/run-smoke.mjs` — compiled smoke. It compiles the consumer against `dist/` declarations, runs the compiled CLI, and inspects `pnpm pack` contents (`SPRINT_19_FRAMEWORK_SURFACE_SMOKE_OK`). `smoke/no-build.mjs` deletes the framework closure's `dist/` and proves `pnpm eval:ci` / `pnpm eval:adapters` still pass.

**Why Core never imports it.** The framework is a façade over Core: Core is the authority, and the façade only composes it. If a Core package imported the framework, a convenience layer could shape Core semantics, and dependencies would become circular. Ownership therefore runs one way, `@aao/framework → Core`, and a static test fails if any `packages/*/src`, substrate `conformance/` driver, app, or manifest references `@aao/framework`.

Production dependencies are `@aao/*` only:

- `@aao/approval`, `@aao/authorization`, `@aao/contracts`, `@aao/governance`, `@aao/runtime`, `@aao/tool-runtime`, and `@aao/workflow-dsl` for the root;
- `@aao/evaluation`, `@aao/observability`, `@aao/mcp-connector`, and `@aao/model-runtime` for the CLI's Eval and adapter-verification commands.

The root's import graph never reaches the CLI or the last four packages. The framework imports no vendor or framework SDK, and its package `exports` has only `"."`, typed from `dist/`. It is `private` and unpublished; its `files` allowlist ships compiled `.js`/`.d.ts` and the README only.

## `apps/control-plane` — `@aao/control-plane`

A Fastify HTTP process. `src/app.ts` owns Fastify construction and route registration and is testable without opening a TCP port (Fastify `inject()`); `src/server.ts` owns process startup: configuration loading, `listen()`, startup logging, and graceful shutdown on `SIGINT`/`SIGTERM`.

Routes: `GET /health/live` (is the process alive) and `GET /health/ready` (have the dependencies that currently exist — none yet — initialized). There is no database, queue, workflow runtime, model provider, or configured MCP server to check readiness against yet, so readiness is not faked for systems that do not exist.

## `apps/worker` — `@aao/worker`

A separate local process establishing the process boundary that future asynchronous/runtime execution will use. `src/worker.ts` owns a small `CREATED → RUNNING → STOPPED` process-lifecycle abstraction (distinct from the canonical AAO Workflow/Run lifecycle in [runtime-lifecycle.md](../architecture/runtime-lifecycle.md), which this is not). `src/main.ts` owns process wiring: configuration loading, starting the worker, and stopping it on `SIGINT`/`SIGTERM`.

The Worker performs no polling, no queue consumption, no job processing, no model execution, and no workflow execution in this sprint. A truthful idle process is the deliberate scope.

## `packages/config` — `@aao/config`

Deterministic, typed configuration loading for the Control Plane and Worker processes (`loadControlPlaneConfig(env)`, `loadWorkerConfig(env)`). Each loader takes an explicit environment object rather than reading `process.env` internally, so callers (and tests) can pass isolated environments. Invalid configuration throws `ConfigValidationError` immediately — there is no silent fallback for a malformed value. This package is not a general utilities package; it owns configuration only.

## `packages/contracts` — `@aao/contracts`

The canonical, framework-neutral, vendor-neutral production contract package (Sprint 2). Runtime-validatable Zod schemas — with TypeScript types inferred from them — for Workflow, Node, Edge, Run, State, Checkpoint, Agent, Skill, Model Policy, Tool, Capability, Permission, Policy Decision, Approval, Eval, Trace, Audit, Metrics, Artifact, Capability Pack references, and Company Configuration. Its only dependency is `zod`; it does not depend on `apps/*`, `packages/config`, or either `packages/substrate-*` package, and no app currently depends on it — adoption happens only when a real feature requires it. See [ADR-007](../decisions/ADR-007-canonical-domain-contracts.md) and [domain contracts](../architecture/domain-contracts.md).

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

Every runnable package (`packages/framework`, `packages/config`, `packages/contracts`, `packages/workflow-dsl`, `packages/runtime`, `packages/model-runtime`, `packages/agent-runtime`, `packages/tool-runtime`, `packages/authorization`, `packages/governance`, `packages/approval`, `packages/mcp-connector`, `packages/durability`, `packages/observability`, `packages/evaluation`, `apps/control-plane`, `apps/worker`) and the retained research packages each have their own `tsconfig.json` (typecheck, includes `src` and `test`) and `tsconfig.build.json` (build, excludes `test`, emits to that package's own `dist/`), both extending the shared [`tsconfig.base.json`](../../tsconfig.base.json) at the repository root. Each package builds independently; `pnpm build` runs every package's build script in dependency order (`pnpm -r`), so `@aao/config` compiles before the apps that depend on it. No `dist/` output is committed. See [local-development.md](local-development.md) for the day-to-day commands.

### `packages/observability`

The evidence layer: Trace (Sprint 15), Metrics and Audit (Sprint 16). It contains:

- a trace recorder implementing the Runtime's emit-only trace port;
- deterministic trace, span, and event identity;
- the metadata-only content policy;
- the `TraceStore` port with in-memory and local file (one immutable file per event) implementations;
- `validateTrace`, `compareTraceWithExecution`, and `reconstructRunTrace`;
- `src/metrics/`: `deriveRunMetrics` (Trace → RunMetrics), `aggregateRunMetrics`, nearest-rank percentiles, and exact-match explicit pricing. These are pure projections with no Metrics store;
- `src/audit/`: the Audit recorder (implements the contracts `AuditPort`), the SHA-256 hash chain, `AuditStore` with in-memory and local file implementations, and `validateAuditStream`;
- `src/health.ts` (`summarizeObservabilityHealth`, `checkAuditCompleteness`) and `src/local-files.ts`, the atomic immutable-file write path shared by the Trace and Audit file stores;
- canonical fixtures in `test/fixtures/traces/`, `test/fixtures/metrics/`, and `test/fixtures/audit/`;
- compiled smokes in `smoke/` (Sprint 15 Trace) and `smoke/sprint16/` (Metrics + Audit).

Its production dependencies are `@aao/contracts` and `zod` only, and no execution package depends on it. Approval, Tool Runtime, and Durability emit Audit only through the contracts `AuditPort`. See [ADR-020](../decisions/ADR-020-trace-runtime-and-observability-boundary.md), [ADR-021](../decisions/ADR-021-metrics-and-audit-boundaries.md), [trace runtime](../architecture/trace-runtime.md), [metrics](../architecture/metrics.md), and [audit](../architecture/audit.md).

### `packages/evaluation`

The Evaluation Runtime (Sprint 17) with analytics, CI gates, and adapter verification (Sprint 18). It contains:

- `src/evidence.ts` — the `EvalEvidenceBundle` boundary, defensive deep-freeze, the evidence fingerprint, and opaque evidence references;
- `src/registry.ts` — the constructible, version-exact Evaluator Registry;
- `src/runner.ts` — `evaluate()`, deterministic result identity, and the defensive grader boundary;
- `src/dataset.ts` — the YAML/JSON dataset and definition loaders, validation, the sequential `runEvalDataset`, and the static `EvidenceResolver`;
- `src/graders/` — ten deterministic graders (Approval compliance at 2.0.0, `aao.model-call` added in Sprint 18) plus the optional `ModelJudgePort` grader;
- `src/analytics/` — comparison keys and semantic verdict fingerprints, case expectation verdicts, suite reports, baselines, comparison, regression findings, multi-run analytics, and (Sprint 19) suite report / baseline integrity validation (pure);
- `src/gates/` — strict gate-policy parsing, the deterministic `evaluateEvalGate`, and report formatting;
- `src/conformance/` — canonical adapter verification scenarios, `verifyAdapter`, and semantic portability comparison;
- (Sprint 18's plain-ESM `cli/` host was migrated into the canonical `aao` CLI in `@aao/framework` in Sprint 19 and deleted; `pnpm eval:*` are aliases to it. Its Sprint 18 regression tests now drive that host.)
- tests for contracts, registry, graders, datasets, model judge, Runtime E2E, portability, privacy, non-authority, dependency boundaries, analytics, gate E2E, and adapter conformance;
- compiled smokes in `smoke/` (Sprint 17) and `smoke/sprint18/`.

Adapter verification drivers live with their substrates, as test-owned plain ESM that never imports `@aao/evaluation`: `packages/tool-runtime/conformance/`, `packages/mcp-connector/conformance/`, and `packages/model-runtime/conformance/`.

Its production dependencies are `@aao/contracts`, `@aao/observability` (canonical validators only), `yaml`, and `zod`. No execution package depends on it, and its `src/` touches no filesystem or network. The committed definitions, datasets, fixtures, baselines, and gate policies live in [`evals/`](../../evals/README.md). See [ADR-022](../decisions/ADR-022-evaluation-runtime-and-portable-verification.md), [ADR-023](../decisions/ADR-023-eval-analytics-ci-gates-and-adapter-verification.md), [evaluation runtime](../architecture/evaluation-runtime.md), [eval analytics & CI](../architecture/eval-analytics-ci.md), and [adapter verification](../architecture/adapter-verification.md).
