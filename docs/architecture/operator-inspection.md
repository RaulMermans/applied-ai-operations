# Operator Inspection Architecture

`@aao/operator-inspection` projects existing AAO evidence into bounded, validated, operator-facing DTOs. See ADR-032.

```text
Canonical components → OperatorInspectionSource (trusted host) → projections/service
   → CLI (aao inspect) | HTTP API (/api/v1/inspection) | local UI (/ and /control-center)
```

## Source contract

`OperatorInspectionSource` is a set of optional read-only methods. A missing method means the collection is **unavailable**; the overview reports `unavailable` and `null` counts rather than inventing zeroes. `createEvidenceBackedInspectionSource` builds a source from validated manifests, packs, workflows, `RunRecord`s, a `TraceStore`, `ApprovalRecord`s, and evaluation results.

## Status vocabularies

- Compatibility: `COMPATIBLE | INCOMPATIBLE | NOT_VERIFIED | UNAVAILABLE`.
- Run: `COMPLETED | FAILED | CANCELLED | WAITING | RUNNING | UNKNOWN` plus `statusSource` (`authoritative_runtime | unavailable`).
- Trace health: `healthy | degraded | corrupt | unavailable`.
- Evaluation: `REGISTERED | NOT_RUN | PASSED | FAILED | UNAVAILABLE`.

## Limits and safety

`INSPECTION_LIMITS` bound listed runs (100), trace events (500), response bytes (512 KiB) and string lengths. Every projection is checked against a forbidden-key list (prompts, outputs, state, secrets, approval subjects). Errors: `INSPECTION_INVALID_REQUEST`, `INSPECTION_NOT_FOUND`, `INSPECTION_SOURCE_UNAVAILABLE`, `INSPECTION_EVIDENCE_INVALID`, `INSPECTION_TRACE_CORRUPT`, `INSPECTION_LIMIT_EXCEEDED`.

## Endpoints (GET only, loopback only)

`/api/v1/inspection/` + `overview`, `companies`, `packs[?companyId]`, `workflows`, `runs[?companyId&status&limit]`, `runs/:runId`, `runs/:runId/trace[?limit]`, `approvals`, `approvals/:approvalId`, `evaluations[?companyId&packIdentity&runId]`.
