# Security regression testing

The Sprint 29 security suite lives in [`examples/security-hardening`](../../examples/security-hardening) (ADR-034). One scenario module (`src/scenarios.ts`) is executed three ways:

| Command | What it runs |
|---|---|
| `pnpm vitest run examples/security-hardening` | One Vitest test per case, against current source (part of `pnpm test` / `pnpm check`) |
| `pnpm proof:security-hardening` | Builds, then prints every case grouped by area; exit 1 on any failure |
| `node examples/security-hardening/smoke/sprint29.mjs` | Compiled smoke (after `pnpm build`): mandatory checks, then `SPRINT_29_SECURITY_IDENTITY_ADAPTER_HARDENING_SMOKE_OK` |

Everything runs offline, on fictional Northstar and Arbor fixtures from `@aao/example-company-portability`, with a local hostile MCP server (`fixtures/mcp-server.mjs`). No credentials are used and no public services are contacted.

## How cases assert

Each case measures behavior and never checks message wording: model, provider and document call counters; draft repository counts; Approval status and `resolvedBy`; `isOriginAttested`; Run binding contents; HTTP status and headers; serialized results, Trace, Audit, API, HTML and CLI output. Every hostile fixture embeds `FIXTURE_SECRET` (`sk-live-FIXTURE-SECRET-29`), and the privacy assertions require it to be absent. Deterministic code makes every judgment; there is no LLM judge.

Failure injection uses substituted collaborators only: a repository that saves then throws, one that is unavailable, a Tool handler that returns retryable errors or never answers in time, a Model Adapter that throws, times out or returns junk, an MCP server that throws or exits mid-call, a throwing Audit port, and corrupted binding files.

## Expected denials (reason codes)

- `CompanyAdmissionError.reasonCode`: `IDENTITY_ATTESTATION_REQUIRED`, `IDENTITY_MODE_MISMATCH`, `GOVERNANCE_DEFAULT_DENY`, `GOVERNANCE_POLICY_DENY`, `RUN_BINDING_CONFLICT`, `RUN_BINDING_INVALID`, `RUN_BINDING_MISMATCH`, `CONTINUATION_STATE_MISMATCH`.
- Approval: `APPROVAL_IDENTITY_ATTESTATION_REQUIRED`, `APPROVAL_SELF_APPROVAL_FORBIDDEN`, `APPROVAL_RESOLVER_NOT_ELIGIBLE`, `APPROVAL_ALREADY_RESOLVED`; Runtime continuation: `APPROVAL_STILL_PENDING`, `APPROVAL_REQUEST_MISMATCH`, `APPROVAL_REJECTED`.
- Tool and Model failures surface as the Runtime's normalized `NODE_EXECUTION_FAILED` / `NODE_ATTEMPT_TIMEOUT`, with no draft and no Approval.

## Mutation check

The cases were checked against reintroduced defects. Each mutation below makes its targeted case fail:

| Mutation | Failing case(s) |
|---|---|
| Attest origin before verifying (`if (true)`) | `continuation.forged-refused-before-origin-attestation` |
| Skip the waitpoint digest comparison | `continuation.forged-state-refused`, `continuation.approval-id-reuse-across-runs` |
| Skip the JSON check before digesting | `continuation.forged-state-refused` |
| Accept a shape-valid actor | `identity.forged-principal` |
| Drop `frame-ancestors 'none'` | `control-center.html-hardening-and-demo-provenance` |
| Unbounded MCP args | `mcp.launch-config-bounded` |

## Case matrix

| Case | Area | Invariant |
|---|---|---|
| `identity.missing-attestation` | identity | No actor → admission denied, 0 model/provider/draft calls, no Run binding |
| `identity.forged-principal` | identity | A lookalike object, a bare Principal, or another attestor's token is never an actor; 0 model and Tool calls |
| `identity.malformed-principal` | identity | The attestor refuses a malformed principal; no token is minted |
| `identity.unregistered-principal` | identity | An attested but unregistered principal is denied by canonical Governance with 0 calls |
| `identity.cross-company-principal` | company_isolation | Another company's attested requester cannot execute this company's Workflow |
| `identity.run-id-convention-grants-nothing` | identity | A Run ID that looks like a requester's or manager's Run does not change who the caller is |
| `identity.rebind-other-actor` | identity | An existing Run ID cannot be rebound to a different actor |
| `identity.rebind-other-company` | company_isolation | A Run ID bound to company A is refused for company B (shared binding store), with 0 calls in B |
| `identity.rebind-other-workflow` | identity | A Run ID bound to one Workflow cannot be reused for another |
| `identity.valid-binding` | identity | An attested, authorized requester binds the Run to company, principal, proof, configuration and Workflow fingerprints |
| `identity.restart-preserves-binding` | identity | A file-backed binding survives restart unchanged and still refuses a conflicting claimant |
| `identity.corrupt-binding-fails-closed` | identity | A corrupt durable binding record is never read as a binding and cannot be overwritten |
| `identity.concurrent-claim` | identity | Two concurrent claims of one Run ID: exactly one wins (in-process and across store instances) |
| `identity.no-silent-fallback` | identity | Composition requires exactly one identity source; demo mode refuses an actor instead of ignoring it |
| `approval.self-approval-refused` | approval | The attested requester cannot approve their own request, even when they hold the approver role |
| `approval.unattested-resolver-refused` | approval | A caller-supplied resolvedBy (bare Principal) is not evidence of identity |
| `approval.ineligible-and-cross-company-resolver-refused` | approval | An attested analyst (wrong role) and another company's manager cannot resolve the Approval |
| `approval.eligible-accepted` | approval | An attested eligible manager approves; the record names that manager |
| `approval.duplicate-and-concurrent-resolution` | approval | An Approval resolves exactly once: concurrent approve/reject yields one winner; later attempts are refused |
| `approval.rejected-no-draft` | approval | A rejected Approval never continues into draft creation |
| `approval.audit-evidence-without-payload` | observability | Approval denials reach the canonical Audit Store as metadata only (no request text) |
| `approval.audit-failure-is-not-bypass` | authorization | A failing Audit port changes no security decision |
| `continuation.correct-succeeds` | continuation | Requester continues the exact waiting state after eligible approval → exactly one draft |
| `continuation.forged-state-refused` | continuation | Altered, stale, or non-JSON execution state is refused before the proof or Approval verification runs |
| `continuation.forged-refused-before-origin-attestation` | continuation | No forged continuation (pending, foreign Run, altered subject) obtains origin attestation; the genuine one does |
| `continuation.unauthorized-or-missing-actor` | continuation | Continuation requires an attested, admitted actor |
| `continuation.cross-company-replay` | company_isolation | Company A's approved waiting state cannot be continued through company B |
| `continuation.approval-id-reuse-across-runs` | continuation | Run A's approval cannot continue Run B (hardened: state mismatch; Runtime: request mismatch) |
| `replay.duplicate-continuation` | replay | Replaying a completed continuation never creates a second draft |
| `replay.concurrent-continuation` | replay | Concurrent continuations of one approved Run produce no duplicate logical draft |
| `replay.approval-fingerprint-mismatch` | replay | An Approval binds its exact fingerprint and payload: another fingerprint or a changed payload is refused |
| `replay.save-then-throw` | replay | A repository that persists then throws is reconciled to exactly one draft, not a duplicate or a false failure |
| `replay.crash-after-persist-before-checkpoint` | replay | After a crash between draft persistence and checkpoint, re-running the same Run reuses the persisted draft |
| `replay.persistence-failure-releases-safely` | replay | A proven no-write failure fails the Run, creates no draft, and releases the Approval reservation |
| `replay.unsafe-tool-retry-not-repeated` | replay | A retryable error from an unsafe Tool, under a 3-attempt policy, invokes the handler exactly once |
| `replay.timeout-before-tool-result` | replay | A Tool that times out is not retried (unsafe) and leaves no draft |
| `tool.extra-fields-rejected` | tool_adapter | Unexpected output fields (e.g. a permission grant) are a schema failure |
| `tool.non-json-output-rejected` | tool_adapter | Non-JSON-safe output is rejected |
| `tool.oversized-output-rejected` | tool_adapter | An oversized output field is rejected by the Tool's contract |
| `tool.malformed-result-rejected` | tool_adapter | A malformed handler result is normalized |
| `tool.secret-exception-normalized` | tool_adapter | A provider exception's message never leaves the Tool Runtime |
| `tool.provider-unavailable-normalized` | tool_adapter | Provider unavailability is a normalized failure with no draft |
| `tool.unauthorized-handler-never-invoked` | authorization | Missing or insufficient authorization: the handler is never invoked |
| `tool.policy-override-output-is-data` | authorization | Tool output telling AAO to grant permissions is data; authority is unchanged |
| `model.invalid-json-output` | model_adapter | Unparseable or schema-invalid structured output is a normalized failure with no Approval and no draft |
| `model.malformed-usage-and-finish-reason` | model_adapter | Malformed token usage or an invalid finish reason is not a success |
| `model.provider-exception-normalized` | model_adapter | A provider exception (with a secret) and extra debugging fields are normalized and never leaked |
| `model.oversized-output-rejected` | model_adapter | An oversized proposal is rejected by deterministic validation before Approval |
| `model.timeout-normalized` | model_adapter | A model call exceeding its attempt timeout fails the Run; a late result cannot commit |
| `model.prompt-injection-cannot-skip-approval` | model_adapter | Injected instructions in a model proposal do not bypass human Approval |
| `model.unsupported-capability-refused` | model_adapter | A binding requiring a capability its adapter declares unsupported is refused at composition |
| `model.cross-company-binding-isolation` | company_isolation | A Northstar Run never reaches Arbor's model binding or provider |
| `mcp.metadata-grants-no-authority` | mcp | Hostile discovery metadata (claims of authority, read-only hints) changes neither spec, permission nor retry safety |
| `mcp.server-exception-normalized` | mcp | A remote exception carrying a secret is normalized |
| `mcp.session-terminates-mid-invocation` | mcp | A server exiting during a call is a normalized failure and the session leaves READY |
| `mcp.launch-config-bounded` | mcp | Launch config is bounded: NUL bytes, oversized args, env and cwd overrides are refused |
| `mcp.failed-connection-cleanup` | mcp | A failed connection never becomes READY and closes cleanly |
| `control-center.non-loopback-refused` | control_center | Non-loopback Host (incl. DNS rebinding) is refused on API and HTML routes |
| `control-center.cross-site-refused` | control_center | Foreign Origin, null Origin and Sec-Fetch-Site: cross-site are refused; no CORS headers |
| `control-center.read-only` | control_center | Mutating methods are refused; the UI has no forms or scripts |
| `control-center.html-hardening-and-demo-provenance` | control_center | HTML has a no-script, no-framing CSP and an explicit DEMO DATA banner |
| `control-center.bounded-inputs-no-stack` | control_center | Oversized/hostile query and path inputs are refused without stack traces or source paths |
| `control-center.disabled-without-source` | control_center | Without a trusted inspection source (the non-loopback server path) no inspection route exists |
| `observability.trace-has-no-payloads` | observability | A full governed Run's Trace carries no request text, proposed values or Approval subject |
| `observability.sensitive-error-not-exposed` | observability | A secret-bearing provider error appears in no Trace, inspection API response or CLI output |

## Known gaps

- Admission denials, binding conflicts and invalid continuations have no canonical Audit event yet (see ADR-034); cases assert the thrown reason codes instead.
- Continuation after a process restart is not exercised as a *resume*, because the proofs keep Approval records in memory; restart is tested for binding recovery and draft idempotency.
- Concurrency cases exercise in-process interleavings and two store instances sharing one directory, not multiple OS processes.
- API and CLI privacy coverage for live Runs uses an evidence-backed inspection source built from the Run's real Trace; the shipped Control Center serves demo fixtures only.
