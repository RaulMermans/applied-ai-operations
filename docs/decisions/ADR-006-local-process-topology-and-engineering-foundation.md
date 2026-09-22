# ADR-006: Local process topology and engineering foundation

Status: accepted

## Context

Sprint 0 froze the AAO product and architecture contract without implementing anything runnable. Sprint 2 and later sprints need an engineering foundation — real process boundaries, deterministic configuration, package hygiene, builds, and CI — to implement canonical domain contracts against, without first repairing repository structure.

## Decision

- TypeScript and pnpm workspaces remain the baseline. A shared `tsconfig.base.json` at the repository root carries strict compiler settings (`strict`, `noUncheckedIndexedAccess`, `NodeNext` module resolution); every runnable package and research package has its own `tsconfig.json` (typecheck) and `tsconfig.build.json` (build, own `dist/`) extending it. There is no root aggregate tsconfig and no root-level TypeScript `paths` alias — cross-package resolution goes through normal pnpm workspace symlinks and each package's `package.json` (`types` pointing at source for typecheck-time resolution without a prior build; `main` pointing at compiled `dist/` for what actually runs).
- Fastify provides the local Control Plane's HTTP boundary (`apps/control-plane`), with application construction (`app.ts`) kept separate from process startup and lifecycle (`server.ts`).
- The Worker (`apps/worker`) is a separate OS process, not a thread or a mode of the Control Plane. It currently does nothing but hold a `CREATED → RUNNING → STOPPED` process lifecycle open until a termination signal arrives — no polling, queueing, or job execution.
- `@aao/config` owns current deterministic runtime configuration (`AAO_ENV`, `AAO_LOG_LEVEL`, `AAO_CONTROL_PLANE_HOST`, `AAO_CONTROL_PLANE_PORT`, `AAO_WORKER_ID`), validated with explicit environment objects rather than global `process.env` mutation, failing fast on invalid input.
- Local-first remains canonical: no deployment target is selected in this sprint. Docker, Kubernetes, a database, a queue, and cloud infrastructure are all still absent.
- The Control Center UI and any persistence layer remain deferred; nothing in this sprint depends on either existing.
- Process boundaries (Control Plane, Worker, `@aao/config` as a shared dependency) are shaped to remain portable to a future hosting decision — they assume nothing about where or how they are eventually deployed.
- This decision does not change AAO product architecture. It does not touch the Workflow DSL, runtime, governance, tool, or evaluation contracts; those remain Sprint 2+ work. See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the corrected diagram (Validator/Compiler now sits explicitly between the workflow specification and the runtime, matching [execution-model.md](../architecture/execution-model.md)).

## Consequences

- Sprint 2 can define canonical domain contracts (Workflow, Node, Run, Tool, Agent, Approval, Trace, Eval) without first fixing repository structure, process boundaries, configuration, builds, or CI.
- `packages/substrate-contracts` and `packages/substrate-spikes` remain Sprint 0A research evidence; production code (`apps/*`, `packages/config`) does not depend on them, and this sprint does not promote, rewrite, or delete any of that evidence.
- CI (`.github/workflows/ci.yml`) mirrors the local `typecheck → lint → test → build` sequence and performs no deployment, publish, or release step.
- Future AAO Core, Integration Fabric, Capability Packs, and Deployments packages remain unimplemented; nothing in this sprint precludes them, and no empty placeholder packages were created for them ahead of real implementation.
