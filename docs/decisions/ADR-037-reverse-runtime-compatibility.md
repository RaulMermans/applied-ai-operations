# ADR-037 — RE:VERSE runtime split: Node 20 workspace, Node 22 Forge

Status: Accepted  
Date: 2026-11-21

## Context

AAO pins Node `>=20.20.0 <21` and pnpm 10.26.0. Forge CLI 15.x requires Node 22.23.4+ or 24.22.1+. The current Forge runtimes are `nodejs22.x` and `nodejs24.x`; `nodejs20.x` reached end of life on 2026-04-30. `testcontainers@12` requires Node `>=22.22` because undici 8 needs Node 22.19+.

## Decision

1. `@aao/reverse` (runner, evaluator, tests) runs on the AAO Node 20 toolchain. No global runtime upgrade.
2. Testcontainers is pinned to `11.14.0` (undici 7, Node 20.18.1+) until AAO moves off Node 20. `pg` is pinned to `8.23.1`.
3. The Forge app declares `runtime: nodejs22.x` and is driven by the Forge CLI on a separate Node 22 install (nvm). The Forge app has no npm dependencies and is not a pnpm workspace member.
4. PostgreSQL is pinned by tag and digest: `postgres:16.10-alpine@sha256:0296…2297`.

## Consequences

- Upgrading AAO to Node 22 unblocks `testcontainers@12`. That upgrade needs its own decision.
- Forge commands must run with Node 22 on `PATH` from `apps/reverse/forge`.
