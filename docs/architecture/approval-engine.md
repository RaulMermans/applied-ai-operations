# Human approval engine

The decision order is trusted host identity → Governance → Authorization → Approval → execution. Approval confirms an exact proposed subject; it does not authorize it. The requesting actor must pass Governance for the declared permission classes. Only a host-attested user may approve or reject. Approver eligibility is trusted registered identity plus current active membership in at least one required approver role, resolved by Governance `resolveRoleMembership`; the approver does not need the permission classes of the action it confirms (a read-only `manager` may approve an operator's `write_draft` request). Self-approval is denied by default.

The trusted host registers `createApprovalNodeExecutor(engine, requesterForRun)`. Its strict static config names a `subjectStateKey`, canonical permission classes, required approver roles, and optional `allowSelfApproval`. The requester callback is host-owned; model output, workflow state, Tool input, and MCP metadata cannot supply identity. The executor reads the defensive RunState copy, checks JSON safety, hashes canonical JSON of `{runId,nodeId,revision,subject}` with SHA-256, and requests a pending Approval. The record stores only references, metadata, and the digest. The original subject remains in RunState.

At the node, Runtime transitions `RUNNING → WAITING_FOR_APPROVAL` and `RUNNING → WAITING` (Run and Node respectively). The remaining nodes stay `PENDING`. A version-2 Runtime snapshot includes the approval reference and fingerprint, with no live engine or functions. It round-trips as JSON and is safe for inspection, but is not durable persistence. Waiting and resolution do not change the business-state revision. The ApprovalRecord and waiting Node status express the pending interval; history gains one final approval outcome on continuation.

The host resolves a pending request through `approve`, `reject`, `expire`, or `cancel`. Approved and rejected decisions require an eligible user; expiry and cancellation are explicit operations. Every terminal Approval state is immutable. `continueApprovedWorkflow` reads that record from the same process-local engine, recomputes the subject digest, claims the waitpoint once, and delegates to the generic Runtime continuation. Runtime validates Run status, current Node, wait descriptor, record identity, and fingerprint. Approval succeeds and routing resumes through the single Runtime loop; rejection/expiry fail the Run, cancellation cancels it. Pending or mismatched requests leave the Run waiting.

By default the engine stores records in a process-local repository, so a crash loses them. The claim prevents repeated continuation within an engine instance, including a copied waiting state. Cross-process durability is the Sprint 14 repository below. No scheduler, database, queue, UI, notification, external side effect, destructive execution, or sensitive-data execution is implemented. Tool Runtime continues to reject those three permission classes regardless of approval.

## Sprint 13 reliability boundary

An approval wait is a successful nonterminal outcome, never a failure, and is never retried. Runtime rejects a multi-attempt reliability policy on an Approval Node. Continuation invokes no executor (history records `attemptCount: 1`) and resumes the single Runtime loop, so a downstream retry-safe Node may retry after approval without replaying the proposal or Approval Node. Rejection, expiry, and cancellation carry category `APPROVAL` and are terminal. An invalid reliability configuration on continuation leaves the Run waiting and releases the continuation claim. See [reliability runtime](reliability-runtime.md) and [ADR-018](../decisions/ADR-018-runtime-reliability-and-bounded-retries.md).

## Sprint 14 durable approvals

The engine stores records through an `ApprovalRepository` port (`get`, `create`, `compareAndSetResolution`). `createInMemoryApprovalRepository()` is the default and keeps the nondurable behavior; `@aao/durability` provides a file repository. `@aao/approval` never imports durability or the filesystem.

- **Atomic resolution.** Resolution is a compare-and-set from `pending`, so concurrent approve and reject can never both win (`APPROVAL_ALREADY_RESOLVED`).
- **Exact request replay.** A request with the same id, Run, Node, fingerprint, requester, permission classes, roles, and self-approval flag returns the stored record, even after it was resolved. It is never reopened or duplicated, so a crashed Approval Node can replay safely (`recoverySafety: "safe"`). Any other request under that id is `APPROVAL_REQUEST_MISMATCH`.
- **Revalidation before consumption.** Before an approved record is consumed, `continueApprovedWorkflow` revalidates against current Governance:
  - The requester must still hold the stored permission classes (`APPROVAL_REQUESTER_NOT_AUTHORIZED`).
  - The resolver must still be a registered human in a required role, under the self-approval rule (`APPROVAL_RESOLVER_NOT_ELIGIBLE`).
  This applies in-process and after a restart. The subject fingerprint check is unchanged, and a durable host also requires the plan fingerprint to match. A revoked approval leaves the Run waiting.
- **Evidence, not authority.** `fingerprintGovernance` gives deterministic evidence of the configuration in force at a wait. It never grants or restores authority.

The durable checkpoint at the waiting boundary acts as the cross-process continuation claim: once continuation is persisted, the Run is no longer waiting. See [durable execution](durable-execution.md) and [ADR-019](../decisions/ADR-019-durable-execution-checkpoints-and-replay.md).

## Trace (Sprint 15)

The Approval Node emits `approval.requested` with the approval id, requester id/type, required approver roles, permission classes, and request fingerprint. It never emits the subject or its payload. `continueApprovedWorkflow` emits `approval.resolved` with the status, the resolver id/type, and the authoritative `resolvedAt` when a resolution is consumed. A durable host emits the same event when it cancels a pending approval on Run cancellation. No reason text or profile data is traced, and Trace can never approve, reject, or revalidate anything. See [trace runtime](trace-runtime.md).

## Audit (Sprint 16)

`createApprovalEngine({ ..., audit })` accepts an optional emit-only `AuditPort`. The engine records accountability evidence at its own authoritative boundary, from the stored record:

- `approval.requested` when the record is created, at `requestedAt`. An exact-request replay deduplicates.
- `approval.resolved` only after `compareAndSetResolution` succeeded for `pending → approved | rejected`, at the record's `resolvedAt` by its `resolvedBy`. Trace `approval.resolved` stays the Runtime's consumption time; the difference is intentional.
- `approval.resolution_denied` for a refused attempt by a well-formed principal: `APPROVAL_HUMAN_REQUIRED`, `APPROVAL_RESOLVER_NOT_ELIGIBLE`, `APPROVAL_SELF_APPROVAL_FORBIDDEN`, or `APPROVAL_ALREADY_RESOLVED`. The attempted resolver is the actor; nothing is fabricated for an unattributable attempt.

No subject, reason text, or profile data is recorded. The engine never reads Audit: a forged Audit approval leaves the record pending. Audit failure never changes or rolls back a decision. See [audit](audit.md) and [ADR-021](../decisions/ADR-021-metrics-and-audit-boundaries.md).

## Evaluation (Sprint 17)

The `aao.approval-compliance` grader in `@aao/evaluation` judges recorded Approval evidence: whether an Approval was requested and how often, its resolution, no Tool before approval (bypass detection), and no Tool after rejection, optionally cross-checked against Audit. It never resolves, approves, or re-checks eligibility. A passing EvalResult, or a model judge that "recommends approval", leaves a pending Approval pending; continuation still requires an eligible human resolution. See [evaluation runtime](evaluation-runtime.md).
