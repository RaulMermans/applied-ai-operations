# ADR-034: Security, identity, approval integrity and adapter hardening

- Status: Accepted (Sprint 29)
- Builds on: ADR-004 (deterministic side-effect authority), ADR-014 (authorization), ADR-016 (governance), ADR-017 (approval), ADR-019 (durability), ADR-021 (audit), ADR-025 (adapters), ADR-030 (company portability), ADR-032/033 (inspection).
- Threat model: [`docs/security/local-v1-threat-model.md`](../security/local-v1-threat-model.md).

## Context

A Sprint 29 review of the existing boundaries found two real weaknesses and several gaps. The other mechanisms were already correct and are kept unchanged.

1. **Identity from Run IDs.** `requireCompanyAdmission()` and the framework resolve the actor with `principalForRun({ runId })`. The company fixtures pick the actor by Run ID text (`runId.includes("ops")` → requester). The Run ID is caller-chosen, so in that mode the caller picks their own identity. No company-layer mechanism existed to do it differently.
2. **Origin attestation before verification.** `OperationalRequestProof.continue(execution)` called `attestExecutionOrigin(execution.run.runId, …)` for *any* execution object before anything was checked. The canonical Runtime continuation (`continueApprovedWorkflow` → `continueWaitingWorkflow`) still refused forged states, so no draft could be forged. But the attestation, a security signal, was granted to unverified input.
3. **Approval resolver identity.** `approvals.approve(id, approver)` accepts any `Principal` value: a caller-controlled `resolvedBy`.
4. **Gaps:** the framework never passed an Audit port to the Approval Engine or Tool node; the draft Tool's output schema left `draftId` unbounded; MCP launch arguments were unbounded; the Control Center HTML could be framed and accepted browser `cross-site` requests that carried a loopback Host.

## Decision

Hybrid deterministic hardening. No new Runtime, Governance, Approval or Evaluation engine, and no new Agent.

### Trusted host identity and immutable Run binding (`@aao/example-company-portability`)

- `createTrustedHostIdentity()`: the host mints an opaque `AttestedActor` after its own authentication. `resolve(actor)` recognises only tokens this attestor minted, **by object identity** (a module-private `WeakMap`), never by shape. Lookalike objects, bare `Principal`s, deserialized tokens and other attestors' tokens resolve to nothing.
- `TrustedRunBinding { runId, companyId, principal, proofRef, configurationFingerprint, workflowFingerprint, createdAt }`, kept in a write-once `RunBindingStore`:
  - `createInMemoryRunBindingStore()`: a synchronous check-and-set, atomic within the process.
  - `createFileRunBindingStore({ root })`: temp file → fsync → `link(2)` (which never overwrites) for restart and cross-process uniqueness. File names are SHA-256 of identifiers. Corrupt records are not bindings and cannot be overwritten (`RUN_BINDING_INVALID`).
  - A re-claim is accepted only when every field except `createdAt` is identical (replay or recovery). Anything else is `RUN_BINDING_CONFLICT`.
  - No credentials, tokens or Run state are stored.
- `createCompanyAAO({ trustedIdentity: { identity, runBindings } })` (hardened mode). Every entry point takes `actor`, then in order:
  1. resolve the attested principal (`IDENTITY_ATTESTATION_REQUIRED`);
  2. run canonical `requireCompanyAdmission()` / `resolveAuthority()` for that principal;
  3. atomically claim the binding.

  Only then does the Workflow start, so a denied Run makes 0 model, Tool, provider, Approval or draft calls. After admission, the proofs' `principalForRun` reads **only the binding**, so Tool Authorization and the Approval requester are the bound principal for the whole Run, including after restart.
- Exactly one identity source is required: `principalForRun` (demo mode) **or** `trustedIdentity`, never both and never neither (`CONFIG_SCOPE_MISMATCH`). Demo mode refuses an `actor` (`IDENTITY_MODE_MISMATCH`) instead of silently ignoring it.
- One `runBindings` store shared across a host's companies makes cross-company Run ID reuse a conflict.

### Continuation integrity

- **Hardened facade.** When a Run reaches an Approval wait, the facade records a waitpoint: SHA-256 of the canonical JSON of the exact execution it returned. `continue(execution, actor)` then checks, in order: the attested actor, canonical admission, the binding (company, proof, configuration and Workflow fingerprints → `RUN_BINDING_MISMATCH`), and that `execution` is byte-for-byte the recorded state (`CONTINUATION_STATE_MISMATCH`; non-JSON state is refused, because `JSON.stringify` would silently drop it). Only then does the proof run.
- **Proof.** `continue()` attests the Tool origin only when the canonical Approval Engine holds an **approved** record for this exact Run, wait node and fingerprint, and the fingerprint recomputed from the execution matches. Every other continuation proceeds unattested, and the Runtime returns its canonical failure.
- The Runtime's own checks (`continueWaitingWorkflow`, `claimContinuation`, governance revalidation) are unchanged and remain the final authority.
- The trusted, in-memory `OperationalRequestProof.continue(execution)` remains a privileged host API. The untrusted entry point is the hardened facade.

### Approval resolution

In hardened mode the facade's `approvals.approve/reject` require an `AttestedActor`; a bare `Principal` is `APPROVAL_IDENTITY_ATTESTATION_REQUIRED`. Eligibility, separation of duties, single resolution and cross-company refusal remain the canonical Approval Engine's.

### Adapter, MCP, Control Center and audit

- Tool and Model adapters: no change to the Runtimes. Their existing validation and normalization was verified adversarially (see the test matrix). The draft Tool's `outputSchema.draftId` is pinned to `^draft\.[a-f0-9]{16}$`.
- MCP: the launch config is bounded (command and args ≤ 4096 chars, ≤ 64 args, no NUL). `env` and `cwd` remain refused, `spawn` runs without a shell, and the SDK forwards only its safe default environment. **No command allowlist is added**: the config is already host-owned and nothing of lower trust (manifest, Workflow, Pack, model) can select a command, so a host allowlisting its own config would be circular. Add one if a lower-trust selector is ever introduced.
- Control Center: refuses `Sec-Fetch-Site: cross-site`. The HTML CSP adds `frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. The existing loopback Host/Origin guard, GET-only rule, no CORS, and non-loopback-bind-disables-inspection are verified.
- Audit: `createAAO({ audit })` passes an existing emit-only `AuditPort` to the Approval Engine and Tool node, so canonical `approval.*` and `tool.access.*` evidence is emitted in framework apps. `createCompanyAAO` and the Operational Request proof forward it. A failing port changes no decision.

## Guarantees (tested)

See [`docs/testing/security-regressions.md`](../testing/security-regressions.md) for the 65-case matrix. In summary:

- Run IDs never establish identity, bindings are immutable, and conflicting, cross-company and cross-Workflow claims are refused. Concurrent claims have one winner. Bindings survive restart.
- No forged, stale, foreign or non-JSON continuation obtains origin attestation or a draft.
- An Approval binds one fingerprint and payload. A replayed or concurrent continuation creates at most one draft. Save-then-throw is reconciled, and a crash after persistence is idempotent by `toolExecutionId`.
- Unsafe Tools are never retried automatically, and timeouts and provider failures leave no draft.
- Provider secrets do not appear in results, Trace, the inspection API, HTML or CLI text.

## Remaining risks and deferred guarantees

- **In-process attestation only.** Any code in the host process with the attestor can mint actors. There is no cryptographic attestation, token expiry or revocation; role changes take effect through Governance re-checks at each boundary.
- **Demo mode remains** for the Sprint 22–28 fixtures and proofs, whose resolvers still use a Run ID naming convention (marked `shortcut:`). Hosts handling real users must use `trustedIdentity`. The framework's `createAAO` still takes `principalForRun({ runId })`; direct framework users must bind identity themselves.
- **Continuation is not loaded from Durability.** The Operational Request proof does not use durable checkpoints. Integrity is digest equality against the host-recorded waitpoint. Approval records, consumption reservations and fixture repositories are in-memory, so after a process restart a waiting Run cannot continue: it fails closed (unresolved), it does not resume.
- **No exactly-once claim.** Draft creation is idempotent by `toolExecutionId` only to the extent the host repository's save is atomic per id.
- **Audit gaps.** No canonical Audit event exists for admission denial, binding conflict or invalid continuation. They surface only as `CompanyAdmissionError.reasonCode`. Adding one is an ADR-021 contract change (a new type plus Trace-correlation rules; a denial without an attested actor has no `actor`), and it is deferred.
- **Size bounds are per contract** (Tool output schemas, proposal validators). There is no global byte cap on Tool or Model output.
- **Cancellation.** The Runtime always passes a canonical abort signal. Adapters declaring `model.cancellation: unsupported` (the native fixture) do not stop provider work; late results are ignored and cannot commit.
- **Control Center is unauthenticated.** Any local user or process can read it. It serves demo data by default, and an authenticated remote deployment does not exist.
- **File binding store** assumes a local POSIX filesystem (`link(2)`), with no directory fsync; it is not suitable for network filesystems.

## Rejected alternatives

- **An identity platform, OAuth or JWT.** Out of scope for Local V1; identity stays the host's job.
- **Adding company or principal fields to the Durability `RunManifest`.** That would make company scoping a core contract (it is a company-layer concept, ADR-003).
- **Shape-validated actor objects.** A shape can be forged by any request body.
- **Loading continuation state from storage** inside the company facade. It would duplicate Durability; the digest check gives equivalent integrity for the Run lifetime without storing Run state.
- **A global byte cap in the Tool and Model Runtimes.** It is a core semantic change; per-contract bounds already exist.
- **A new Audit event type in this sprint.** See Remaining risks.
