# Runtime lifecycle

Run and node status are distinct: a run represents the whole workflow execution; a node represents one unit of work inside it. This is a canonical directional contract, not a distributed-runtime implementation.

## Run status

| Status | Meaning |
| --- | --- |
| `CREATED` | A run record exists but validation has not started. |
| `VALIDATING` | The selected workflow and input are being checked before execution. |
| `QUEUED` | Validation passed and the run awaits execution capacity. |
| `RUNNING` | The runtime is actively executing or coordinating nodes. |
| `WAITING_FOR_APPROVAL` | Progress is paused for required human approval. |
| `RETRYING` | A bounded retry is scheduled before execution resumes. |
| `COMPLETED` | Execution and required verification finished successfully. |
| `FAILED` | Validation, execution, policy, approval, verification, or bounded retry handling reached failure. |
| `CANCELLED` | Authorized cancellation ended the run. |

## Legal transitions

```text
CREATED → VALIDATING
VALIDATING → QUEUED | FAILED
QUEUED → RUNNING | CANCELLED
RUNNING → WAITING_FOR_APPROVAL | RETRYING | COMPLETED | FAILED | CANCELLED
WAITING_FOR_APPROVAL → RUNNING | FAILED | CANCELLED
RETRYING → RUNNING | FAILED | CANCELLED
```

Terminal statuses (`COMPLETED`, `FAILED`, and `CANCELLED`) have no normal outgoing transition. Recovery and replay semantics are deliberately deferred until the durability implementation establishes them.

## Intended node lifecycle

| Status | Meaning |
| --- | --- |
| `PENDING` | The node has not yet become eligible. |
| `READY` | Dependencies and routing make the node eligible to start. |
| `RUNNING` | The node is executing. |
| `WAITING` | The node is paused on approval, an allowed external wait, or another defined continuation boundary. |
| `SUCCEEDED` | The node completed and produced its expected result. |
| `FAILED` | The node ended unsuccessfully. |
| `SKIPPED` | Routing or policy intentionally omitted the node. |
| `CANCELLED` | The run or node was cancelled. |

The production node transition contract belongs with the later workflow DSL and runtime implementation.

## Sprint 12 approval boundary

An explicitly registered Approval Node now returns a bounded Runtime wait result. The Run enters `WAITING_FOR_APPROVAL`, the Approval Node enters `WAITING`, and downstream nodes remain pending. The version-2 safe snapshot includes an approval reference and fingerprint. A trusted host may resolve the process-local Approval and invoke validated in-process continuation through the same Runtime loop. Approval only confirms the exact request; Governance, Authorization, Agent ceilings, and Tool Runtime support still apply. See [approval engine](approval-engine.md) and [ADR-017](../decisions/ADR-017-human-approval-and-runtime-waitpoints.md).

## Sprint 13 reliability boundary

Retries do not add lifecycle states. A retrying Node stays `RUNNING` and its Run stays `RUNNING` until one final outcome: `SUCCEEDED`, or `FAILED` (including `NODE_RETRY_EXHAUSTED`). There is no `READY → RUNNING` bounce per attempt. The canonical `RETRYING` Run status is intentionally unused by in-process retries; it is reserved for a future durable, scheduled retry. Approval waits are not failures and are never retried. See [reliability runtime](reliability-runtime.md) and [ADR-018](../decisions/ADR-018-runtime-reliability-and-bounded-retries.md).
