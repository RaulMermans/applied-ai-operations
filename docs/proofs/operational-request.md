# Operational Request Proof

Sprint 24 ([ADR-029](../decisions/ADR-029-operational-request-proof.md)) establishes AAO's third end-to-end proof application: **Operational Request Proof: Governed Action Proposals, Human Approval & Safe Draft Execution**. Given an operational business request, AAO deterministically intakes the request, interprets its intent with bounded model reasoning, constructs a strictly validated action proposal, requires an eligible human's approval at a governed waitpoint, revalidates authority, and executes only the approved, permitted draft operation through the canonical Tool Runtime.

Code: [`examples/operational-request`](../../examples/operational-request/README.md) (`@aao/example-operational-request`, private). It consumes public surfaces: `@aao/framework` and `@aao/approval`.

## Architecture

```text
Request
  ↓  intake                 deterministic  validate OperationalRequest v1; prepare interpretation input
Interpretation
  ↓  interpret              model          operational_request.interpret (strictly bounded structured proposal)
Proposal Validation
  ↓  validate_proposal      deterministic  verify allowlist, account match, displayName bounds, reject extra fields
Subject Binding
  ↓  bind_approval_subject  deterministic  construct canonical OperationalApprovalSubject v1 (executionMode: "draft_only")
Approval Waitpoint
  ↓  require_approval       approval       canonical ApprovalEngine waitpoint (operations.approver role required)
  +---------------+
  |               |
Rejected       Approved
  |               |
  v               v
Terminate      revalidate_authority  deterministic  revalidate requester & approver governance before execution
                 |
               execute_draft         tool           operations.create_change_draft@1.0.0 (write_draft permission)
                 |
               render                deterministic  render summary table, diff view, approval metadata, non-execution notice
                 |
               final                 final_output   OperationalRequestResult v1
```

The operational path is deterministic. There is no general-purpose agent loop, autonomous retry/reflection cycle, or dynamic tool calling. A successful run makes exactly 1 bounded model call and 1 governed draft Tool call.

## Contracts

| Contract | Bounds & Constraints |
| --- | --- |
| `OperationalRequest` v1 | `requestId` (uuid/slug ≤ 64 chars); `instruction` (1–500 chars); `accountContext` (`accountId` ≤ 64 chars, `currentDisplayName` 1–120 chars); strict JSON |
| `OperationalActionProposal` | `operation` (`"account.update_display_name"`); `target` (`accountId`); `changes` (`displayName` 1–120 chars); `justification` (1–500 chars); no permissions or execution modes |
| `OperationalApprovalSubject` v1 | `requestId`, `operation`, `accountId`, `proposedChanges` (`displayName`), `executionMode: "draft_only"`; deterministically constructed by trusted code |
| `ChangeDraftArtifact` v1 | `draftId`, `createdAt`, `requestId`, `accountId`, `operation`, `proposedChanges`, `approvedBy`, `approvalId`, `executionMode: "draft_only"`, `externalExecution: "not_executed"` |
| `OperationalRequestResult` v1 | `requestId`, `accountId`, `operation`, `outcome` (`"completed"` \| `"rejected"`), `draftId`, `approvedBy`, `approvalId`, `externalExecution: "not_executed"`, `renderedMarkdown` |

## Guarantees and Invariants

- **Separation of Concerns:**
  - Model proposal ≠ Permission grant
  - Human approval ≠ Permission grant
  - Approved external action ≠ Executable external action in AAO V1
- **Preserved Permission Model:** Tools requiring `external_side_effect`, `destructive`, or `sensitive_data` fail closed unconditionally at the Tool Runtime preflight gate (0 handler invocations). Even if an eligible human approves an external mutation, AAO V1 refuses execution.
- **Draft Execution Only:** No external CRM, ERP, or production database is modified. The executable operation creates an immutable local draft artifact in host storage (`externalSystemUpdated: false`).
- **Exact Approval Subject Binding:** The canonical Approval Engine computes a cryptographic SHA-256 fingerprint over canonical `{ runId, nodeId, revision, subject }` material. Any tampering with target account, field, operation, execution mode, or approval identity fails before the draft Tool handler executes.
- **Separation of Duties:** Requester (`operations.requester`) and approver (`operations.approver`) are separate principals. Self-approval is strictly forbidden (`APPROVAL_SELF_APPROVAL_FORBIDDEN`). Machine/agent actors cannot approve (`APPROVAL_HUMAN_REQUIRED`).
- **Authority Revalidation:** Authority is revalidated upon continuation. If the requester's authority or approver's role is revoked between waitpoint pausing and continuation, the workflow halts closed.
- **Deterministic Rendering:** Final markdown reports are rendered by deterministic code with HTML/markdown escaping, preventing prompt injection or control-character tampering from leaking into operator output.

## Verification

- **Tests:** `examples/operational-request/test` (contracts, deterministic validation, draft repository, workflow execution, separation of duties & governance, subject tampering, external-effect refusal, portability across model adapters, security/injection defense, and 36 evaluation cases).
- **Compiled Smoke Test:** `node examples/operational-request/smoke/sprint24.mjs` verifies all 23 smoke acceptance criteria and prints `SPRINT_24_OPERATIONAL_REQUEST_PROOF_SMOKE_OK`.
- **Demo Script:** `pnpm proof:operational-request` demonstrates full operational lifecycle across three cases (A: Approved Draft Flow, B: Human Rejection, C: Tampering & Policy Violation).
