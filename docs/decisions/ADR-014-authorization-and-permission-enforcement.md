# ADR-014: Authorization & Permission Enforcement Boundary

Status: accepted

## Context

Sprint 8 (ADR-013) gave AAO one Tool execution path with a fail-closed permission *support gate*: only `read_only`/`write_draft` Tools execute. That gate says which Tool kinds this runtime version can run; it never said who may run them. Before Agent Tool use, MCP-backed Tools, or any side effect can exist, every Tool execution needs a deterministic, unavoidable answer to "may this already-attested actor perform this action?". Sprint 9 builds that answer and puts it inside `executeTool`.

## Decision

### Authorization is deterministic software; authentication is out of scope

- Authentication (who is this actor?) is not implemented. A trusted host supplies an already-attested **Authorization Context**. AAO has no login, sessions, passwords, JWT verification, OAuth, identity provider, or user database.
- Authorization (may this attested actor do this?) is a pure function in a new package, `@aao/authorization`, depending only on `@aao/contracts` and `zod`. It never imports a Runtime package, AI SDK, MCP, provider SDK, Fastify, or `apps/*` (enforced by a dependency-boundary test). No model is ever asked to authorize.

### Contracts

```text
AuthorizationContext   { schemaVersion: 1, principal: { id, type: user | service | system },
                         grantedPermissionClasses: PermissionClass[] (explicit, may be empty, no duplicates),
                         agent?: { agentRef: { id, version }, permissionCeiling: PermissionClasses } }
AuthorizationRequest   { schemaVersion: 1, action: "tool.execute", resource: { type: "tool", id, version },
                         requiredPermissionClasses: PermissionClasses, context }
AuthorizationDecision  ALLOW { principalId, requiredPermissionClasses, agentCeilingApplied }
                       DENY  { reasonCode, principalId?, requiredPermissionClasses?, agentCeilingApplied? }
reasonCode             INVALID_AUTHORIZATION_REQUEST | INVALID_AUTHORIZATION_CONTEXT
                       | PERMISSION_NOT_GRANTED | AGENT_PERMISSION_CEILING_EXCEEDED
```

All strict and JSON-safe. Canonical `PermissionClass`/`PermissionClasses`, `ToolSpec`, and `AgentSpec` are reused, not duplicated. There is no `admin`, `allowAll`, or bypass field; unknown fields are rejected.

### Canonical `PolicyDecision` is not reused as the decision object

`PolicyDecision` models a future policy engine: it includes `REQUIRE_APPROVAL`, `policyRefs`, and free-form `reasonCodes` strings. Permission-set authorization produces only ALLOW/DENY with a closed reason vocabulary and bounded evidence. Forcing it into `PolicyDecision` would either admit approval semantics that do not exist or weaken the reason codes to free text. The decision instead **reuses the canonical `PolicyDecisionValue` vocabulary**, restricted to `ALLOW | DENY` (`PolicyDecisionValueSchema.extract`), so there is still one meaning for those values. A future policy/approval engine can wrap an `AuthorizationDecision` inside a `PolicyDecision`.

### Rule

```text
required ⊆ principal grants                        else DENY PERMISSION_NOT_GRANTED
required ⊆ agent ceiling   (only if an Agent acts)  else DENY AGENT_PERMISSION_CEILING_EXCEEDED
```

- Tool requirements come from the registered canonical `ToolSpec.permissionClasses`; all must be granted.
- No permission hierarchy: `write_draft` does not imply `read_only`, and nothing implies anything.
- No implicit superuser: principal `type` is descriptive only; `system` with no grants is denied.
- Effective authority with an Agent is `principal grants ∩ agent ceiling`. The ceiling can reduce authority, never extend it; the principal check runs first, so an Agent-granted class the principal lacks is `PERMISSION_NOT_GRANTED`.
- The ceiling must come from a trusted registered `AgentSpec.permissionClasses` (`agentAuthorityFromSpec`), never from model output, `AgentDecision`, task text, workflow state, Tool input, or prompts.
- A malformed request or context is a DENY value, never an exception and never an allow.
- The evaluator is synchronous and pure: no I/O, clock, randomness, logging, hidden state, or cached verdict. `authorize()` is the one decision implementation; there are no per-caller variants.

### Enforcement is inside `executeTool`

Canonical order:

```text
request validation → Tool lookup → permission support gate → authorization → inputSchema → handler → output validation
```

- `executeTool({ request, tools, authorizationContext })`: the context is a required, separate parameter — never part of `ToolExecutionRequest.input` (a `request.authorizationContext` field is rejected by the strict request schema). No default, anonymous, or implicit context.
- Missing context → `TOOL_AUTHORIZATION_REQUIRED`; malformed context → `TOOL_AUTHORIZATION_DENIED` + `authorizationReasonCode: INVALID_AUTHORIZATION_CONTEXT`; denial → `TOOL_AUTHORIZATION_DENIED` + the evaluator's reason code. The handler is never invoked on any of these.
- The support gate stays separate and runs first: an `external_side_effect`, `destructive`, or `sensitive_data` Tool is `TOOL_PERMISSION_UNSUPPORTED` whatever the grants, and the evaluator is not consulted. Authority cannot enable what the runtime has not made safe.
- Authorization precedes input validation so an unauthorized caller learns nothing about a Tool's input contract.
- On success, `ToolExecutionResult` carries the ALLOW decision as bounded `authorization` evidence (principal id, required classes, whether a ceiling applied), outside `ToolResult`, so it never enters workflow state.

### Registry encapsulation

- The public `ToolRegistry` is inspection-only: `register`, `getSpec` (a spec clone), `has`. The registry object is frozen.
- Executable bindings (captured handler, frozen compiled validators, deep-frozen stored spec) live in a module-private `WeakMap` keyed by registry instance and are resolved only by `executeTool`. The internal resolver is not exported, and the package `exports` map exposes only its entry point. A look-alike registry object is rejected. `executeTool` is the only exported path that invokes a registered handler.
- **Registered ≠ supported ≠ authorized**: registered = trusted code exists; supported = this runtime version can execute its permission classes; authorized = this principal may execute it in this context.

### Workflow Tool Node

- `createToolNodeExecutor({ tools, resolveAuthorizationContext })`. The resolver is required at construction and receives only `{ runId, nodeId, toolRef }` (frozen) — never workflow state, Tool input, or other config. It may be sync or async. A thrown/rejected resolver or an `undefined` result → `TOOL_AUTHORIZATION_REQUIRED`, with the thrown value never inspected.
- Preflight stays static (config, registration, support); authorization is decided per execution, never at compile/preflight time.
- Node config stays strict: authority fields (`permissions`, `grants`, `allow`, `authorization`, ...) fail preflight. Grant-shaped values in workflow state have no effect.
- The generic Runtime sees only `NODE_EXECUTION_FAILED` + `executorFailure { namespace: "tool", code: "TOOL_AUTHORIZATION_DENIED" | "TOOL_AUTHORIZATION_REQUIRED" }`. It never learns the authorization reason code; `@aao/runtime` has no authorization concepts.

### Explicitly out of scope

Authentication, users, roles, groups, tenants, RBAC/ABAC stores, policy languages (Rego/OPA/Cedar/custom), approvals and `WAITING_FOR_APPROVAL`, Agent Tool use (`AgentDecision` stays `CONTINUE | COMPLETE`), MCP, external side effects, sensitive-data or destructive execution, persistence of contexts or decisions, authorization caching, and trace infrastructure.

## Consequences

- New package `packages/authorization`; `@aao/tool-runtime` depends on it. `@aao/runtime`, `@aao/model-runtime`, and `@aao/agent-runtime` are unchanged, and the Agent Runtime still cannot import the Tool Runtime.
- Breaking changes inside the Tool Runtime's public API: `executeTool` requires `authorizationContext`; `createToolNodeExecutor` requires `resolveAuthorizationContext`; `ToolRegistry.get` (which returned the handler and validators) is replaced by `getSpec`/`has`; two failure codes are added.
- Future RBAC/ABAC, identity, or tenant systems construct an `AuthorizationContext`; they do not replace the evaluator. Future Agent Tool use and MCP-backed Tools call `executeTool` and inherit the same rule, including the Agent ceiling. Approval for `external_side_effect` will come after authorization, not instead of it.
