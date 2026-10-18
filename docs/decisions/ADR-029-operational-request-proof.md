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
Canonical Approval Subject (build_approval_subject)
        |
        v
Human Approval Waitpoint (require_approval)
        |
   +----+----+
   |         |
Rejected   Approved
   |         |
   v         v
Terminate  Prepare Draft Input (prepare_draft)
             |
             v
       Governed Draft Tool (create_draft)
             |
             v
       Local Draft Artifact
             |
             v
       Final Operational Result (render_result -> final)
```

The workflow comprises 9 nodes executed in strict linear sequence:
- **1 model node**: `interpret` (`operational_request.interpret@1.0.0` via Model Runtime).
- **1 approval node**: `require_approval` (canonical Approval Engine waitpoint).
- **1 governed tool node**: `create_draft` executing `operations.create_change_draft@1.0.0` (Tool Runtime).
- **6 deterministic nodes**:
  - `intake`: parses and normalizes `OperationalRequest` v1.
  - `validate_proposal`: verifies strict operation allowlist, account matching, length bounds, and diff.
  - `build_approval_subject`: deterministically constructs canonical `OperationalApprovalSubject` v1 (`executionMode: "draft_only"`).
  - `prepare_draft`: derives all draft Tool input strictly from the verified `approvalSubject` and continuation context.
  - `render_result`: renders Markdown summary, diff, approval record details, and non-modification notice.
  - `final`: terminal node of kind `final_output` emitting `OperationalRequestResult` v1.

### 2. Preservation of Fail-Closed Permission Gate

AAO Core executes Tools requiring:
- `read_only`
- `write_draft`

The following permission classes remain unsupported and fail closed unconditionally at the Tool Runtime preflight gate:
- `external_side_effect`
- `destructive`
- `sensitive_data`

Sprint 24 strictly preserves this invariant. Even if an eligible human manager approves an action proposal, a Tool requiring `external_side_effect` is refused before any handler invocation (0 handler calls) during workflow preparation and authorization preflight. An approval is evidence of human consent for a specific proposal; it does not grant new permissions, elevate actor privileges, or bypass preflight support checks.

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

### 4. Canonical Approval Subject Binding & Single Approved Source of Truth

The proof relies exclusively on the canonical Approval Engine (`@aao/approval`). It does not create a custom approval database, secondary fingerprint, or parallel state machine.
- `fingerprintApprovalSubject` computes a cryptographic SHA-256 fingerprint over canonical JSON-safe material `{ runId, nodeId, revision, subject }`.
- The approval subject schema:
  ```ts
  interface OperationalApprovalSubject {
    schemaVersion: 1;
    requestId: string;
    operation: "account.update_display_name";
    accountId: string;
    proposedChanges: {
      displayName: string;
    };
    executionMode: "draft_only";
  }
  ```
- The approval subject includes `executionMode: "draft_only"`, set deterministically by trusted host code, never by the model.
- Downstream draft preparation (`prepareDraft`) derives all business fields (`requestId`, `accountId`, `operation`, `proposedChanges`) strictly from the verified `approvalSubject`.
- Cross-state request ID or account ID mutations in mutable request state cannot alter the approved draft.

### 5. Separation of Duties and Dual-Principal Governance

The proof enforces strict separation of duties:
- **Requester**: Actor `user.operator` bound to role `operations.requester`.
- **Approver**: Actor `user.manager` bound to role `operations.approver`.
- **Self-Approval Prohibition**: An operator cannot approve their own request (`APPROVAL_SELF_APPROVAL_FORBIDDEN`), even if they possess the approver role.
- **Unauthorized Actor Rejection**: Unbound or viewer actors are rejected immediately (`APPROVAL_RESOLVER_NOT_ELIGIBLE` / `APPROVAL_REQUESTER_NOT_AUTHORIZED`).

#### Governance Revalidation Boundary
- **Approval Engine Layer**: `continueApprovedWorkflow` revalidates that the approver possessed the required role at resolution time and that the requester's authority remains valid in governance. In dynamic governance contexts, in-flight revocation halts continuation with `APPROVAL_REQUESTER_NOT_AUTHORIZED` or `APPROVAL_RESOLVER_NOT_ELIGIBLE`.
- **Application Layer (`createAAO`)**: In Framework V1, the host `createAAO` runtime encapsulates an immutable `GovernanceConfiguration` provided at construction time. Framework V1 does not expose a dynamic governance reload port. Role revocations prior to resolution fail closed deterministically (`proof.approvals.approve` throws `APPROVAL_RESOLVER_NOT_ELIGIBLE`), preventing continuation from ever receiving an approved record.

### 6. Draft Execution Only via Governed Tool with Injected Approval Attestation

No external system is modified.
- **Tool Specification**: `operations.create_change_draft@1.0.0` with `permissionClasses: ["write_draft"]`, `retrySafety: "unsafe"`, `idempotency: "execution_id"`.
- **Input Schema**:
  ```ts
  interface CreateChangeDraftToolInput {
    requestId: string;
    accountId: string;
    operation: "account.update_display_name";
    proposedChanges: { displayName: string };
    approvalBinding: {
      approvalId: string;
      requestFingerprint: string;
      runId?: string;
    };
  }
  ```
- **Output Schema**:
  ```ts
  interface CreateChangeDraftToolOutput {
    draftId: string;
    status: "approved_draft";
    externalExecution: "not_executed";
  }
  ```
- **Independent Approval Attestation**:
  The draft Tool handler does not accept caller-supplied approval metadata as sufficient authority. An injected read-only `OperationalApprovalVerifier` independently validates against the canonical Approval Engine:
  1. The approval record exists.
  2. Status is `"approved"`.
  3. Node ID is `"require_approval"`.
  4. Run ID matches execution context.
  5. Approval ID matches canonical `approvalIdForFingerprint`.
  6. Request fingerprint matches.
  7. Exact draft payload matches the approved subject cryptographically.
  8. Approval has not already been consumed (`APPROVAL_ALREADY_CONSUMED`).
- **Idempotent Replay**: If the same tool execution ID is replayed, the tool verifies the exact payload and returns the previously saved draft without creating duplicates.
- **Fail-Closed Default**: If instantiated without a verifier or if verification fails, the handler fails closed (`APPROVAL_VERIFICATION_FAILED`), creating 0 drafts and 0 `approved_draft` artifacts.
- **Draft Artifact (`OperationalChangeDraft`)**:
  ```ts
  interface OperationalChangeDraft {
    schemaVersion: 1;
    draftId: string;
    requestId: string;
    operation: "account.update_display_name";
    accountId: string;
    proposedChanges: { displayName: string };
    approvalId: string;
    status: "approved_draft";
    externalExecution: "not_executed";
  }
  ```

### 7. Deterministic Markdown Rendering and Injection Defense

The final operational report is produced by deterministic host code (`renderOperationalMarkdown`), not by the model:
- Header: `# Operational Request Result: Governed Draft Execution`
- Section: `## Summary`
- Metadata list items: Request ID, Operation, Target Account, Approved Display Name, Draft ID, Approval Record, Draft Status, External Execution.
- Explicit non-execution disclaimer:
  ```markdown
  > [!NOTE]
  > **The draft was prepared. The external account was not modified.**
  > Any future CRM, ERP or third-party mutation remains explicitly outside this governed draft boundary.
  ```
- Strict escaping via `escapeMarkdownText` and `escapeCodeSpan`:
  - Strips non-printable ASCII control characters (`\x00`–`\x08`, `\x0B`, `\x0C`, `\x0E`–`\x1F`, `\x7F`).
  - Normalizes carriage returns and newlines to single spaces.
  - Escapes HTML-sensitive characters (`&amp;`, `&lt;`, `&gt;`).
  - Escapes Markdown syntax characters (`\`, \`, `*`, `_`, `{`, `}`, `[`, `]`, `(`, `)`, `#`, `+`, `-`, `.`, `!`, `|`, `~`).
  - Preserves Unicode content without corruption.

### 8. Portability & Conformance

The proof application (`@aao/example-operational-request`) consumes public `@aao/framework` APIs. It runs identically across:
- native deterministic model adapters;
- production Vercel AI SDK mock adapters.

The test suite includes 36 automated evaluation cases covering happy path, rejection, governance violations, schema violations, prompt injection, fingerprint tampering, and external side-effect refusal across 10 canonical evaluation categories.

## Consequences

- AAO demonstrates complete operational governance: intent interpretation, proposal validation, human approval waitpoints, authority revalidation, and safe draft execution.
- Invariants between proposals, approvals, permissions, and execution are proven and enforced.
- The repository gains a third flagship proof application with an end-to-end interactive demo (`pnpm proof:operational-request`) and a standalone compiled smoke test (`pnpm --filter @aao/example-operational-request run smoke:sprint24`).
