# RE:VERSE — prove the way back before you ship

An AAO application for the Atlassian Codegeist 2026 entry. Its first capability, **RollbackProof**, checks whether a PostgreSQL migration still lets the previous application version (v1) run after the migration and v2 writes.

Status: **Sprint 0 spike.** Initiative, evidence and blockers are in [docs/initiatives/reverse-codegeist-2026.md](../../docs/initiatives/reverse-codegeist-2026.md). Boundaries are set by ADR-036 and ADR-037.

## Layout

| Path | Purpose |
|------|---------|
| `src/fixtures/payment-ledger.ts` | Synthetic ledger fixtures, the v1/v2 SQL contracts, and the scenario allowlist |
| `src/runner/` | Ephemeral PostgreSQL 16 (Testcontainers) and the rehearsal runner. It records execution only. |
| `src/domain/` | Report contract (zod) and the independent deterministic evaluator |
| `src/cli.ts` | Runs every scenario N times and writes `out/rollbackproof-report.json` (gitignored) |
| `test/` | Docker-free unit tests, run by root `pnpm test` |
| `integration/` | Docker-backed tests against real PostgreSQL 16 |
| `forge/` | Standalone Forge `bitbucket:mergeCheck` feasibility probe (Node 22). Not integrated with RollbackProof. |

## Commands (Node 20 / AAO toolchain)

```bash
pnpm --filter @aao/reverse typecheck
pnpm --filter @aao/reverse test:unit          # no Docker
pnpm --filter @aao/reverse test:integration   # needs a local Docker daemon
pnpm --filter @aao/reverse rollbackproof 5    # 5 repeats, writes out/rollbackproof-report.json
```

A report lists `classification` for each run. `EXPECTED_NEGATIVE` means the deliberately incompatible scenario was correctly rejected. `INCONCLUSIVE_NOT_A_VERDICT` covers infrastructure failures, timeouts and missing evidence.

## Forge probe (needs an authorized Atlassian account; not done in Sprint 0)

```bash
export PATH=~/.nvm/versions/node/v22.23.4/bin:$PATH   # Forge CLI needs Node 22.23.4+ / 24.22.1+
cd apps/reverse/forge
forge login                       # Atlassian API token for a test account
forge register                    # replaces the placeholder app.id in manifest.yml
forge deploy -e development
forge install -e development      # pick Bitbucket and a TEAM workspace (personal workspaces are unsupported)
```

Then go to Workspace settings → Workflow → Custom merge checks → Enable. In the repository, open Settings → Workflow → Custom merge checks → Add check. Making the check *Required* needs Bitbucket Premium. Push to a pull request, then run `forge logs -e development` to watch for the `{"probe":"reverse-s0",...}` line. `register`, `deploy` and `install` are external actions and need explicit approval.

## Security boundary

Containers are **not** a sandbox for hostile code. Sprint 0 runs only allowlisted in-repo SQL against synthetic data. Each container gets a random password, binds to 127.0.0.1 only, keeps data on tmpfs, has a 0.5 GB / 1 CPU quota, and is removed afterwards with removal verified. Statement and wall-clock timeouts apply. Errors are redacted before they reach reports. The Testcontainers reaper (Ryuk) mounts the Docker socket. The PostgreSQL container that runs the SQL under test does not.
