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

## Registered ≠ authorized

A Tool being **registered** with the Tool Runtime ([ADR-013](../decisions/ADR-013-tool-registry-and-safe-execution-boundary.md)) means trusted code exists to implement it and its schemas are enforceable. It does **not** mean any actor, Agent, or workflow may invoke it.

Sprint 8 adds only a fail-closed **permission support gate**. Tool Runtime V1 executes a Tool only if every one of its permission classes is `read_only` or `write_draft`. A Tool requiring `external_side_effect`, `destructive`, or `sensitive_data`, alone or mixed with a supported class, is refused (`TOOL_PERMISSION_UNSUPPORTED`, or `RUNTIME_PREFLIGHT_FAILED` for a workflow `tool` node) and its handler is never invoked. This gate says which kinds of Tool this runtime version can safely execute. It is not authorization.

Actual actor, permission, and policy enforcement belongs to Sprint 9 (Authorization & Permission Enforcement Boundary), which inputs the actor, the Agent permissions, the Tool permission requirements, and the policy, and produces a deterministic authorization decision. The intended direction is for `AgentSpec.permissionClasses` to act as one deterministic ceiling on the Tool requests an Agent may make, alongside Tool requirements and governance policy. Agent Tool use and external side effects stay disabled until that boundary exists.
