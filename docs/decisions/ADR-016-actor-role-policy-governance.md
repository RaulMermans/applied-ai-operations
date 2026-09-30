# ADR-016: Actor, Role & Policy Governance

Status: accepted

## Decision

`@aao/governance` is a deterministic policy decision point over trusted, local configuration. The host authenticates and attests a canonical principal; models, agents, workflow state, Tool arguments, MCP metadata, and memory cannot establish identity or authority. No principal type grants implicit privileges. Roles contain canonical permission classes, active bindings attach roles to registered actors, and policies contain inspectable `DENY` rules. A role grant is required; matching explicit denies remove it; everything else is denied by default. Policy and role ordering cannot change the result.

Configuration is parsed and cross references validated before execution. Duplicate entity IDs, unknown actor/role references, malformed permissions and empty policies fail configuration compilation. The registry captures and freezes parsed input. Resolution is pure and emits sorted, JSON-safe role IDs, effective permission classes, policy references, requested classes, and a bounded reason code. No global registry, clock, I/O, model call, or executable policy is involved.

Governance produces `ResolvedAuthority`; `@aao/authorization` converts it to the existing `AuthorizationContext` and retains the single `authorize()` evaluator. The registered AgentSpec ceiling still restricts that context. `@aao/tool-runtime` retains its permission support gate and one handler path; a governance grant for an unsupported class cannot enable execution. MCP-backed handlers use that same path; remote discovery never supplies role, policy, or principal data.

## Boundary and deferred work

The host must pass the attested actor in the separate resolver argument, never read it from untrusted payload. The current direct AuthorizationContext API remains a trusted-host API for existing callers. Approval is a separate future decision after authorization. This ADR adds no Approval Engine, IAM/SSO, database, generic ABAC expression language, persistence, tracing, or UI.
