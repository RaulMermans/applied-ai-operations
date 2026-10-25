# `@aao/operator-inspection`

Read-only operator inspection contracts, metadata-only projections, and bounded query service for the AAO Control Center (Sprint 27, ADR-032).

## Responsibilities

- Validated operator-facing DTO schemas (`CompanySummary`, `CapabilityPackSummary`, `PackCompatibilitySummary`, `WorkflowSummary`, `RunSummary`, `RunInspection`, `TraceInspection`, `ApprovalSummary`, `EvaluationSummary`, `OverviewInspection`).
- Metadata-only projections from authoritative AAO contracts (`CompanyManifestV1`, `CapabilityPack`, `PackCompatibilityReport`, `Workflow`, `RunRecord`, `TraceEvent`, `ApprovalRecord`, and Evaluation reports).
- Explicit distinction between `COMPATIBLE`, `INCOMPATIBLE`, `NOT_VERIFIED`, and `UNAVAILABLE` pack compatibility states.
- Explicit distinction between authoritative Run state and Trace observations (`UNKNOWN` when authoritative Run state is unavailable).
- Explicit distinction between `REGISTERED`, `NOT_RUN`, `PASSED`, `FAILED`, and `UNAVAILABLE` Evaluation states.
- Bounded queries, deterministic sorting, privacy/redaction verification, and normalized `INSPECTION_*` errors.

## Non-Responsibilities

`@aao/operator-inspection` is strictly read-only. It never executes workflows, invokes models or tools, resolves approvals, mutates governance policies, or modifies runtime state.
