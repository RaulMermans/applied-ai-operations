# ADR-036 — RE:VERSE is an application boundary, not an AAO Core extension

Status: Accepted  
Date: 2026-11-21

## Context

RE:VERSE (Codegeist 2026) adds a release-assurance product, RollbackProof, that needs PostgreSQL, Docker (Testcontainers) and Atlassian Forge/Bitbucket. AGENTS.md requires AAO to stay provider-neutral and to keep one canonical contract per concept.

## Decision

1. RE:VERSE lives in `apps/reverse` as the private workspace app `@aao/reverse`. It consumes AAO (`@aao/contracts` today); AAO never depends on it.
2. PostgreSQL (`pg`, `testcontainers`) and Atlassian/Forge dependencies are allowed only under `apps/reverse`. A unit test fails if any `packages/*` or `examples/*` manifest declares them.
3. The RollbackProof verdict contract (`PASS` / `FAIL` / `INCONCLUSIVE`, evidence fields) is owned by RE:VERSE (`apps/reverse/src/domain/contract.ts`). No `@aao/assurance` package until a second consumer justifies one.
4. Execution (did the runner finish?) and compatibility (did v1 satisfy declared invariants?) are separate results. Only a deterministic evaluator issues the verdict. Infrastructure failures, timeouts and missing evidence are always `INCONCLUSIVE`.
5. The Forge app (`apps/reverse/forge`) is a standalone Forge project, not a workspace package. Sprint 0 limits it to a deterministic probe that never claims RollbackProof ran.
6. Docker-backed tests run only through `pnpm --filter @aao/reverse test:integration`. They sit outside the root `pnpm test` glob, so the AAO Local V1 release gate gains no Docker dependency.

## Consequences

- The AAO release gate is unchanged. RE:VERSE's Docker evidence is a separate, explicit command.
- Promoting any RE:VERSE contract into AAO requires a later ADR with evidence of a second consumer.
