# Audit

Sprint 16, [ADR-021](../decisions/ADR-021-metrics-and-audit-boundaries.md). Audit records *who requested, decided, or was refused a security- or governance-relevant action, and when*. It is recorded at the authoritative source boundary, never reconstructed from Trace. It is never authority.

```text
Authoritative security / accountability action
  (Approval repository transition · Tool Authorization decision · durable cancellation)
          ↓  emitAuditSafely(port, draft)       fire-and-forget, never throws into the caller
       AuditPort  (@aao/contracts, emit-only)
          ↓
     Audit Recorder  (@aao/observability: identity, source time, sequence, hash chain, validation, health)
          ↓
       AuditStore  ── createInMemoryAuditStore() · createFileAuditStore({ root })
          ↓
   verifyStream · validateAuditStream · checkAuditCompleteness
```

## Separation

- **Trace ≠ Audit.** Trace is chronological operational evidence; Audit is accountability evidence with different retention, access, and completeness expectations.
  - They use separate contracts (`TraceEvent` and `AuditEvent`) and separate stores (`TraceStore` and `AuditStore`). Neither holds the other's data.
  - Trace cannot complete Audit: `checkAuditCompleteness` uses Trace only to reveal missing Audit evidence, and it never turns a Trace event into an Audit record.
  - Audit cannot rebuild a Run: it has no `getRunTrace`, and Metrics never read Audit.
- **Audit ≠ Authority.** No Governance, Authorization, Approval, Runtime, Tool, or Durability path reads Audit.
  - A forged `approval.resolved` leaves the repository `pending` and the Run waiting.
  - A forged `tool.access.allowed` leaves handler calls at 0 when Authorization denies.
  - Both are tested, and static boundary tests forbid any Audit read API in execution packages.
- **Audit ≠ Runtime state.** Recovery reads only the durability ledger. Corrupting or deleting the Audit store changes nothing about recovery (tested).

## Contract

`AuditEvent` (`@aao/contracts/audit.ts`, schema version 1, strict):

```text
{ schemaVersion: 1, eventId: "aud.<32 hex>", streamId: "run:<runId>", sequence, occurredAt, type, runId,
  actor: { id, type },          // host-attested principal only: user | service | system
  action, target, outcome,      // fixed by type (outcome of approval.resolved = its decision)
  payload,                      // strict per-type schema
  previousHash, eventHash }     // SHA-256 chain
```

| Type | Recorded at | Actor | Safe payload |
| --- | --- | --- | --- |
| `approval.requested` | record creation, `occurredAt = requestedAt` | requester | approvalId, nodeId, required approver role ids, permission classes, `allowSelfApproval`, request fingerprint |
| `approval.resolved` | after the repository's atomic `pending → approved/rejected` succeeded, `occurredAt = resolvedAt` | `resolvedBy` | approvalId, nodeId, decision, request fingerprint |
| `approval.resolution_denied` | refused attempt (engine clock) | attempted resolver | approvalId, nodeId, attempted decision, reason (`APPROVAL_HUMAN_REQUIRED`, `APPROVAL_RESOLVER_NOT_ELIGIBLE`, `APPROVAL_SELF_APPROVAL_FORBIDDEN`, `APPROVAL_ALREADY_RESOLVED`) |
| `tool.access.allowed` | the Authorization decision (recorder clock) | principal | toolExecutionId, attempt, nodeId, permission classes, registered Agent ref, `agentCeilingApplied` |
| `tool.access.denied` | the Authorization decision (recorder clock) | principal | toolExecutionId, attempt, nodeId, permission classes, Agent ref, Authorization reason code |
| `run.cancellation.requested` | durable request, `occurredAt = requestedAt` | requester | optional bounded reason code |
| `run.cancellation.applied` | the Run became CANCELLED, `occurredAt = RunRecord.updatedAt` | the accountable requester | step, nodeId, `requestedAt` |

- **Only real capabilities.** Policy changes, operator overrides, kill switches, side-effect execution, deployments, and secret rotation are absent because those capabilities do not exist.
- **Content limits.** There is never an Approval subject, Tool input or output, prompt, model output, state, credential, raw error, free-text comment, or profile data (email, display name, phone). The Trace exact-key content policy is reused as defense in depth.
- **Size.** Events are limited to 16 KiB (`MAX_AUDIT_EVENT_BYTES`). An oversized event is rejected and Audit marked degraded; it is never truncated, and the action is unaffected.
- **Identity.** The event id is derived from stream, type, and the emitter's semantic key, so it is deterministic. Source-timed types require `occurredAt` from the authoritative record, and the recorder's trusted clock is used only for Tool access decisions, whose source carries no time.

## Integration points

- **Approval Engine.** `createApprovalEngine({ governance, clock, repository?, audit? })`.
  - Requests are audited from the stored record. An exact-request replay re-emits the same event, which deduplicates.
  - Resolutions are audited only after compare-and-set success. This resolves the Sprint 15 timing question: Audit carries the true `resolvedAt`, and Trace's `approval.resolved` remains Runtime-consumption chronology.
  - A refused attempt by a well-formed principal is audited. A malformed principal is unattributable, so no actor is fabricated. System expiry and cancellation without a principal are not audited as resolutions; durable cancellation is covered by the cancellation events.
- **Tool Runtime.** `executeTool({ ..., audit: { port, runId, nodeId?, attempt } })`; the Tool Node passes `{ audit }` and the Runtime attempt.
  - Only Authorization decisions are audited. Support-gate, registration, missing-context, and request or input validation failures are not access decisions, so Audit does not become a duplicate error log.
  - Allowed means the invocation path may continue, not that the Tool succeeded. Trace owns execution chronology, and the two are correlated by `toolExecutionId` and attempt.
- **Durable host.** `createDurableRuntimeHost({ ..., audit? })` and `requestCancellation(runId, { requestedBy, reasonCode? })`.
  - The host-attested principal is required and stored on the durable `CancellationRecord`. The first accepted requester stays accountable, because requests are idempotent.
  - `run.cancellation.applied` distinguishes "someone asked" from "execution became CANCELLED".
  - Pre-Sprint 16 records without attribution still cancel but produce no applied Audit event.

## Store

`AuditStore`: `append(event)`, `getStream(streamId)`, `getEvent(streamId, eventId)`, `verifyStream(streamId)`. There is no update, delete, filter, search, cross-Run analytics, or SQL. Both implementations share one append decision (`AuditStreamLog`):

- **Validation.** Every event is validated before storage: schema, size, content policy, and its own `eventHash`.
- **Idempotency.** The same `eventId` with the exact same event is a no-op (`duplicate`). The same id with different content is `AUDIT_EVENT_CONFLICT`, and nothing is overwritten.
- **Ordering.** `sequence` must equal the stream length and `previousHash` must equal the last `eventHash`; otherwise the append is `AUDIT_SEQUENCE_CONFLICT`. Ordering is never inferred from timestamps.
- **Restart.** A new process continues the same stream, sequence, and chain.

File layout (local, single-host, single-writer; no database, SIEM, or audit vendor):

```text
<audit-root>/streams/<sha256(streamId)>/events/000000000.json, 000000001.json, …
```

- **Shared write path.** Writes use the same atomic path as the Trace store (`local-files.ts`): validate, write a temp file, fsync it, hard-link it into place create-if-absent, then fsync the directory. Committed files are immutable (mode `0600`), and temp files are never evidence.
- **Paths.** Stream ids are validated (`run:<runId>`) and hashed, so caller text never becomes a path. Symlinked directories fail closed.
- **Load.** Loading verifies integrity: schema, contiguity, identity, and the hash chain. A stream failing it is `AUDIT_STORE_CORRUPT` and is never extended or repaired. `verifyStream` reads raw files and reports tampering as diagnostics instead of throwing.

## Hash chain

- **Canonical form.** Canonicalization is the one contracts `canonicalJsonStringify`, shared with Trace and Durability fingerprints: recursively sorted keys, preserved array order, no whitespace.
- **Genesis.** `previousHash` of event 0 is `AUDIT_GENESIS_HASH` (64 zeros), never null or empty.
- **Event hash.** `eventHash = SHA-256(canonicalJson({ domain: "aao.audit-event.v1", event: <event without eventHash> }))`. The hashed content includes `previousHash`, `sequence`, and `streamId`.
- **`validateAuditStream(events, { streamId?, integrityOnly? })`** returns stable diagnostics and never repairs anything:
  - integrity: `AUDIT_INVALID_EVENT`, `AUDIT_EVENT_TOO_LARGE`, `AUDIT_FORBIDDEN_CONTENT`, `AUDIT_STREAM_MISMATCH`, `AUDIT_SEQUENCE_GAP`, `AUDIT_DUPLICATE_EVENT`, `AUDIT_PREVIOUS_HASH_MISMATCH`, `AUDIT_HASH_MISMATCH`;
  - event order (default): `AUDIT_EVENT_ORDER_VIOLATION`, e.g. a resolution without its recorded request, two resolutions, or an applied cancellation without its request.

  Every event after a break is still checked, so later valid-looking events cannot hide corruption.

**Limitation.** The local Audit stream is hash-chained and detects accidental or unauthorized modification when verified. It is **tamper-evident, not tamper-proof**: an actor with filesystem control can rewrite an entire unsigned chain consistently. There are no signatures, HSM, external anchoring, or distributed replication in Sprint 16.

## Failure policy

- **Non-authoritative.** In Sprint 16, Audit is non-authoritative. If Audit storage fails, the Approval, authorization decision, or cancellation that already committed is not rolled back, and nothing is retried because Audit failed.
- **Recorder behavior.** The recorder never throws into execution. Failures become bounded issues (`AUDIT_INVALID_EVENT`, `AUDIT_EVENT_TOO_LARGE`, `AUDIT_FORBIDDEN_CONTENT`, `AUDIT_EVENT_CONFLICT`, `AUDIT_SEQUENCE_CONFLICT`, `AUDIT_HASH_MISMATCH`, `AUDIT_STORE_FAILURE`, `AUDIT_STORE_CORRUPT`, `AUDIT_RECORDER_FAILURE`), with no raw exception text. `health()` and `streamHealth(streamId)` report `healthy` or `degraded`.
- **Health.** `summarizeObservabilityHealth({ trace, audit })` reports both channels separately. Audit degraded with Trace complete still yields complete Metrics.
- **Tested.** With a throwing `AuditStore`, Approval still resolves, Tool authorization and calls are identical, the Run outcome and Trace are unchanged, each Audit event is attempted exactly once, and health is degraded with the exception text hidden.
- **Future fail-closed Audit.** For `external_side_effect`, `destructive`, and `sensitive_data`, AAO may later require healthy mandatory Audit before execution. That is not implemented, and those classes remain unsupported by the Tool Runtime.

## Retention and privacy

Trace retention ≠ Audit retention: real deployments may need Audit kept longer. Sprint 16 chooses no global policy, runs no retention or deletion scheduler, and does not claim Audit is permanently retained. Future deletion obligations (privacy law) may conflict with Audit obligations; that is a later legal and product decision.

## Evaluation reads Audit; it never writes it

Since Sprint 17, the Approval- and Authorization-compliance graders in `@aao/evaluation` can cross-check Trace against an Audit stream:

- They read the stream only after `validateAuditStream` verifies it. A broken chain is untrustworthy evidence (`error`).
- Ordinary Eval outcomes are quality evidence, not accountability evidence, so they are never recorded in Audit, and there is no `eval.*` Audit event.
- Future audited operator or release decisions about Eval results are a later concern.

See [evaluation runtime](evaluation-runtime.md).

Canonical sanitized fixtures in `packages/observability/test/fixtures/audit/`: `approval_approved`, `approval_denied_attempt`, `tool_access_allowed`, `tool_access_denied`, `cancellation_requested_applied`, `tampered_chain`.
