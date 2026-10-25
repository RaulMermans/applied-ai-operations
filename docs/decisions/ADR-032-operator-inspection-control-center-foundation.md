# ADR-032: Operator Inspection & Control Center Foundation

- Status: Accepted (Sprint 27)
- Supersedes: none. Builds on ADR-020 (Trace), ADR-021 (Metrics/Audit), ADR-024 (CLI), ADR-029–031 (Company config, Capability Packs, verified compatibility).

## Context

Operating AAO required reading TypeScript packages, proof apps, scripts, and test output. Operators need one place to see companies, Capability Packs, verified compatibility, Workflows, Runs, Approvals, and Evaluations — without the inspection layer becoming a second source of truth.

## Decision

Introduce `@aao/operator-inspection`: a **read-only inspection service** (deterministic projection and routing, no Agent) reused by three surfaces:

1. `aao inspect …` (existing CLI, `packages/framework/src/cli/inspect.ts`, a thin dispatcher/formatter).
2. A GET-only local HTTP API under `/api/v1/inspection/*` in `apps/control-plane`.
3. A minimal server-rendered, read-only browser page at `/` and `/control-center`.

The package depends only on lower-level canonical packages (`contracts`, `config`, `capability-packs`, `workflow-dsl`, `observability`) — never `@aao/framework` — so that both the Framework CLI and the app can depend on it without violating the `framework → core` boundary.

### Ownership rules

| Information | Authoritative source | Inspection behaviour |
|---|---|---|
| Company config | Validated Company Manifest | Metadata projection; no governance payloads/secrets |
| Packs | Capability Pack catalog | Validated manifest projection |
| Compatibility | `validatePackCompatibility` with trusted registration evidence | `COMPATIBLE` only with evidence; `NOT_VERIFIED` without it; `INCOMPATIBLE` with the canonical reason code |
| Workflow | Compiled Workflow | Plan fingerprint = canonical compiled-plan hash |
| Run status | Runtime/Durability `RunRecord` | If absent: `UNKNOWN`, never inferred from Trace |
| Trace | Trace Store + `validateTrace` | Bounded metadata; corrupt traces reported, never repaired |
| Approval | Approval record | Never derived from `approval.requested` |
| Evaluation | Evaluation results | `REGISTERED` ≠ `PASSED` |

### Boundaries

- The trusted host supplies the `OperatorInspectionSource`; requests cannot supply sources or paths.
- Inspection never executes Workflows, resolves Approvals, edits configuration, registers Tools, or writes files.
- HTTP: loopback `Host`/`Origin` only, GET/HEAD only, no CORS headers, bounded queries, normalized `INSPECTION_*` errors. `apps/control-plane/src/server.ts` disables inspection on a non-loopback host.
- Collections the repository cannot truthfully enumerate (global Run or Approval discovery) are only exposed through the host-supplied known set.

## Consequences

- One DTO contract and one projection implementation for CLI, API, and UI.
- The bundled demonstration source is **offline fixture evidence**, labelled as such; live hosts supply their own source.
- Not delivered: authentication, remote access, mutation, live Run discovery, pagination cursors, dashboards beyond three views.
