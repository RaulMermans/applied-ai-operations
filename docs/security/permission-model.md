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
