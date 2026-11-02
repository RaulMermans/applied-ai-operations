# ADR-032: Operator Inspection & Control Center Foundation

- Status: Accepted (Sprint 27, amended Sprint 27C)
- Supersedes: none. Builds on ADR-020 (Trace), ADR-021 (Metrics/Audit), ADR-024 (CLI), ADR-029–031 (Company config, Capability Packs, verified compatibility).

## Context

Operating AAO required reading TypeScript packages, proof apps, scripts, and test output. Operators need one place to see companies, Capability Packs, verified compatibility, Workflows, Runs, Approvals, and Evaluations — without the inspection layer becoming a second source of truth.

## Decision

Introduce `@aao/operator-inspection`: a **read-only inspection service** (deterministic projection and routing, no Agent) reused by three surfaces:

1. `aao inspect …` (existing CLI, `packages/framework/src/cli/inspect.ts`, a thin dispatcher/formatter).
2. A GET-only local HTTP API under `/api/v1/inspection/*` in `apps/control-plane`.
3. A minimal server-rendered, read-only browser page at `/`, `/control-center`, and `/control-center/runs/:runId`.

The package depends only on lower-level canonical packages (`contracts`, `config`, `capability-packs`, `workflow-dsl`, `observability`) — never `@aao/framework` — so that both the Framework CLI and the app can depend on it without violating the `framework → core` boundary.

### Ownership rules

| Information | Authoritative source | Inspection behaviour |
|---|---|---|
| Company config | Validated Company Manifest | Metadata projection; no governance payloads/secrets |
| Packs | Capability Pack catalog | Validated manifest projection |
| Compatibility | `validatePackCompatibility` with trusted registration evidence | `COMPATIBLE` only with independent `ProofRegistrationSnapshot` evidence; `NOT_VERIFIED` (`PACK_EVIDENCE_UNAVAILABLE`) when evidence is absent; `INCOMPATIBLE` with canonical reason codes; requirements are never copied into evidence |
| Workflow | Compiled Workflow | Plan fingerprint = canonical compiled-plan hash |
| Run status | Runtime/Durability `RunRecord` | If absent: `UNKNOWN` (statusSource: `unavailable`), never inferred from Trace |
| Trace | Trace Store + `validateTrace` | Bounded metadata; corrupt traces reported, never repaired |
| Approval | Approval record | Never derived from `approval.requested` |
| Evaluation | Evaluation results | `REGISTERED` ≠ `PASSED` |
| Provenance | Trusted inspection source provider | Explicit `mode` (`demo`, `live`, `unavailable`) and clear UI/CLI labelling |

### Boundaries

- The trusted host supplies the `OperatorInspectionSource`; requests cannot supply sources or paths.
- Inspection never executes Workflows, resolves Approvals, edits configuration, registers Tools, or writes files.
- HTTP: loopback `Host`/`Origin` only, GET/HEAD only, no CORS headers, bounded queries, normalized `INSPECTION_*` errors. `apps/control-plane/src/server.ts` disables inspection on a non-loopback host.
- Collections the repository cannot truthfully enumerate (global Run or Approval discovery) are only exposed through the host-supplied known set.

## Sprint 27C Amendment: Evidence Integrity & Browser Run Navigation

Following independent source review, three corrections were codified:

1. **Elimination of Circular Compatibility Evidence**: Demonstration sources previously copied Capability Pack requirements into registration evidence. This circularity is eliminated. Compatibility must derive exclusively from independently observed `ProofRegistrationSnapshot` objects (or explicit tool/model policy registries). In the absence of trusted registration snapshots, compatibility defaults strictly to `NOT_VERIFIED` with reason code `PACK_EVIDENCE_UNAVAILABLE`. A valid manifest alone is never treated as compatibility proof.
2. **Explicit Data Provenance**: Demonstration fixtures are clearly demarcated across all projections. Every view exposes source mode (`demo` vs. `live`), with the persistent banner `DEMO DATA — NOT LIVE OPERATIONS` visible on all browser views, in CLI text output, and within JSON inspection payloads. A completed fixture Run or verified demonstration pack is never conflated with live operational state.
3. **Server-Rendered Browser Run Inspection**: The Control Center provides direct, bookmarkable, server-rendered run detail routes at `/control-center/runs/:runId`. All known Run table identifiers are rendered as clickable navigation links. Run inspection presents authoritative run lifecycle state, bounded chronological trace events, associated approval records, evaluation results, and diagnostic integrity checks. Unknown run identifiers yield a safe 404 response (`INSPECTION_RUN_NOT_FOUND`) free of stack traces or internals.

## Consequences

- One DTO contract and one projection implementation for CLI, API, and UI.
- The bundled demonstration source is **offline fixture evidence**, labelled prominently as such; live operational hosts supply their own source.
- Bounded, read-only run detail inspection is accessible from both CLI and browser without requiring frontend build steps or client-side frameworks.
- Zero mutation, zero execution, and strict loopback guards are preserved across all browser and API surfaces.
