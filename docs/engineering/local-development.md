# Local development

AAO is local-first: there is no deployment target, cloud infrastructure, or hosted dependency. Everything in this document runs on your machine.

## Prerequisites

- Node.js `20.20.0` (see `.nvmrc`; `engines.node` in [package.json](../../package.json) enforces `>=20.20.0 <21.0.0`)
- pnpm `10.26.0` (pinned via `packageManager` in `package.json`)

If you use `nvm`, `nvm use` picks up `.nvmrc` automatically.

## Install

```sh
pnpm install --frozen-lockfile
```

## Configuration

Runtime configuration is owned by [`@aao/config`](../../packages/config) and loaded from environment variables. See [`.env.example`](../../.env.example) for the recognized variables and local defaults:

| Variable | Used by | Default |
| --- | --- | --- |
| `AAO_ENV` | Control Plane, Worker | `development` |
| `AAO_LOG_LEVEL` | Control Plane, Worker | `info` |
| `AAO_CONTROL_PLANE_HOST` | Control Plane | `127.0.0.1` |
| `AAO_CONTROL_PLANE_PORT` | Control Plane | `4000` |
| `AAO_WORKER_ID` | Worker | `aao-worker-local` |

All values are optional locally; invalid values (an unrecognized `AAO_ENV`/`AAO_LOG_LEVEL`, or a port outside `1`-`65535`) fail fast with a `ConfigValidationError` at process startup rather than starting in an unknown state. No `.env` file is committed; copy `.env.example` to `.env` if you want to override defaults.

## Run the Control Plane

```sh
pnpm dev:control-plane
```

Starts a Fastify server (default `http://127.0.0.1:4000`) via `tsx watch`, so edits to `apps/control-plane/src` restart it automatically. Try:

```sh
curl http://127.0.0.1:4000/health/live
curl http://127.0.0.1:4000/health/ready
```

Stop it with `Ctrl+C` (`SIGINT`); it closes Fastify before exiting.

## Run the Worker

```sh
pnpm dev:worker
```

Starts an idle Worker process via `tsx watch`. It performs no job processing — see [repository-structure.md](repository-structure.md) for what the Worker does and does not do in this sprint. Stop it with `Ctrl+C`.

## Tests

```sh
pnpm test        # run once
pnpm test:watch  # watch mode
```

`pnpm test` is valid on its own from a clean checkout (`pnpm install --frozen-lockfile && pnpm test`, no prior `pnpm build` needed): the root [`vitest.config.ts`](../../vitest.config.ts) aliases each `@aao/*` workspace package straight to its TypeScript source for the Vitest/Vite module graph, rather than relying on `package.json` `"main"` (which points at compiled `dist/` output). This only affects how Vitest resolves imports; `pnpm build`'s output and every package's `"main"`/`"types"` fields are unchanged, and tests always run against current source rather than a possibly stale `dist/`.

## Typecheck

```sh
pnpm typecheck
```

Runs `tsc --noEmit` in every workspace package (`pnpm -r --if-present run typecheck`).

## Lint

```sh
pnpm lint
```

## Build

```sh
pnpm build
```

Runs each package's own `tsc -p tsconfig.build.json` in dependency order (`pnpm -r --if-present run build`), so `@aao/config` compiles before the apps that depend on it. Each package/app produces its own `dist/` (gitignored, never committed) and runs from that compiled JavaScript — it does not rely on root-level TypeScript path aliases at runtime.

## Full verification

```sh
pnpm check
```

Runs `typecheck → lint → build → test → aao eval ci → aao eval adapters` (the last two call the just-built CLI directly, `node packages/framework/dist/cli/main.js`), the same sequence CI runs (see [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)). This ordering verifies the actually-shipped build (compiled apps and packages resolving each other through `dist/`, as they do outside of tests — see "Compiled smoke verification" below), in addition to the tests already having run correctly on their own (see "Tests" above).

## Eval quality gate and adapter verification

The deterministic Eval commands are the canonical `aao` CLI ([CLI](../framework/cli.md)); the `pnpm eval:*` scripts are aliases. No prior `pnpm build` is needed: each alias first builds `@aao/framework` and its dependency closure, then runs the compiled CLI, so it never executes stale `dist/`. They are offline: no API keys, providers, or network, and a guard fails the command on any connection attempt.

```sh
pnpm eval:ci                       # foundation gate: PASS/WARN exit 0, hard failure or gate error exit 1
pnpm eval:ci -- --format json      # machine-readable decision (no ANSI)
pnpm eval:adapters                 # adapter conformance: native Tool, MCP, native model, Vercel AI SDK
pnpm eval:baseline:propose -- --id runtime-foundation --version <v>   # prints a proposal; writes nothing
pnpm aao workflow validate <file>  # canonical workflow validation (also: workflow compile)
```

See [eval analytics & CI](../architecture/eval-analytics-ci.md), [adapter verification](../architecture/adapter-verification.md), and [`evals/baselines/README.md`](../../evals/baselines/README.md) for the baseline review workflow. CI never writes a baseline.

## Compiled smoke verification

A successful `pnpm build` proves compilation, not that the emitted process actually runs. After `pnpm build`, verify the compiled apps directly:

```sh
# Control Plane
AAO_CONTROL_PLANE_PORT=4177 node apps/control-plane/dist/server.js &
CP_PID=$!
sleep 1
curl -i http://127.0.0.1:4177/health/live
curl -i http://127.0.0.1:4177/health/ready
kill -TERM $CP_PID   # graceful shutdown; the process logs "stopped" and exits
wait $CP_PID 2>/dev/null

# Worker
AAO_WORKER_ID=smoke-worker node apps/worker/dist/main.js &
W_PID=$!
sleep 1
kill -TERM $W_PID     # graceful shutdown; the process logs "stopped" and exits
wait $W_PID 2>/dev/null
```

Both processes log structured JSON lines (`started`, `shutting_down`, `stopped`) to stdout and exit `0` after a clean shutdown, with no process left behind.

Built-package acceptance smokes for the MCP, Tool, Approval, Reliability, Durability, Trace, Metrics/Audit, Evaluation, Eval analytics/CI, Framework, adapter-contract, and Toolbox layers use only `dist/` output:

```sh
node packages/mcp-connector/test/smoke.mjs               # SPRINT_10_MCP_CONNECTOR_SMOKE_OK
node packages/tool-runtime/test/governance-smoke.mjs     # SPRINT_11_GOVERNANCE_SMOKE_OK
node packages/approval/smoke.mjs                         # SPRINT_12_APPROVAL_ENGINE_SMOKE_OK
node packages/tool-runtime/test/reliability-smoke.mjs    # SPRINT_13_RELIABILITY_RUNTIME_SMOKE_OK
pnpm --filter @aao/durability smoke                      # SPRINT_14_DURABLE_EXECUTION_SMOKE_OK
pnpm --filter @aao/observability smoke                   # SPRINT_15_TRACE_RUNTIME_SMOKE_OK
pnpm --filter @aao/observability smoke:metrics-audit     # SPRINT_16_METRICS_AUDIT_SMOKE_OK
pnpm --filter @aao/evaluation smoke                      # SPRINT_17_EVALUATION_RUNTIME_SMOKE_OK
pnpm --filter @aao/evaluation smoke:sprint18             # SPRINT_18_EVAL_ANALYTICS_CI_ADAPTER_VERIFICATION_SMOKE_OK
pnpm --filter @aao/framework smoke                       # SPRINT_19_FRAMEWORK_SURFACE_SMOKE_OK
pnpm --filter @aao/framework smoke:no-build              # SPRINT_19_NO_BUILD_EVAL_ALIASES_OK (deletes the framework closure's dist/, then runs pnpm eval:ci / eval:adapters)
pnpm --filter @aao/framework smoke:sprint20              # SPRINT_20_ADAPTER_PORTABILITY_CONTRACT_SMOKE_OK
pnpm --filter @aao/toolbox smoke:sprint21                # SPRINT_21_TOOLBOX_FOUNDATION_SMOKE_OK (dist-only consumer, Trace, Tool-usage Eval, catalog drift, pack contents)
```

The durability smoke runs three separate Node processes over one temporary directory, which it deletes afterward:

1. The first process runs to a durable approval wait.
2. The second approves, resumes, and exits inside an idempotent `write_draft` Tool.
3. The third recovers by replaying with the same `toolExecutionId` and completes.

Durable tests and the smoke use temporary directories only. No durability root is configured by default; a host constructs `createFileDurabilityStore({ root })` explicitly.

## Local-first, no-deployment stance

There is no Docker, Kubernetes, database, message queue, cloud infrastructure, or deployment configuration in this repository. Durable execution uses plain local files under an explicitly chosen directory. `apps/control-plane` and `apps/worker` are separate local processes you run directly with Node; nothing here assumes a hosting target. See [ADR-005](../decisions/ADR-005-local-first-typescript-architecture.md) and [ADR-006](../decisions/ADR-006-local-process-topology-and-engineering-foundation.md).

The Trace smoke runs a compiled single-process flagship workflow and prints its 24-event timeline: approval wait, approval, Tool transient failure, retry, success, and completion. It then runs two separate Node processes over one temporary root: Process A reaches the durable wait, and Process B reopens the durability and Trace stores, approves, and completes the same trace. It checks that the trace id is unchanged, the sequence is contiguous, and there is one `run.started` and one terminal event. Tracing is opt-in: no Trace root is configured by default, so a host constructs `createFileTraceStore({ root })` and `createTraceRecorder({ store })` explicitly.

The Metrics and Audit smoke runs two parts:

1. **One process.** It runs the compiled flagship. Bob approves at T1, and the Runtime continues at T2. The Tool fails transiently, retries, and succeeds. The smoke derives `RunMetrics` and `AggregateMetrics` and checks duration, approval wait, retries, physical vs logical Tool calls, approvals, and tokens. It verifies the Audit chain and that the Audit resolution is at T1 while the Trace resolution is at T2. It then runs a real Model Runtime Run and checks explicit-pricing cost, and that missing pricing stays unavailable.
2. **Two processes.** Process A reaches the durable wait. Process B approves, resumes, and verifies that Metrics are not double-counted across the restart and that the continued Audit stream is valid.

Audit is opt-in, like Trace: a host constructs `createFileAuditStore({ root })` and `createAuditRecorder({ store })` and passes the recorder as `audit` to the Approval Engine, Tool Node, and durable host.

The Evaluation Runtime smoke runs entirely from compiled `dist/` output in three parts:

1. **Offline.** It loads `evals/definitions/runtime-foundation.v1.yaml` and `evals/datasets/runtime-foundation.v2.yaml`, maps `fixture://<name>` to `evals/fixtures/<name>.json` explicitly (the host, not the evaluator, reads files), and runs every deterministic grader. Each of the 35 cases must match its stated expectation, and a repeat run must be identical.
2. **Model judge.** It runs a bounded fake model judge through the injected port: one call, a structured score, and no subject persisted. A throwing judge must yield `error`.
3. **Runtime.** It runs a real compiled flagship Run (approval, retry-safe Tool, completion with Trace and Audit) and evaluates it in `RUNTIME` mode after the Runtime returned. It checks that execution evidence is unchanged.

Eval fixtures regenerate deterministically under `pnpm test`; see [`evals/README.md`](../../evals/README.md).

The Core Toolbox catalog (`docs/generated/toolbox-core.json`, `docs/toolbox/core-tools.md`) is generated from the canonical Toolbox with `pnpm build && pnpm --filter @aao/toolbox catalog:generate`. After a Toolbox change, `test/generated-catalog.test.ts` fails until the regenerated files are committed.

## Operator Control Center (Sprint 27)

`pnpm dev:control-plane` serves the read-only Control Center at `http://127.0.0.1:4000/` (loopback only; inspection routes are disabled on other hosts). `pnpm proof:operator-inspection` prints the offline demo; `node examples/operator-inspection/smoke/sprint27.mjs` runs the compiled smoke.

## Local V1 release qualification (Sprint 30)

```sh
pnpm --filter @aao/example-release-consumer proof
pnpm benchmark:local-v1
pnpm release:verify:local-v1 --after-core   # after `pnpm check`; omit --after-core to include check
```

See [getting started](../guides/getting-started-local-v1.md) and [acceptance](../release/local-v1-acceptance.md).
