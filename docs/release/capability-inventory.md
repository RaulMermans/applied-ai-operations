# Local V1 capability inventory

Classifications:

- `IMPLEMENTED_AND_VERIFIED` — code exists and a test, proof, or smoke exercises it.
- `IMPLEMENTED_WITH_LIMITATIONS` — code exists; documented limits apply.
- `DEMONSTRATION_ONLY` — fixtures/demo, not an operational deployment.
- `NOT_SUPPORTED` — refused or out of scope.

| Area | Classification | Release answer |
| --- | --- | --- |
| Workflow Runtime | IMPLEMENTED_AND_VERIFIED | Sequential graphs; node kinds `tool`, `approval`, `model`, `agent`, `deterministic`, `final_output`. `evaluator` refused at Framework preparation. Conditional routing DSL is not a product feature. |
| Model Runtime | IMPLEMENTED_WITH_LIMITATIONS | Native + Vercel AI SDK adapters, structured output, cancellation forwarding. Proofs and benchmarks use fake adapters. Live provider inference is host-supplied and unverified here. |
| Tool Runtime | IMPLEMENTED_AND_VERIFIED | `read_only` and `write_draft` execute. Other permission classes fail closed. Authorization before handler. |
| MCP | IMPLEMENTED_WITH_LIMITATIONS | stdio sessions, host-owned bindings, metadata is not authority. No HTTP/OAuth MCP. No executable sandbox. |
| Governance | IMPLEMENTED_AND_VERIFIED | Host-attested actors, roles, deny policies. Authorization decisions are AAO's `authorize()` / `resolveAuthority`, never the model. |
| Approval | IMPLEMENTED_WITH_LIMITATIONS | Exact-request fingerprint, separation of duties, continuation ownership (Sprint 29C). Framework Approvals are in-memory; process restart of a waiting `createAAO()` Run fails closed. |
| Durability | IMPLEMENTED_WITH_LIMITATIONS | Filesystem checkpoints, recovery-safe replay for trusted operations, corrupt checkpoint refusal. Not exactly-once external IO. Proof Approvals are not the durable repository. |
| Observability | IMPLEMENTED_AND_VERIFIED | Trace, derived Metrics, hash-chained Audit. Metadata only. Audit failure does not grant authority. |
| Evaluation | IMPLEMENTED_AND_VERIFIED | Deterministic graders, Foundation CI gate, adapter conformance. No model-judge merge gate. |
| Company configuration | IMPLEMENTED_AND_VERIFIED | `CompanyManifestV1` preflight; Northstar Commerce and Arbor Consulting run the same three workflows. Process-local isolation, not distributed multitenancy. |
| Capability Packs | IMPLEMENTED_AND_VERIFIED | Three packs, compatibility against trusted registration snapshots. Default Control Center view is `NOT_VERIFIED` without that evidence. |
| Control Center | IMPLEMENTED_WITH_LIMITATIONS | Read-only CLI/API/UI, loopback, GET-only. Demo provenance by default. |
| Security | IMPLEMENTED_AND_VERIFIED | Adversarial suite in `examples/security-hardening` (Sprint 29/29C), enforced in `pnpm test`, `pnpm proof:security-hardening`, and Local V1 release verification. |
| Distribution | IMPLEMENTED_WITH_LIMITATIONS | Source checkout + pnpm. Packed tarballs inspected, not published. Standalone npm install of one package is `NOT_SUPPORTED`. |
