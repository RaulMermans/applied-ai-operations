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
