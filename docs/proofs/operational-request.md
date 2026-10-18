# Operational Request Proof

Sprint 24 ([ADR-029](../decisions/ADR-029-operational-request-proof.md)) establishes AAO's third end-to-end proof application: **Operational Request Proof: Governed Action Proposals, Human Approval & Safe Draft Execution**. Given an operational business request, AAO deterministically intakes the request, interprets its intent with bounded model reasoning, constructs a strictly validated action proposal, requires an eligible human's approval at a governed waitpoint, prepares verified draft inputs, and executes only the approved, permitted draft operation through the canonical Tool Runtime.

Code: [`examples/operational-request`](../../examples/operational-request/README.md) (`@aao/example-operational-request`, private). It consumes public surfaces: `@aao/framework` and `@aao/approval`.

## Architecture & Complete Trust Boundary

```text
Operational Request
       │
       ▼ [Deterministic Boundary]
Intake (intake)
       │  • Validates OperationalRequest v1
       │  • Extracts trusted account context
       ▼ [Model Boundary]
Interpretation (interpret)
       │  • strictly bounded structured proposal via operational_request.interpret@1.0.0
       │  • NO authority, NO execution rights, recommendation only
       ▼ [Deterministic Validation Boundary]
Proposal Validation (validate_proposal)
       │  • Validates allowlist (strictly "account.update_display_name")
       │  • Verifies target matches trusted intake account context
       │  • Enforces displayName bounds (1–120 chars, single-line, differs from current)
       │  • Rejects unexpected fields
       ▼ [Canonical Subject Boundary]
Subject Construction (build_approval_subject)
       │  • Deterministically constructs OperationalApprovalSubject v1
       │  • Injects executionMode: "draft_only"
       ▼ [Human Governance Boundary]
Approval Waitpoint (require_approval)
       │  • Pauses workflow in WAITING_FOR_APPROVAL
       │  • Computes canonical SHA-256 fingerprint over { runId, nodeId, revision, subject }
       │  • Canonical ApprovalEngine requires operations.approver role
       │  • Strictly prohibits self-approval (APPROVAL_SELF_APPROVAL_FORBIDDEN)
       │  • Zero draft calls occur before approval resolution
       ├──[Rejected]──► Terminate (status: FAILED, code: APPROVAL_REJECTED, 0 drafts)
       │
       ▼ [Continuation & Single Source of Truth Boundary]
Prepare Draft Input (prepare_draft)
       │  • Derives all draft identity and business fields strictly from verified approvalSubject
       │  • Mutable request state cannot alter approved draft fields
       ▼ [Tool Runtime & Independent Approval Attestation Boundary]
Governed Draft Tool (create_draft)
       │  • Tool Runtime validates write_draft permission
       │  • Unsupported permission classes (external_side_effect) fail closed at preflight
       │  • Injected OperationalApprovalVerifier independently verifies canonical approval record
       │  • Validates status === "approved", runId, nodeId, fingerprint, exact payload, and consumption
       │  • Idempotency replay check returns existing draft on replayed executionId
       ▼ [Host Storage Boundary]
Local Draft Artifact (DraftRepository)
       │  • Saves immutable OperationalChangeDraft in host storage
       │  • Status: "approved_draft", externalExecution: "not_executed"
       ▼ [Deterministic Rendering Boundary]
Render Result (render_result -> final)
       │  • Deterministic HTML/Markdown escaping (headings, scripts, backticks, table pipes, control chars)
       │  • Explicit non-execution disclaimer: external account was not modified
       ▼
Final Output (final)
```

The operational path is deterministic. There is no general-purpose agent loop, autonomous retry/reflection cycle, or dynamic tool calling. A successful run makes exactly 1 bounded model call and 1 governed draft Tool call.

## Final Authority Sequence & Trust Invariants

### Authority Sequence

```text
Operational Request
        ↓
Validated Proposal
        ↓
Canonical Approval
        ↓
Eligible Human
        ↓
Trusted Execution-Origin Binding
        ↓
Exact Approved Payload
        ↓
Canonical Tool Runtime
        ↓
Recoverable Draft Commit
        ↓
Approved Local Draft
```

Neither a caller-supplied Run ID nor an Approval ID is authorization by itself. A caller cannot simply present an approval identifier, nor can a caller supply a different Run ID to authorize draft execution. Authority requires every step of the chain above to hold unbroken under trusted host verification.

### Trust Boundary Invariants

1. **Model Proposal ≠ Authorization:**
   The model proposes an `OperationalActionProposal`. It cannot self-authorize, select permission classes, or invoke tools. Deterministic code validates the proposal against trusted intake context.
2. **Caller-Supplied Run ID and Approval ID Are Correlation Data, Not Authority:**
   The draft Tool does not trust caller-supplied approval or execution identifiers. The draft Tool requires canonical Tool Runtime authorization (`write_draft`) AND queries the trusted host Approval Engine and execution verifier to enforce:
   - The approval record actually exists and is currently in `approved` status.
   - The approval belongs strictly to the invoking Run ID and node ID (`require_approval`).
   - Genuine Approvals created for Run A can never authorize draft execution within Run B, even with identical business payloads.
   - Caller-supplied `runId` in tool input is untrusted and cannot select or establish the expected execution context.
   - Execution identity `deriveToolExecutionId(runId, "create_draft")` must match the expected node, and untrusted direct invocations lacking host execution-origin attestation fail closed (`UNTRUSTED_EXECUTION_ORIGIN`).
   - The approval's cryptographic request fingerprint matches the exact draft payload.
   - The approval has not been consumed previously (`APPROVAL_ALREADY_CONSUMED`).
3. **Atomic Draft Commitment & Recoverable Persistence:**
   Approvals are reserved (`IN_FLIGHT`) before storage writes and only marked `COMMITTED` upon successful draft persistence or proven commit reconciliation (`reconcileUncertainCommit`). Failed uncommitted persistence safely releases the reservation (`AVAILABLE`) for retry.
4. **Single Approved Source of Truth:**
   All downstream business fields (`requestId`, `accountId`, `operation`, `proposedChanges`) are derived strictly from the verified `approvalSubject`. Mutable non-approved request state cannot influence the resulting draft.
5. **Non-Execution Guarantees are Enforced by Deterministic Software:**
   Non-execution is not a model prompt constraint or compliance suggestion. It is enforced structurally:
   - Tool Runtime refuses unsupported permission classes (`external_side_effect`, `destructive`, `sensitive_data`) during workflow preparation and preflight.
   - The registered tool (`operations.create_change_draft@1.0.0`) only has capability to append to a local host `DraftRepository`.
   - The draft artifact explicitly records `externalExecution: "not_executed"`.


## Core vs Application-Level Governance Revalidation

- **Approval Engine Layer (Core):**
  The canonical `continueApprovedWorkflow` API revalidates that the approver principal (`resolvedBy`) possessed an active approver role binding at resolution time and that the requester possessed active requester authority. In dynamic governance contexts, in-flight revocation of requester or approver halts continuation with `APPROVAL_REQUESTER_NOT_AUTHORIZED` or `APPROVAL_RESOLVER_NOT_ELIGIBLE`.
- **Application Layer (`createAAO`):**
  In Framework V1, the host `createAAO` encapsulates governance configuration provided at construction time. Framework V1 does not expose a dynamic governance reload port. Role revocations prior to resolution fail closed deterministically (`proof.approvals.approve` throws `APPROVAL_RESOLVER_NOT_ELIGIBLE`), preventing continuation from ever receiving an approved record.

## Contracts

| Contract | Bounds & Constraints |
| --- | --- |
| `OperationalRequest` v1 | `requestId` (uuid/slug ≤ 64 chars); `instruction` (1–500 chars); `accountContext` (`accountId` ≤ 64 chars, `currentDisplayName` 1–120 chars); strict JSON |
| `OperationalActionProposal` | `operation` (`"account.update_display_name"`); `target` (`accountId`); `changes` (`displayName` 1–120 chars); `justification` (1–500 chars); no permissions or execution modes |
| `OperationalApprovalSubject` v1 | `schemaVersion: 1`, `requestId`, `operation`, `accountId`, `proposedChanges` (`displayName`), `executionMode: "draft_only"`; deterministically constructed by trusted code |
| `OperationalChangeDraft` v1 | `schemaVersion: 1`, `draftId` (`draft.<sha256>`), `requestId`, `operation`, `accountId`, `proposedChanges` (`displayName`), `approvalId`, `status: "approved_draft"`, `externalExecution: "not_executed"` |
| `OperationalRequestResult` v1 | `requestId`, `accountId`, `operation`, `outcome` (`"completed"` \| `"rejected"`), `draftId`, `approvedBy`, `approvalId`, `externalExecution: "not_executed"`, `renderedMarkdown` |

## Tool Specification

- **Tool Reference:** `operations.create_change_draft@1.0.0`
- **Permission Classes:** `["write_draft"]`
- **Retry Safety:** `"unsafe"`
- **Idempotency:** `"execution_id"`
- **Input Schema:**
  - `requestId`: string
  - `accountId`: string
  - `operation`: enum `["account.update_display_name"]`
  - `proposedChanges`: object with required `displayName` (string)
  - `approvalBinding`: object with `approvalId` (string), `requestFingerprint` (string), `runId` (optional string)
- **Output Schema:**
  - `draftId`: string
  - `status`: enum `["approved_draft"]`
  - `externalExecution`: enum `["not_executed"]`

## Deterministic Markdown Rendering

The final operational report is rendered by `renderOperationalMarkdown`:
- Summary list with inline code spans: Request ID, Operation, Target Account, Approved Display Name, Draft ID, Approval Record, Draft Status, External Execution.
- Explicit non-execution notice:
  ```markdown
  > [!NOTE]
  > **The draft was prepared. The external account was not modified.**
  > Any future CRM, ERP or third-party mutation remains explicitly outside this governed draft boundary.
  ```
- All dynamic strings are escaped via `escapeMarkdownText` and `escapeCodeSpan`, stripping control characters (`\x00`–`\x08`, `\x0B`, `\x0C`, `\x0E`–`\x1F`, `\x7F`), normalizing line breaks to spaces, escaping HTML entities (`&amp;`, `&lt;`, `&gt;`), and escaping Markdown formatting characters (`\`, \`, `*`, `_`, `{`, `}`, `[`, `]`, `(`, `)`, `#`, `+`, `-`, `.`, `!`, `|`, `~`).

## Verification

- **Tests:** `examples/operational-request/test` (contracts, deterministic validation, draft repository, workflow execution, separation of duties & governance, subject tampering, external-effect refusal, portability across model adapters, security/injection defense, tool boundary security, markdown rendering, and 36 evaluation cases).
- **Compiled Smoke Test:** `node examples/operational-request/smoke/sprint24.mjs` verifies all 28 smoke acceptance criteria and prints `SPRINT_24_OPERATIONAL_REQUEST_PROOF_SMOKE_OK`.
- **Demo Script:** `pnpm proof:operational-request` demonstrates full operational lifecycle across three cases (A: Approval Required Waitpoint, B: Approved Draft Flow, C: Human Rejection).
