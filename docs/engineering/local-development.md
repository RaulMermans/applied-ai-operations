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

Runs `typecheck → lint → build → test`, the same sequence CI runs (see [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)). Build runs before test because workspace packages resolve each other at runtime through their compiled `dist/` output (`package.json` `"main"`), not their TypeScript source — `pnpm typecheck` alone resolves types via each package's `"types"` field and does not need a prior build, but `pnpm test` alone (without a preceding `pnpm build`) will fail to resolve a cross-package import like `@aao/contracts` or `@aao/workflow-dsl` on a clean checkout.

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

## Local-first, no-deployment stance

There is no Docker, Kubernetes, database, message queue, cloud infrastructure, or deployment configuration in this repository. `apps/control-plane` and `apps/worker` are separate local processes you run directly with Node; nothing here assumes a hosting target. See [ADR-005](../decisions/ADR-005-local-first-typescript-architecture.md) and [ADR-006](../decisions/ADR-006-local-process-topology-and-engineering-foundation.md).
