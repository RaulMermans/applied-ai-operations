# ADR-029: Operational Request Proof: Governed Action Proposals, Human Approval & Safe Draft Execution

Status: accepted (Sprint 24)

## Context

Sprints 22 and 23 established AAO's first two proof applications:
- **Sprint 22 (Company Research)**: Demonstrated governed external Tool use, web search, scraping, rate limiting, and structured report synthesis.
- **Sprint 23 (Document Intelligence)**: Demonstrated governed document ingestion, isolated worker PDF parsing, deterministic page/span segmentation, and strict evidence provenance.

Sprint 24 proves the third foundational capability of Applied AI Operations: **receiving an operational business request, interpreting its intent with bounded model reasoning, constructing a strictly validated action proposal, requiring an eligible human's approval at a governed waitpoint, and executing only the approved, permitted draft operation through the canonical Tool Runtime**.

Crucially, the system must maintain clear architectural boundaries and never confuse:
- a model recommendation with authorization;
- an action proposal with an executed action;
- a human approval with a permission grant;
- drafting with external execution;
- a successful Eval with permission to execute.

## Decision

### 1. Hybrid Workflow-Agent Architecture, Not a General-Purpose Agent Loop

We implement the proof as a linear 9-node deterministic Workflow (`operational_request.proof@1.0.0`) with bounded model reasoning. We do not introduce a general-purpose agent loop, autonomous retry cycles, reflection loops, or dynamic tool calling. The operational path is known and deterministic. Exactly one model call is used to interpret request intent.

```text
Operational Request
        |
        v
Deterministic Intake (intake)
        |
        v
Bounded Model Interpretation (interpret)
        |
        v
Strict Proposal Validation (validate_proposal)
        |
        v
Canonical Approval Subject (bind_approval_subject)
        |
        v
Human Approval Waitpoint (require_approval)
        |
   +----+----+
   |         |
Rejected   Approved
   |         |
   v         v
Terminate  Revalidate Authority (revalidate_authority)
             |
             v
       Governed Draft Tool (execute_draft)
             |
             v
       Local Draft Artifact
             |
             v
       Final Operational Result (render -> final)
```

- **1 model node**: `operational_request.interpret` (Model Runtime).
- **1 approval node**: `require_approval` (Approval Engine).
- **1 governed tool node**: `execute_draft` executing `operations.create_change_draft@1.0.0` (Tool Runtime).
- **6 deterministic nodes**: `intake`, `validate_proposal`, `bind_approval_subject`, `revalidate_authority`, `render`, `final`.

### 2. Preservation of Fail-Closed Permission Gate

AAO Core executes Tools requiring:
- `read_only`
- `write_draft`

The following permission classes remain unsupported and fail closed unconditionally at the Tool Runtime preflight gate:
- `external_side_effect`
- `destructive`
- `sensitive_data`

Sprint 24 strictly preserves this invariant. Even if an eligible human manager approves an action proposal, a Tool requiring `external_side_effect` is refused before any handler invocation (0 handler calls). An approval is evidence of human consent for a specific proposal; it does not grant new permissions, elevate actor privileges, or bypass preflight support checks.

```text
Model proposal        ≠ Permission grant
Human approval        ≠ Permission grant
Approved external action ≠ Executable external action in AAO V1
```

### 3. Concrete Operational Scenario & Strict Allowlist

The proof implements one credible, low-risk business scenario: **Account Record Update Request — Draft Only**.
- Permitted operation: strictly `"account.update_display_name"`.
- Permitted target: strictly matches the trusted intake account context (`accountId`).
- Permitted changes: strictly `displayName` (trimmed, bounded 1–120 characters, differing from current display name, single-line).
- Unsupported operations, unknown accounts, unchanged names, blank names, or additional unexpected fields are rejected deterministically by `validate_proposal` before any approval request is generated.

### 4. Canonical Approval Subject Binding

The proof relies exclusively on the canonical Approval Engine (`@aao/approval`). It does not create a custom approval database, secondary fingerprint, or parallel state machine.
- `fingerprintApprovalSubject` computes a cryptographic SHA-256 fingerprint over canonical JSON-safe material `{ runId, nodeId, revision, subject }`.
- The approval subject includes `executionMode: "draft_only"`, set deterministically by trusted host code, never by the model.
- The approved subject is the sole source of truth for the downstream draft execution.
- If the subject is tampered with (modified target, field, operation, execution mode, or fingerprint mismatch), execution fails closed before the draft Tool handler executes.

### 5. Separation of Duties and Dual-Principal Governance

The proof enforces strict separation of duties:
- **Requester**: Actor `user.operator` bound to role `operations.requester`.
- **Approver**: Actor `user.manager` bound to role `operations.approver`.
- **Self-Approval Prohibition**: An operator cannot approve their own request (`APPROVAL_SELF_APPROVAL_FORBIDDEN`), even if they possess the approver role.
- **Unauthorized Actor Rejection**: Unbound or viewer actors are rejected immediately (`APPROVAL_RESOLVER_NOT_ELIGIBLE` / `APPROVAL_REQUESTER_NOT_AUTHORIZED`).
- **Authority Revalidation on Continuation**: When resuming after approval, the engine revalidates that the requester's authority and approver's role remain valid in governance. If revoked prior to continuation, continuation halts.

### 6. Draft Execution Only via Governed Tool

No external system is modified.
- Tool: `operations.create_change_draft@1.0.0` with `permissionClasses: ["write_draft"]`, `retrySafety: "safe"`, `idempotency: "idempotent"`.
- Execution records an immutable draft in a host-owned `DraftRepository`.
- The draft artifact contains: `draftId`, `createdAt`, `requestId`, `accountId`, `operation`, `proposedChanges`, `approvedBy`, `approvalId`, and `executionMode: "draft_only"`.
- The final operational result explicitly states: `externalSystemUpdated: false`.

### 7. Deterministic Markdown Rendering

The final operational report is produced by deterministic host code (`renderOperationalRequestReport`), not by the model:
- Summary table with request ID, account ID, operation, execution status, and external execution notice.
- Change diff displaying current vs proposed display name.
- Approval record summary with approval ID, approver principal ID and role, and resolution timestamp.
- Draft artifact details with draft ID and storage timestamp.
- Explicit non-execution disclaimer: *"No external CRM, ERP, or production database was modified."*
- Inline text escaping prevents markdown injection or control-character tampering.

### 8. Portability & Conformance

The proof application (`@aao/example-operational-request`) consumes public `@aao/framework` APIs. It runs identically across:
- native deterministic model adapters;
- production Vercel AI SDK mock adapters.

The test suite includes 36 automated evaluation cases covering happy path, rejection, governance violations, schema violations, prompt injection, fingerprint tampering, and external side-effect refusal across 10 canonical evaluation categories.

## Consequences

- AAO demonstrates complete operational governance: intent interpretation, proposal validation, human approval waitpoints, authority revalidation, and safe draft execution.
- Invariants between proposals, approvals, permissions, and execution are proven and enforced.
- The repository gains a third flagship proof application with an end-to-end interactive demo (`pnpm proof:operational-request`) and a standalone compiled smoke test (`pnpm --filter @aao/example-operational-request run smoke:sprint24`).
