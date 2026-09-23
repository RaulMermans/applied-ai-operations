# ADR-007: Canonical domain contracts

Status: accepted

## Context

Sprint 0 froze AAO's product and architecture contract in prose. Sprint 1 established a runnable local engineering foundation (Control Plane, Worker, `@aao/config`, CI) with no production domain semantics. Every later AAO subsystem — runtime, integrations, governance, evaluation, observability, capability packs, and company deployments — needs one authoritative, runtime-validatable language to describe workflows, execution, agents, skills, tools, capabilities, governance, approvals, state, durability, evaluation, traces, artifacts, capability packs, and company configuration, without any of those systems being implemented yet.

## Decision

- `@aao/contracts` (`packages/contracts`) is the canonical production contract package. It is the dependency direction for all later AAO production code (runtime, integrations, governance, evals, packs, deployments); nothing flows the other way, and it must never depend on `apps/*`, `packages/config`, `packages/substrate-contracts`, or `packages/substrate-spikes`.
- Every canonical contract is a Zod schema; every canonical TypeScript type is inferred from its schema (`z.infer`), not maintained as a separate hand-written type.
- Every canonical contract is JSON-safe: no functions, class instances, `Date` instances, or framework/SDK objects. Persisted timestamps are ISO-8601 strings. Content that cannot yet be meaningfully typed is bounded by `JsonValue`/`JsonObject`, never `any`.
- Contracts remain framework-neutral and vendor-neutral. `@aao/contracts` has zero imports from LangGraph, the Vercel AI SDK (`ai`), the MCP SDK, Fastify, or any vendor SDK; its only production dependency is `zod`.
- `schemaVersion` (the structure of a contract) is kept distinct from an entity's own `version` (e.g. a workflow's or tool's revision). There is no migration engine — a schema version bump is a deliberate, explicit change.
- Workflow remains AAO's primary execution abstraction; Agent remains a bounded, subordinate component invoked inside a Workflow, never an autonomous top-level runtime.
- Capability is provider-neutral (`Workflow -> Capability -> Adapter -> Vendor`, never `Workflow -> Vendor SDK`). Tool and Capability are distinct concepts: a Tool is an executable interface that may bind to a Capability via `capabilityRef`, but need not.
- Company configuration (`CompanyConfig`) contains no secrets, credentials, OAuth tokens, or vendor-specific structures — only references and configuration values, protecting the invariant that normal company onboarding must not fork AAO Core.
- External framework and provider types stop at adapter boundaries; they never become part of a canonical contract.
- Graph- and runtime-level semantic validation (reachability, cycles, node/tool/agent/capability existence, policy satisfaction, approval authorization, state-reducer correctness) is deferred to later sprints (the Workflow DSL/compiler, the runtime, the authorization engine). This sprint validates schema shape only.
- Contract evolution is explicit and versioned via `schemaVersion`, never silent drift.

## Consequences

- `packages/contracts` builds and typechecks independently of every app and every other package, and is verified by its own test suite (schema validation, representative-contract serialization round-trips, a compiled-package import smoke, and a dependency/vendor-import boundary check).
- `apps/*` and `packages/config` do not yet depend on `@aao/contracts` — adoption happens only when a real feature requires it, not to prove the package exists.
- `packages/substrate-contracts` and `packages/substrate-spikes` remain Sprint 0A research evidence. Useful semantics observed there were re-expressed canonically inside `@aao/contracts`; the production package does not import either research package, and neither was deleted, rewritten in place, or otherwise altered by this sprint.
- The full contract inventory, its ownership matrix, and the Tool-vs-Capability distinction are recorded in `docs/architecture/domain-contracts.md`, which this ADR treats as the canonical elaboration of these decisions.
- No production runtime behavior, persistence, UI, or deployment infrastructure is introduced by this sprint; `@aao/contracts` is a description of shapes, not an implementation of behavior.
