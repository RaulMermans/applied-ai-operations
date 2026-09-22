# Repository structure

This document describes only what exists in the repository today. It does not describe planned future packages (AAO Core, Integration Fabric, Capability Packs, Deployments) — see [ARCHITECTURE.md](../../ARCHITECTURE.md) and the [Flagship V1 roadmap](../roadmap/flagship-v1.md) for that direction.

```text
apps/
  control-plane/     AAO Control Plane — a local Fastify HTTP process
  worker/             AAO Worker — a local, separate process boundary

packages/
  config/                  @aao/config — deterministic runtime configuration
  substrate-contracts/     research evidence, not production architecture
  substrate-spikes/        research evidence, not production architecture

experiments/          research notes accompanying the substrate spikes
docs/                  architecture contract, ADRs, and engineering docs
```

## `apps/control-plane` — `@aao/control-plane`

A Fastify HTTP process. `src/app.ts` owns Fastify construction and route registration and is testable without opening a TCP port (Fastify `inject()`); `src/server.ts` owns process startup: configuration loading, `listen()`, startup logging, and graceful shutdown on `SIGINT`/`SIGTERM`.

Routes: `GET /health/live` (is the process alive) and `GET /health/ready` (have the dependencies that currently exist — none yet — initialized). There is no database, queue, workflow runtime, model provider, or MCP connector to check readiness against yet, so readiness is not faked for systems that do not exist.

## `apps/worker` — `@aao/worker`

A separate local process establishing the process boundary that future asynchronous/runtime execution will use. `src/worker.ts` owns a small `CREATED → RUNNING → STOPPED` process-lifecycle abstraction (distinct from the canonical AAO Workflow/Run lifecycle in [runtime-lifecycle.md](../architecture/runtime-lifecycle.md), which this is not). `src/main.ts` owns process wiring: configuration loading, starting the worker, and stopping it on `SIGINT`/`SIGTERM`.

The Worker performs no polling, no queue consumption, no job processing, no model execution, and no workflow execution in this sprint. A truthful idle process is the deliberate scope.

## `packages/config` — `@aao/config`

Deterministic, typed configuration loading for the Control Plane and Worker processes (`loadControlPlaneConfig(env)`, `loadWorkerConfig(env)`). Each loader takes an explicit environment object rather than reading `process.env` internally, so callers (and tests) can pass isolated environments. Invalid configuration throws `ConfigValidationError` immediately — there is no silent fallback for a malformed value. This package is not a general utilities package; it owns configuration only.

## `packages/substrate-contracts` and `packages/substrate-spikes`

Sprint 0A research evidence for the [substrate recommendation](../decisions/ADR-000-substrate-recommendation.md): executable spikes proving LangGraph.js, the Vercel AI SDK, and the MCP TypeScript SDK can sit behind AAO-owned contracts. **They are research evidence, not production AAO architecture.** Production code (`apps/*`, `packages/config`) does not import them. A later sprint will explicitly classify each concept as `PROMOTE`, `REWRITE`, `ARCHIVE`, or `DELETE`.

## `experiments/`

Narrative research notes (durability, graph runtime, integrations, MCP, model layer) accompanying the substrate spikes. Also research evidence, not production documentation.

## `docs/`

- `docs/product/`, `docs/architecture/`, `docs/security/`, `docs/roadmap/` — the frozen Sprint 0 product and architecture contract.
- `docs/decisions/` — ADRs, the canonical decision record.
- `docs/research/` — Sprint 0A substrate evaluation evidence.
- `docs/engineering/` — this document and [local-development.md](local-development.md), the Sprint 1 engineering foundation.

## Build and typecheck shape

Every runnable package (`packages/config`, `apps/control-plane`, `apps/worker`) and the retained research packages each have their own `tsconfig.json` (typecheck, includes `src` and `test`) and `tsconfig.build.json` (build, excludes `test`, emits to that package's own `dist/`), both extending the shared [`tsconfig.base.json`](../../tsconfig.base.json) at the repository root. Each package builds independently; `pnpm build` runs every package's build script in dependency order (`pnpm -r`), so `@aao/config` compiles before the apps that depend on it. No `dist/` output is committed. See [local-development.md](local-development.md) for the day-to-day commands.
