# Security boundaries

How AAO's existing contracts combine into one security boundary for Local V1. Decision record: [ADR-034](../decisions/ADR-034-security-identity-adapter-hardening.md). Threat model: [local-v1-threat-model.md](../security/local-v1-threat-model.md). Permission classes: [permission-model.md](../security/permission-model.md).

```text
 untrusted request (runId, body, serialized state)
          │
          ▼
 TRUSTED HOST ── authenticates, then identity.attest(principal) → AttestedActor
          │
          ▼
 createCompanyAAO (trustedIdentity mode)
   1. identity.resolve(actor)            → IDENTITY_ATTESTATION_REQUIRED
   2. requireCompanyAdmission / resolveAuthority (canonical Governance)
   3. runBindings.claim(TrustedRunBinding) → RUN_BINDING_CONFLICT / _INVALID
          │   (denied ⇒ 0 model, Tool, provider, Approval, draft calls)
          ▼
 AAO Runtime ── principalForRun(runId) = binding.principal (only source after admission)
   ├─ Model Runtime → adapter result validation → deterministic proposal validation
   ├─ Tool Runtime  → authorize() before input validation and handler → output schema
   └─ Approval node → Approval Engine (requester = bound principal)
          │ waiting: facade records sha256(execution) as the waitpoint
          ▼
 approve/reject(approvalId, AttestedActor) → eligibility, separation of duties, once only
          │
          ▼
 continue(execution, actor):
   Host-Attested Principal
        → Canonical Governance (admission)
        → Immutable Run Binding
        → Original Requester Ownership (principal id + type)
        → Verified Waiting State
        → Approval Verification
        → Runtime Continuation
          │
          ▼
 Trace / Audit (metadata only, emit-only, never authority)
```

## Authentication vs authorization

- **Authentication** (who is calling) belongs to the host. AAO accepts the result only as an `AttestedActor` minted by the host's attestor. Membership is checked by object identity, so no request data can become an actor.
- **Authorization** (what they may do) is always canonical Governance (`resolveAuthority`), evaluated at admission and again at every Tool and Approval boundary. Mutable eligibility, such as a revoked role binding, is re-checked there.

## Run binding and recovery

A Run ID is bound once to `{ companyId, principal, proofRef, configurationFingerprint, workflowFingerprint }`. Identical re-claims (replay, recovery) succeed. Any differing claim fails. With `createFileRunBindingStore`, bindings survive restart, and the restarted host resolves the same requester. Approval records in the shipped proofs are in-memory: a waiting Run does **not** resume across a process restart, it fails closed.

## Approval separation of duties

Self-approval, resolution by an ineligible role or another company's actor, a second resolution, and a caller-supplied `resolvedBy` (in hardened mode) are refused. An Approval binds the request fingerprint over Run, node, revision and subject. The draft Tool re-derives that fingerprint from its payload, so payload B can never use the Approval granted for request A.

An authorized approver is not automatically an authorized continuation requester. Continuation ownership is the original bound principal; Local V1 has no delegation.

## Replay and idempotency

| Failure | Behavior |
|---|---|
| Duplicate or concurrent continuation | `claimContinuation` admits one; at most one draft |
| Save then throw | Reconciled against the repository → one draft, success |
| Crash after persist, before checkpoint | Re-run finds the draft by `toolExecutionId` → no duplicate |
| Proven no-write failure | Run fails, reservation released, no draft |
| Retryable error from an unsafe Tool | Not retried, whatever the policy |
| Timeout | Attempt abandoned, late result ignored, unsafe Tool not retried |

Exactly-once is **not** claimed. Idempotency is only as strong as the host repository's per-id atomicity.

## Adapter permissions

Adapters (Model, Tool, MCP) implement AAO contracts and grant nothing. Tool specs, permission classes and retry safety are host-owned. MCP discovery names, descriptions and annotations are untrusted data. Provider exceptions are never parsed or forwarded.

## Local HTTP exposure

The Control Center is GET/HEAD-only and unauthenticated. It requires a loopback `Host` and, when present, a loopback `Origin`; it refuses `Sec-Fetch-Site: cross-site` and emits no CORS headers. HTML is served under `default-src 'none'; frame-ancestors 'none'`. Binding to a non-loopback address disables inspection entirely. The default source is the demo fixture (`DEMO DATA — NOT LIVE OPERATIONS`), and live evidence requires a host-constructed source.

## Privacy and audit

Trace and Audit are metadata-only (ADR-020/021): no request text, proposed values, Approval subject, Tool payloads or provider errors. Audit is evidence, emitted through `emitAuditSafely`, so an unavailable store never changes a decision. A company host that supplies `createCompanyAAO({ audit })` forwards that emit-only port to every enabled proof. Company admission denials are not Tool-access events.

## Unsupported security claims

AAO Local V1 does **not** claim: protection against a compromised host; cryptographic or remote attestation; authenticated remote operations; MCP sandboxing; exactly-once external effects; multi-tenant isolation; prompt-injection immunity beyond validation and mandatory human Approval; or canonical Audit records for admission denials (deferred, see ADR-034).
