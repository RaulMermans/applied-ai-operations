# Local V1 threat model

Status: Sprint 29 (ADR-034). Scope: AAO running locally inside one trusted host process, with fictional or operator-owned data. Executable truth: `examples/security-hardening` (`pnpm proof:security-hardening`).

## Trust boundaries

| Boundary | Trust assumption | Enforced by |
|---|---|---|
| Trusted host application | Authenticates people/services, mints `AttestedActor`s, registers capabilities, owns stores | Out of AAO; a compromised host is out of scope |
| External request (run ID, request body, serialized state) | Untrusted data | Schema validation, admission, Run binding |
| Run ID | An identifier, never authentication evidence | `TrustedRunBinding` (identity is bound to it once) |
| Workflow input | Untrusted | Workflow intake validators |
| Model output | Untrusted | Model Runtime validation + deterministic proposal validation |
| Tool arguments / Tool output | Untrusted | Tool Runtime input/output schemas, JSON safety |
| Remote MCP server | Untrusted capability provider | Host-owned spec, private session binding, Tool Runtime |
| Model Adapter response | Untrusted | Model Runtime result validation, failure normalization |
| Approval request | Must be verified | Canonical Approval Engine (fingerprint, eligibility) |
| Approval resolution | Requires an eligible, attested human actor | Engine eligibility + separation of duties; hardened facade requires `AttestedActor` |
| Continuation state | Untrusted unless it is exactly what the host recorded | Run binding + waitpoint digest + Runtime continuation checks |
| Durable checkpoint / binding record | Integrity-checked recovery evidence, not authority | Schema validation on read; corrupt records fail closed |
| Local inspection API | Local-only, **not authenticated** | Loopback Host/Origin/Sec-Fetch-Site guard, GET-only, demo data by default |
| Capability Pack metadata | Requirements, not authority | Pack compatibility is evidence-backed (ADR-031/033) |

## Attacker capabilities tested

The attacker controls **data that reaches the host's entry points**, not host code:

- submit arbitrary Run IDs, including IDs resembling another user's Run or a demo naming convention;
- pass lookalike actor objects, bare `Principal` objects, or tokens from another attestor;
- reuse a Run ID across actors, Workflows or companies, concurrently or after restart;
- alter, replay or reorder serialized `RuntimeExecutionState` (subject, revision, wait reference, extra fields);
- replay Approval IDs across Runs, resolve concurrently, or submit a caller-chosen `resolvedBy`;
- operate a malformed, slow, secret-leaking or prompt-injecting Model Adapter or Tool provider;
- operate a hostile MCP server (authority claims in metadata, exceptions with secrets, mid-call exit);
- send cross-site or DNS-rebound HTTP requests to the local Control Center, oversized inputs, or mutating methods.

Every capability above has at least one case in [`docs/testing/security-regressions.md`](../testing/security-regressions.md).

## Out of scope (no guarantee is claimed)

- A compromised trusted host, or any code running inside the host process (it can mint actors).
- Other local OS users or processes reading the loopback Control Center or local files.
- Cryptographic or remote attestation of identity.
- Sandboxing of MCP executables the host chooses to launch.
- Exactly-once external network effects without provider-side idempotency.
- Prompt injection resistance beyond deterministic validation and mandatory human Approval.
- Adversarial multi-tenant isolation (companies share one host process).
