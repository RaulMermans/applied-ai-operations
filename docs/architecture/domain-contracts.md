# Domain contracts

`@aao/contracts` (`packages/contracts`) is the canonical, framework-neutral, vendor-neutral production contract package for Applied AI Operations. It is the dependency direction for later production systems:

```text
AAO runtime, integrations, governance, evals, packs, deployments
                              ↓
                       @aao/contracts
                              ↓
                              ✕
              external frameworks / vendors / providers
```

Every canonical schema is a [Zod](https://zod.dev) schema; every canonical TypeScript type is inferred from its schema (`z.infer<typeof XSchema>`) rather than maintained separately. Every top-level canonical object uses `.strict()` so unexpected fields are rejected rather than silently dropped. See [ADR-007](../decisions/ADR-007-canonical-domain-contracts.md) for the accepted decision this document elaborates.

## Versioning

Two version concepts are kept distinct:

- **`schemaVersion`** — the *structure* of an AAO contract. Every top-level persisted/configurable contract pins its current schema version with `schemaVersionSchema(1)` (currently `1` everywhere). There is no migration engine; a schema version bump is a deliberate, explicit change.
- **`version`** (`entityVersionSchema`) — the version of a *particular* workflow, agent, skill, tool, capability, model policy, or eval definition, independent of the schema that describes it.

Identifiers (`identifierSchema` and its aliases in `common.ts`, e.g. `WorkflowId`, `ToolId`, `CapabilityId`) are stable, human-readable strings such as `sales.lead-qualification` or `crm.accounts.search` — not UUIDs. They are plain (non-branded) TypeScript string aliases: branding was deliberately avoided because it would add friction to fixtures, tests, and serialization without changing runtime behavior.

## JSON safety

`JsonPrimitive` / `JsonValue` / `JsonArray` / `JsonObject` (`common.ts`) are the only escape hatch for content that cannot yet be meaningfully typed (node `config`, tool/capability `inputSchema`/`outputSchema`, trace `payload`, artifact `locationRef`, model-policy `constraints`, edge `condition`). Canonical contracts never use `any`, and never contain functions, class instances, `Date` instances, or framework/SDK objects. Persisted timestamps are always ISO-8601 strings (`isoTimestampSchema`), never `Date`.

## Contract ownership matrix

| Contract | Architectural owner |
| --- | --- |
| Workflow | AAO Core |
| Node | AAO Core |
| Edge | AAO Core |
| Run | AAO Core |
| Node lifecycle (`NodeStatus`) | AAO Core |
| State / State Snapshot | AAO Core |
| Checkpoint | AAO Core |
| Agent | AAO Core |
| Skill | AAO Core |
| Model Policy | AAO Core |
| Tool | AAO Core execution boundary |
| Capability | Integration Fabric boundary |
| Permission | Governance / Core |
| Policy Decision | Governance / Core |
| Approval | Governance / Core |
| Eval Definition / Result | Core reliability |
| Trace Event | Core observability |
| Artifact | Shared execution |
| Capability Pack (reference boundary) | Pack layer |
| Company Config | Deployment layer |

## Workflow / execution contracts

- **Workflow** (`workflow.ts`) — the normalized domain model a future DSL/compiler can produce: `schemaVersion`, `id`, `version`, `name`, `description?`, `entryNodeId`, `nodes`, `edges`, `requiredCapabilities?`. This is not the Workflow DSL and performs no graph-level semantic validation.
- **Node** (`NodeDefinition`, in `workflow.ts`) — `id`, `kind`, `name?`, `config`. `kind` is one of the seven stable built-ins (`deterministic`, `model`, `agent`, `tool`, `approval`, `evaluator`, `final_output`); `config` is a deliberately opaque `JsonObject` because node-specific validation belongs to a future Node Registry, not a monolithic union on the core schema.
- **Edge** (`EdgeDefinition`, in `workflow.ts`) — `sourceNodeId`, `targetNodeId`, an optional opaque `condition` reserved for future conditional routing.
- **Run** (`RunRecord`, in `run.ts`) — run identity and lifecycle only (`schemaVersion`, `runId`, `workflowId`, `workflowVersion`, `status`, `createdAt`, `updatedAt`, `currentNodeId?`), no database-specific fields.
- **Node lifecycle** (`NodeStatus`, in `run.ts`) — kept in the same module as `RunStatus` because both are lifecycle concerns, but the two enums are distinct and never conflated.
- **State / State Snapshot / Checkpoint** (`state.ts`) — `RunState` is authoritative active run data (not model context, not logs, not long-term memory); `StateSnapshot` is an immutable point-in-execution capture; `CheckpointRecord` is a contract for recovery state, explicitly making no exactly-once, transactional, or crash-safe persistence claim.

**Deferred to the Workflow DSL/compiler sprint:** expression parsing, condition evaluation, graph validation (cycles, reachability, entry/exit consistency), node transition logic, state reducers, and state/checkpoint persistence. None of it is implemented or implied by these schemas.

## AI contracts

- **Agent** (`agent.ts`) — a governed reasoning component invoked inside a Workflow, never an autonomous top-level runtime: `schemaVersion`, `id`, `version`, `name`, `description?`, `modelPolicyRef?`, `skillRefs`, `toolRefs`, `permissionClasses`.
- **Skill** (`skill.ts`) — a reusable operational/reasoning capability a workflow or bounded agent can invoke: `schemaVersion`, `id`, `version`, `name`, `description?`, `requiredCapabilities`, `requiredTools`, `permissionClasses`.
- **Model Policy** (`model.ts`) — a provider-neutral requirements/policy boundary: `schemaVersion`, `id`, `version`, `name`, `requiredCapabilities?`, `constraints?` (opaque `JsonObject`).

None of these three files imports `ai`, an OpenAI/Anthropic/Gemini SDK, or LangChain/LangGraph types — `modelPolicyRef`, `skillRefs`, and `toolRefs` are plain identifier strings. No agent loop, prompt, model call, memory, handoff, multi-agent architecture, or model routing is implemented.

## Tool / integration contracts

- **Tool** (`tool.ts`) — an executable interface AAO may authorize and invoke: `schemaVersion`, `id`, `version`, `name`, `description?`, `inputSchema`, `outputSchema`, `permissionClasses`, `capabilityRef?`.
- **Capability** (`capability.ts`) — a provider-neutral ability from the Integration Fabric (e.g. `crm.accounts.search`): `schemaVersion`, `id`, `version`, `name`, `description?`, `inputSchema`, `outputSchema`, `permissionClasses`.

**Tool vs Capability:** a Capability is the provider-neutral *ability* AAO needs (`Workflow -> Capability -> Adapter -> Vendor`, never `Workflow -> Vendor SDK`); a Tool is the *executable interface* exposed to AAO execution, which may bind to a capability via `capabilityRef` — but need not (`local.math.calculate` may be a Tool with no company-system Capability at all). `inputSchema`/`outputSchema` on both are represented as JSON-safe `JsonObject` values shaped like JSON Schema, not as a dedicated JSON Schema Zod type or a Zod schema instance — this keeps them serializable across process/network boundaries. No Tool Registry, tool invocation, adapters, connectors, or vendor-specific contracts (HubSpot, Salesforce, etc.) exist in this sprint.

## Governance contracts

- **Permission classes** (`governance.ts`) — the five frozen classes from `docs/security/permission-model.md`: `read_only`, `write_draft`, `external_side_effect`, `destructive`, `sensitive_data`. `PermissionClassesSchema` is always a deduplicated collection (never a single value) because `sensitive_data` may coexist with any other class.
- **Policy Decision** (`governance.ts`) — the stable output shape of a future policy engine: `decision` (`ALLOW` / `DENY` / `REQUIRE_APPROVAL`), `policyRefs?`, `reasonCodes?`. No policy authoring language or evaluation is implemented.
- **Approval** (`approval.ts`) — `ApprovalStatus` (`pending`, `approved`, `rejected`, `expired`, `cancelled`) and `ApprovalRecord` (`schemaVersion`, `approvalId`, `runId`, `nodeId?`, `status`, `requestedAt`, `resolvedAt?`, `resolvedBy?`, `permissionClasses`). `schemaVersion` was added by judgment for consistency with Run/Checkpoint even though the sprint's approval field list did not spell it out. No raw secret or unnecessary sensitive tool argument belongs in this contract; none is modeled. No approval persistence, UI, notification, waitpoint execution, or expiry scheduler exists.

The `external_side_effect` → human-approval-before-execution rule and the `destructive` → explicit-confirmation, no-autonomous-execution rule from `docs/security/permission-model.md` are preserved as documentation, not re-implemented as enforcement logic — enforcement is a future governance/authorization engine.

## Evaluation / observability contracts

- **EvalDefinition** (`evaluation.ts`) — `schemaVersion`, `id`, `version`, `name`, `description?`, `mode` (`OFFLINE` / `RUNTIME`), `targetType?` (`run`, `node`, `tool_use`, `artifact`, `trajectory`, `authorization`). GPA/trajectory evaluation is not hardcoded; it is expected to become one evaluator family under `trajectory`.
- **EvalResult** (`evaluation.ts`) — `evalId`, `runId?`, `status` (`passed` / `failed` / `error`), `score?`, `reason?`, `evidenceRefs?`. A passing or failing result may exist with no `score` at all — not every evaluator produces one. When present, `score` is normalized to `[0, 1]`, where `1` fully meets an evaluator's criteria and `0` does not meet them at all; individual evaluators define the criteria themselves. No evaluator implementation, evaluation runtime, or CI regression gate exists yet.
- **TraceEvent** (`trace.ts`) — `schemaVersion`, `eventId`, `runId`, `sequence`, `occurredAt`, `type` (dot-namespaced, e.g. `run.status_changed`), `nodeId?`, `payload` (opaque `JsonObject`). No Trace Store, OpenTelemetry export, or metrics pipeline exists yet.
- **ArtifactRef** (`artifact.ts`) — `schemaVersion`, `artifactId`, `runId?`, `nodeId?`, `kind` (an open identifier, not a frozen enum — artifact kinds are expected to grow with capability packs), `name?`, `createdAt`, `locationRef` (opaque `JsonObject`, e.g. `{"type":"local-file","path":"..."}`). No binary content is ever stored in this contract, and no storage technology is selected.

## Template contracts

- **Capability Pack boundary** (`capability-pack.ts`) — only `CapabilityPackRef` (`capabilityPackId`, `version?`) is implemented. A full `CapabilityPackManifest` (grouping workflows, skills, required capabilities, policies, eval suites, and approval rules) is deliberately deferred: building it now would require speculative runtime semantics — how packs are loaded, merged, and versioned against a deployment — that no later sprint has evidenced yet.
- **CompanyConfig** (`deployment.ts`) — `schemaVersion`, `companyId`, `displayName`, `workflowRefs`, `policyRefs`, `capabilityPackRefs`, `capabilityBindingRefs`, `fieldMappingRefs`. It carries no OAuth tokens, credentials, secrets, or real vendor structures. `capabilityBindingRefs` and `fieldMappingRefs` are opaque identifier references into concepts that are not modeled yet.

Together, `CompanyConfig` and `CapabilityPackRef` protect the portability invariant in `docs/architecture/core-vs-company.md`: **normal company onboarding must not fork AAO Core.** A company's reality is expressed entirely as references and configuration values conforming to these contracts, never as a change to a Core schema.

## Non-goals carried over from the sprint

This package intentionally does not implement: a Workflow DSL parser, YAML authoring, a graph compiler/validator (cycles, reachability, unreachable nodes, termination), a runtime executor, a Node Registry, state reducers, state/checkpoint persistence, an agent/skill/model runtime, a Tool Registry or tool execution, capability adapters/connectors, MCP production integration, OAuth/credentials, an authorization engine, eval execution, trace storage, a capability-pack runtime, company deployment folders, or any UI. See ADR-007 and the sprint's own non-goals list for the complete inventory.
