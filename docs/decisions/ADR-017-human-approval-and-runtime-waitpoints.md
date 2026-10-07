# ADR-017: Human approval and Runtime waitpoints

Status: accepted

## Decision

Approval is a separate confirmation gate after trusted identity, Governance, and Authorization. It grants no role, permission, Agent ceiling, or Tool Runtime support. Only a host-attested `user` may approve or reject. The Approval Engine resolves the user's current Governance role membership (not the action's permissions — corrected in the Sprint 13 closure gate); the required approver roles must intersect, and self-approval is denied unless trusted node configuration explicitly enables it.

`@aao/approval` owns process-local request and resolution state. Approval records contain run/node references, the trusted requester, risk permission classes, required roles, and a SHA-256 fingerprint of canonical JSON-safe run ID, node ID, state revision, and subject. They never copy the subject or Tool arguments. Pending requests are idempotent only for identical binding metadata. A terminal record cannot be changed. Explicit expiry and cancellation have no scheduler.

An Approval Node returns a generic Runtime wait result. Runtime transitions `RUNNING → WAITING_FOR_APPROVAL` and Node `RUNNING → WAITING`, captures a safe version-2 snapshot with bounded wait metadata, and stops routing. The trusted host reads the engine record and recomputes the subject fingerprint before validated in-process continuation. Approval transitions the waiting Node to `SUCCEEDED` and uses the same Runtime loop; rejection/expiry fail it, cancellation cancels it. Waiting adds no business-state revision. History records final approval outcome while the waiting state and ApprovalRecord represent the pending interval.

## Consequences and limits

Snapshots and approvals are process-local and are not durable checkpoints or crash recovery. An instance-local claim blocks duplicate continuation even with a copied waiting state; cross-process replay protection awaits durable execution. The Runtime never imports `@aao/approval`; `@aao/tool-runtime` has no approval dependency. Tool support remains limited to `read_only` and `write_draft`. `external_side_effect`, `destructive`, and `sensitive_data` remain unsupported even after approval. AAO lacks durable Run and approval persistence, atomic checkpoints, side-effect idempotency, crash-after-effect recovery, and cross-process replay protection. Enabling effects now could replay a successful action after a crash. UI, notifications, scheduler, and durable recovery are deferred.
