# Governance

Company configuration supplies actors, roles, active/inactive bindings, and deny policies. AAO Core validates that configuration once and resolves an actor for each governed request:

```text
Host-attested identity → Actor/Principal → active RoleBindings → Role grants
                    → matching Policy DENY rules → ResolvedAuthority
                    → AuthorizationContext → authorize() → Tool Runtime support/handler
```

`Principal` is the canonical actor shape (`id`, `type: user | service | system`). An Agent acts for a principal through the separate registered AgentSpec permission ceiling; it is not a self-attesting principal. Roles have an ID, version, and permission grants. Bindings explicitly connect registered actors to roles. Policies may constrain a permission by actor type or bound role. There is no implicit inheritance, scope tree, expression language, or rule-order priority. Duplicate grants collapse into a set; any matching denial wins; absence of a grant denies by default.

`resolveAuthority` returns `ALLOW` or `DENY` for requested permission classes plus stable reason codes and, for a known actor, sorted effective roles, permissions, and policy references. Its output is JSON-safe and suitable for later trace events. Configuration errors throw at registry creation; a legitimate lack of authority is a `DENY` value. The registry is immutable after creation.

Governance establishes authority. Authorization checks whether a requested registered Tool's requirements fit that authority and any Agent ceiling. The future Approval Engine will decide whether an otherwise authorized action needs human confirmation. Tool Runtime determines whether the class is supported, validates input/output, and invokes a trusted handler. These are distinct decisions. An `external_side_effect` grant does not make that class executable today.

The host must obtain identity outside model output, workflow state, Tool input, MCP metadata, and memory. Those data can inform business work but never create actors, role membership, permissions, policies, decisions, or approval authority. The same governance path applies to local and MCP-backed Tools and is intended for future Framework, Toolbox, Integration Fabric, capability packs, and Control Center surfaces.
