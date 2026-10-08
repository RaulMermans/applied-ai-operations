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

Terminal statuses (`COMPLETED`, `FAILED`, and `CANCELLED`) have no outgoing transition; durable recovery (Sprint 14) never resurrects a terminal Run.

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

## Sprint 14 durability boundary

Durable recovery adds no lifecycle states. A resumed Run continues from the status in its latest durable checkpoint. A Run is never re-created, and terminal Runs never execute again. Safe-boundary cancellation uses the canonical `CANCELLED`: the Run goes `RUNNING → CANCELLED` or `WAITING_FOR_APPROVAL → CANCELLED`. The Node that would have started goes `READY → CANCELLED`, the one Node transition added, or a waiting Approval Node goes `WAITING → CANCELLED`. `RETRYING` stays unused. See [durable execution](durable-execution.md) and [ADR-019](../decisions/ADR-019-durable-execution-checkpoints-and-replay.md).
