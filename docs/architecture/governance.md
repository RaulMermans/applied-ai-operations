# Governance

Company configuration supplies actors, roles, active/inactive bindings, and deny policies. AAO Core validates that configuration once and resolves an actor for each governed request:

```text
Host-attested identity → Actor/Principal → active RoleBindings → Role grants
                    → matching Policy DENY rules → ResolvedAuthority
                    → AuthorizationContext → authorize() → Tool Runtime support/handler
```

`Principal` is the canonical actor shape (`id`, `type: user | service | system`). An Agent acts for a principal through the separate registered AgentSpec permission ceiling; it is not a self-attesting principal. Roles have an ID, version, and permission grants. Bindings explicitly connect registered actors to roles. Policies may constrain a permission by actor type or bound role. There is no implicit inheritance, scope tree, expression language, or rule-order priority. Duplicate grants collapse into a set; any matching denial wins; absence of a grant denies by default.

`resolveAuthority` returns `ALLOW` or `DENY` for requested permission classes plus stable reason codes and, for a known actor, sorted effective roles, permissions, and policy references. Its output is JSON-safe and suitable for later trace events. `resolveRoleMembership` returns only a registered actor and its active role IDs, with no permission evaluation; Approval uses it for approver eligibility. Configuration errors throw at registry creation; a legitimate lack of authority is a `DENY` value. The registry is immutable after creation.

Governance establishes authority. Authorization checks whether a requested registered Tool's requirements fit that authority and any Agent ceiling. The future Approval Engine will decide whether an otherwise authorized action needs human confirmation. Tool Runtime determines whether the class is supported, validates input/output, and invokes a trusted handler. These are distinct decisions. An `external_side_effect` grant does not make that class executable today.

Governance never reads Audit or Metrics (Sprint 16). Audit records Governance-dependent outcomes — Approval resolutions and Tool access decisions — as one-way evidence; a forged Audit event cannot create actors, role membership, or permissions. See [audit](audit.md).

The host must obtain identity outside model output, workflow state, Tool input, MCP metadata, and memory. Those data can inform business work but never create actors, role membership, permissions, policies, decisions, or approval authority. The same governance path applies to local and MCP-backed Tools and is intended for future Framework, Toolbox, Integration Fabric, capability packs, and Control Center surfaces.

## Sprint 12 approval boundary

An explicitly registered Approval Node now returns a bounded Runtime wait result. The Run enters `WAITING_FOR_APPROVAL`, the Approval Node enters `WAITING`, and downstream nodes remain pending. The version-2 safe snapshot includes an approval reference and fingerprint. A trusted host may resolve the process-local Approval and invoke validated in-process continuation through the same Runtime loop. Approval only confirms the exact request; Governance, Authorization, Agent ceilings, and Tool Runtime support still apply. See [approval engine](approval-engine.md) and [ADR-017](../decisions/ADR-017-human-approval-and-runtime-waitpoints.md).
