# RE:VERSE × AAO — Codegeist 2026 initiative

**North Star:** RE:VERSE — prove the way back before you ship.

Status after Sprint 0: **`SPRINT_0_PARTIAL — FORGE_FEASIBILITY_BLOCKED`**. The local RollbackProof proof works. The Forge integration has not been installed or observed.

Boundaries: [ADR-036](../decisions/ADR-036-reverse-application-boundary.md) (application boundary) and [ADR-037](../decisions/ADR-037-reverse-runtime-compatibility.md) (runtime split). Code and commands: [apps/reverse/README.md](../../apps/reverse/README.md).

## Customer and pain

The target customer is a fintech engineering team on Bitbucket Cloud and Jira Service Management. Production changes carry an approved rollback requirement. In practice nobody proves that the previous app version still works after a schema migration. Rollback "plans" fail exactly when they are needed: v1 is redeployed onto a schema it can no longer read.

## Product: RollbackProof

1. An approved change record states the rollback compatibility requirement.
2. A Bitbucket pull request proposes a PostgreSQL migration.
3. RE:VERSE rehearses: v1 schema and data → migration → v2 writes → v1 reads and writes.
4. A deterministic evaluator returns `PASS` / `FAIL` / `INCONCLUSIVE` with evidence.
5. A Forge merge check shows that decision against the exact PR revision. *(Not built yet.)*

## AAO vs RE:VERSE responsibilities

| AAO (unchanged) | RE:VERSE (`apps/reverse`) |
|---|---|
| Provider-neutral contracts, workflow, governance, approvals, evaluation | RollbackProof fixtures, runner, evaluator, verdict contract |
| No PostgreSQL, Docker or Atlassian dependency (enforced by a test) | `pg`, Testcontainers, Forge app |
| Local V1 release gate | Separate Docker-backed command, `test:integration` |

Sprint 0 consumes only `@aao/contracts` (`canonicalJsonStringify` for fixture digests). Workflow, approval and governance integration starts in Sprint 1, and only where it removes code.

## Sprint roadmap

| Sprint | Goal | Gate to advance |
|---|---|---|
| **S0** | Baseline, scaffold, PostgreSQL spike, Forge probe | Both local scenarios reproducible ✅. Real Forge install and callback observed ❌ |
| S1 | Forge merge check reports a precomputed RollbackProof verdict for the PR revision | Real callback, and the verdict tied to the actual commit SHA |
| S2 | Rehearsal on a migration from the PR (allowlisted layout, isolated executor) | A threat model for running PR-supplied SQL; the isolation boundary decided |
| S3 | JSM change link: rollback requirement → verdict evidence on the change | JSM access from the Forge app verified |
| S4 | Codegeist packaging and demo | End-to-end run on a real team workspace |

## Scope and non-goals (Sprint 0)

In scope: synthetic payment-ledger fixtures, two scenarios, an ephemeral PostgreSQL 16, an independent evaluator, a report schema, and a local Forge contract.
Out of scope: generic SQL migration support, executing PR code, JSM authorization, Rovo/MCP, dashboards, multi-tenant SaaS, autonomous rollback, `@aao/assurance`, runtime use of Reeprov or Moody Blues.

## Technical dependencies

Node 20.20.2 + pnpm 10.26.0 (AAO), Docker 29.9.3, `postgres:16.10-alpine` (digest-pinned), `@testcontainers/postgresql` / `testcontainers` 11.14.0, `pg` 8.23.1, zod 3. Forge CLI 15.1.0 on Node 22.23.4, runtime `nodejs22.x`.

## Sprint 0 outcomes (observed 2026-11-21)

**Baseline (pre-change).** Branch `sprint-30-local-v1` @ `6e4d46a821419116c5049420899309ec9757a8ea` with a clean worktree. `feat/reverse-codegeist-s0` was created there. `pnpm release:verify:local-v1` → `LOCAL_V1_READY`, all 27 steps passed, `core.check` (`pnpm check`) included. `origin/main` (`9369004`) is an ancestor; the release docs referenced by this initiative exist only on the sprint-30 line.

**Scenario A — incompatible rename** (`ledger-amount-rename-incompatible`, digest `sha256:5245da33…bda9`). The migration succeeded and v2 wrote and read. v1 write and read were both rejected with SQLSTATE `42703` (undefined column). Verdict **`FAIL`**: `V1_WRITE_REJECTED:42703, V1_READ_REJECTED:42703, V1_RECORDS_NOT_ACCESSIBLE, V1_DECLARED_TOTAL_MISMATCH`. Classified as `EXPECTED_NEGATIVE`.

**Scenario B — expand migration** (`ledger-amount-expand-compatible`, digest `sha256:3ada2457…8880`). The migration added columns plus a sync trigger. v2 and v1 both wrote. v1 saw all 6 records and the declared total of 39,624 cents. Verdict **`PASS`**, with 5 invariants verified.

**Reproducibility.** `rollbackproof 5`: 10/10 runs gave identical verdicts, reasons, invariants and digests, and every container was verified removed. The integration suite (6 tests) passed 4 times in a row. Afterwards no Testcontainers containers were left, and the existing host containers were untouched.

**Failure classification** (tested). Container start failure, an unreachable database, a wall-clock timeout, a statement timeout (`57014`), connection loss, missing evidence, invalid migration SQL (`42601`, `42703`), and a broken fixture baseline. Each yields `INCONCLUSIVE` with a reason code, never `PASS` or `FAIL`.

**Forge feasibility: `BLOCKED`.** The Forge CLI is installed but not logged in, so no Atlassian account, app registration or Bitbucket team workspace is available. `forge lint` also requires login. Built locally: `manifest.yml` (`bitbucket:mergeCheck`, triggers `on-code-pushed` and `on-merge`, scope `read:pullrequest:bitbucket`, placeholder app id) and a deterministic handler with local contract tests. **No installation, deployment or callback has been observed.**

## Forge findings from documentation (not verified live)

Checked 2026-11-21 against developer.atlassian.com and support.atlassian.com:

- Payload: `workspace.uuid`, `repository.uuid`, `pullrequest.id`, `trigger.type` (+ `mergeProperties` on `on-merge`). Response: `{ success: boolean, message?: string }`. A thrown exception counts as failure.
- Triggers: `on-code-pushed`, `on-reviewer-status-changed`, `on-merge`.
- Personal workspaces are unsupported. Enabling requires a workspace admin. **Required (blocking) checks and workspace/project-level settings need Bitbucket Premium.**
- Undocumented: the message length limit, the merge-check invocation timeout, and whether `requestJira` / JSM is reachable from a Bitbucket-context invocation. This last gap is critical for S3.

## Current blockers

1. No authorized Atlassian test account or Bitbucket **team** workspace (Premium needed to prove a *required* check).
2. Forge `register`/`deploy`/`install` are external actions that need explicit approval.
3. JSM access from a Bitbucket Forge app is undocumented and must be spiked live.

## Unverified assumptions

- That a Forge merge-check callback is fast enough for a precomputed verdict lookup (timeout undocumented).
- That PR revision identity (commit SHA) is obtainable via `requestBitbucket` with `read:pullrequest:bitbucket` alone.
- That the synthetic ledger is representative. Real migrations (locks, long backfills, enum and type changes) are untested.
- That Docker containers are acceptable for trusted SQL. They are **not** a boundary for untrusted PR code; S2 must decide one.

## Evidence required before Sprint 1

- A real `forge install` on a Bitbucket team workspace, plus a `forge logs` line showing a real `bitbucket:mergeCheck` callback and the check result visible on a PR.
- A screenshot or record of the check state in Bitbucket (required vs informational, with the plan noted).
