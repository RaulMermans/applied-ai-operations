# Authorization

`@aao/authorization` (`packages/authorization`, Sprint 9) is AAO's deterministic Authorization Boundary. It decides whether an already-attested principal, optionally acting through an Agent, may perform a governed action. The Tool Runtime calls it inside every `executeTool`. See [ADR-014](../decisions/ADR-014-authorization-and-permission-enforcement.md).

## Four separate questions

| Question | Owner | Status |
| --- | --- | --- |
| **Identity**: who is this actor? | The trusted host (authentication) | Not implemented in AAO |
| **Runtime support**: can this runtime version safely execute this permission class at all? | Tool Runtime support gate | `read_only`, `write_draft` only |
| **Authorization**: may this attested actor perform this action in this context? | `@aao/authorization` | Implemented (Sprint 9) |
| **Approval**: does a human have to confirm this particular execution? | Future approval engine | Not implemented |

`registered ≠ supported ≠ authorized`. Registering a Tool proves trusted code exists. Support says the runtime can run that kind of Tool. Authorization says this principal may run it now.

## Decision path

```text
Host-attested principal
        ↓
Authorization Context        { principal { id, type }, grantedPermissionClasses, agent? { agentRef, permissionCeiling } }
        ↓
Tool permission requirements ToolSpec.permissionClasses of the registered Tool
        ↓
Agent ceiling if present     from the registered AgentSpec.permissionClasses only
        ↓
Deterministic evaluator      authorize(AuthorizationRequest)
        ↓
ALLOW / DENY + reason code
```

Rule: `required ⊆ grants`, then (with an Agent) `required ⊆ ceiling`, so effective authority is `grants ∩ ceiling`.

| Reason code | Meaning |
| --- | --- |
| `PERMISSION_NOT_GRANTED` | the principal lacks a required class (checked first) |
| `AGENT_PERMISSION_CEILING_EXCEEDED` | the principal has every class, the acting Agent's ceiling does not |
| `INVALID_AUTHORIZATION_CONTEXT` | the context is malformed (unknown fields, bad principal, duplicate grants, bad Agent ref/ceiling, ...) |
| `INVALID_AUTHORIZATION_REQUEST` | the request envelope is malformed |

No hierarchy (`write_draft` does not imply `read_only`), no superuser (`system` gets nothing implicitly), no default allow, no bypass field, no cached verdict. The evaluator is synchronous and pure: no I/O, clock, randomness, logging, or model.

An ALLOW decision carries bounded evidence for later tracing and evals: `principalId`, `requiredPermissionClasses`, `agentCeilingApplied`. It never carries the grants list, Tool input, or free text.

## Tool path

```text
Tool request             INVALID_TOOL_REQUEST
      ↓
Tool lookup              TOOL_NOT_FOUND
      ↓
Runtime support gate     TOOL_PERMISSION_UNSUPPORTED   (evaluator never called)
      ↓
Authorization            TOOL_AUTHORIZATION_REQUIRED   (no context)
      ↓                  TOOL_AUTHORIZATION_DENIED     + authorizationReasonCode
Input validation         TOOL_INPUT_SCHEMA_MISMATCH
      ↓
Handler                  at most once
      ↓
Output validation
```

Authorization comes before input validation, so an unauthorized caller never sees input-schema details. The support gate comes before authorization, so a grant for `external_side_effect`, `destructive`, or `sensitive_data` enables nothing.

## Where the context comes from

- **Direct callers**: `executeTool({ request, tools, authorizationContext })`. The context is a required, separate parameter.
- **Workflows**: `createToolNodeExecutor({ tools, resolveAuthorizationContext })`. The host resolver gets only `{ runId, nodeId, toolRef }` and returns the context it has already attested.

Authority never comes from Tool input, workflow state, node config, handler output, model output, or `AgentDecision`. Nothing persists a context or a decision; each execution is evaluated afresh.

## Failure causality

```text
authorize()             DENY, reasonCode PERMISSION_NOT_GRANTED
      ↓
executeTool()           TOOL_AUTHORIZATION_DENIED, authorizationReasonCode PERMISSION_NOT_GRANTED
      ↓
Workflow Runtime        NODE_EXECUTION_FAILED, executorFailure { namespace: "tool", code: "TOOL_AUTHORIZATION_DENIED" }
```

The generic Runtime never sees the reason code. Resolver exceptions are never inspected or surfaced.

## Not implemented

Authentication, users and roles, groups and tenants, policy languages, approvals, Agent Tool use, MCP protocol ownership (the separate connector inherits this evaluator), external-side-effect/sensitive-data/destructive Tools, credentials, durable authorization state, and authorization caching. Future RBAC/ABAC systems construct an `AuthorizationContext`; they do not replace the evaluator.
