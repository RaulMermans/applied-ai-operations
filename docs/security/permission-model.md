# Permission model

Permissions are deterministic governance inputs. They determine the authority an actor or tool has; model output never creates authority.

| Permission class | Definition | Examples | V1 baseline |
| --- | --- | --- | --- |
| `read_only` | Retrieves information without modifying an external system. | Search CRM, read documents, fetch metrics. | Lowest operational authority. |
| `write_draft` | Creates or changes a local or unpublished artifact. | Draft email, proposed CRM update, prepared report, generated document. | Cannot publish or send externally. |
| `external_side_effect` | Changes an external system or communicates externally. | Send email, update CRM, create calendar event, publish content, submit request. | Human approval required before execution. |
| `destructive` | Deletes, cancels, overwrites, revokes, refunds, disables, or similarly hard-to-reverse changes. | Cancel event, revoke access, issue refund. | Explicit human confirmation; no autonomous execution. |
| `sensitive_data` | Reads or processes private, confidential, personal, or regulated data. | Customer personal data, protected documents. | May coexist with another class; requires controls below. |

## Side-effect authority

A model or agent may propose a side effect. Only deterministic AAO execution infrastructure can authorize and perform it:

```text
proposal → tool request → schema validation → authorization → policy → approval when required
→ idempotency and replay protection → execution → verification → audit
```

Every initial `external_side_effect` requires human approval before execution. Future policy-driven exceptions require separate implementation evidence and an architecture update. A `destructive` action always requires explicit human confirmation in V1.

## Sensitive data

`sensitive_data` is additive, for example `external_side_effect` plus `sensitive_data`. Its handling requires least privilege, data minimization, controlled trace logging, and explicit data-handling policy. Traces are operational evidence, not a reason to indiscriminately duplicate sensitive content.

## Registered ≠ supported ≠ authorized

A Tool being **registered** with the Tool Runtime ([ADR-013](../decisions/ADR-013-tool-registry-and-safe-execution-boundary.md)) means trusted code exists to implement it and its schemas are enforceable. **Supported** means this runtime version can safely execute every one of its permission classes. **Authorized** means a given principal may execute it in a given context. These are three separate checks.

## Enforcement inputs (Sprints 9–11)

`@aao/governance` now resolves host-attested actor identity, explicit role bindings, and deny policies into principal grants. Those grants feed the existing Authorization Context; Agent ceilings and the Tool Runtime support gate continue to constrain execution. Memory, workflow state, model output, Tool input, and MCP metadata cannot grant authority.

| Input | Source | Role |
| --- | --- | --- |
| Principal grants | Host-attested `AuthorizationContext.grantedPermissionClasses` | Explicit set of classes the principal holds. May be empty. No principal type implies any grant. |
| Agent ceiling | Registered `AgentSpec.permissionClasses`, when an Agent acts | Upper bound on what the Agent may use on the principal's behalf. Only reduces authority. |
| Tool requirements | Registered `ToolSpec.permissionClasses` | Every class is required. |
| Runtime support | Tool Runtime V1 support gate | `read_only` and `write_draft` only. |

Canonical rule, enforced by `@aao/authorization` inside `executeTool` ([ADR-014](../decisions/ADR-014-authorization-and-permission-enforcement.md), [authorization](../architecture/authorization.md)):

```text
Tool required permissions ⊆ principal grants
```

and, when an Agent is involved:

```text
Tool required permissions ⊆ principal grants ∩ agent ceiling
```

Permission classes have no hierarchy: `write_draft` does not imply `read_only`. A malformed or missing context fails closed.

Runtime support is checked first and cannot be overridden: a Tool requiring `external_side_effect`, `destructive`, or `sensitive_data`, alone or mixed with a supported class, is refused (`TOOL_PERMISSION_UNSUPPORTED`, or `RUNTIME_PREFLIGHT_FAILED` for a workflow `tool` node) even when the context grants that class. Its handler is never invoked. Approval, side effects, and sensitive-data handling are not implemented; the approval and sensitive-data rules above remain requirements for when they are.

Agent Tool use is still disabled. When it arrives, it will call `executeTool` with the initiating principal's context plus the Agent's registered ceiling, and inherit this rule unchanged.
