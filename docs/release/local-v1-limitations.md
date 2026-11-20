# AAO Local V1 — known limitations

Local V1 is a **source-distributable release candidate**. This document is the inventory of what is implemented, what is verified, and what must not be claimed.

## Distribution

- The repository is the supported distribution. Packages remain `private: true` at version `0.0.0` with `workspace:*` internal dependencies.
- Packages are **not published to npm**.
- A packed `@aao/framework` tarball does not resolve on its own: unpublished workspace packages are not rewritten to registry versions.
- There is no GitHub Release, container image, or hosted SaaS.

## Identity and Framework vs company host

- `createAAO({ principalForRun })` trusts the host function. A caller-controlled Run ID is not identity.
- Sprint 29 `createCompanyAAO({ trustedIdentity })` is stronger (attested actors, immutable Run binding, original-requester continuation). It does **not** wrap every `createAAO()` application.

## Approval and durability

- Framework Approval records are **in memory**. An Approval-waiting Run cannot be successfully resumed after a full process restart of a `createAAO()` app; continuation fails closed (`INVALID_APPROVAL_CONTEXT`).
- `@aao/durability` can persist Approvals when the host uses the file store as the Approval repository. The flagship Operational Request **proof** uses in-memory Approvals and does not claim full restart-resumable human Approval.
- Local draft idempotency is not exactly-once execution of external systems. External side-effect permission classes fail closed.

## Tools, MCP, models

- Executable permission classes: `read_only` and `write_draft`. `external_side_effect`, `destructive`, and `sensitive_data` fail closed.
- MCP is stdio only. Remote MCP metadata grants no authority. The host is responsible for what executable it launches; there is no sandbox for arbitrary MCP binaries.
- Model adapters in the proofs and benchmarks are deterministic fakes. Those numbers are not OpenAI, Anthropic, or GPU inference latency.

## Control Center

- Local, GET-only, unauthenticated, loopback-restricted.
- Default views are demo fixtures. `NOT_VERIFIED` pack compatibility means trusted registration evidence was not supplied, not that the Runtime is broken.
- No authenticated remote operator access.

## Security claims that are out of scope

Local V1 does **not** guarantee:

- protection against a compromised trusted host;
- authenticated remote Control Center access;
- adversarial distributed multitenancy;
- arbitrary MCP executable sandboxing;
- full restart-resumable human Approval on the Framework / proof path;
- exactly-once external effects;
- general external side-effect execution;
- identity federation;
- long-term Agent memory;
- unrestricted autonomous Tool use.

## Performance

Benchmark numbers are descriptive measurements of one machine. They are not CI pass/fail thresholds and not a capacity plan.
