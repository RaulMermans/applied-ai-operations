# Advanced Run Inspection Architecture

The **Advanced Run Inspector** (`@aao/operator-inspection`) provides node-oriented execution correlation across authoritative AAO lifecycle records and chronological trace streams. See ADR-033.

## Architectural Purpose

When investigating a workflow execution, operators need to understand:
1. Which workflow plan nodes were planned vs. actually executed?
2. What happened during each node attempt (model invocations, tool calls, approvals)?
3. Were there retries, rate-limits, or recovery replays?
4. What was the exact token expenditure (prompt, completion, total), or was token recording omitted?
5. Did the execution complete, fail, pause for approval, or terminate abnormally?

The inspector answers these questions deterministically by projecting `KnownRunEvidence` without executing new actions or mutating state.

## Correlation Model

The Advanced Run Inspector correlates three distinct layers of evidence:

```text
  Compiled Workflow Plan
  (WorkflowDefinition)
          |
          |  [1. Planned Topology]
          v
  +-------------------------------------------------------------+
  |              Node Execution Map (Ordered Nodes)              |
  |  - Node ID & Kind (deterministic, model, tool, approval)    |
  |  - Planned vs Executed                                      |
  |  - Status (OBSERVED_COMPLETED, OBSERVED_FAILED, ...)        |
  |  - Duration, Attempts Count, Token Usage                    |
  |  - Linked Tool / Model Policy / Approval Status             |
  +-------------------------------------------------------------+
          ^                                     ^
          | [2. Chronological Events]           | [3. Authoritative Status]
          |                                     |
    Trace Events                           RunRecord
    (TraceEvent[])                      (Runtime / Durability)
```

### Node Execution Status Vocabulary

Every node in the compiled workflow plan (and any unplanned node observed in trace) is assigned an explicit status:

| Status | Meaning |
|---|---|
| `OBSERVED_COMPLETED` | Node execution started and completed successfully with a terminal `node.completed` event. |
| `OBSERVED_FAILED` | Node execution failed with a `node.failed` or fatal error event. |
| `OBSERVED_STARTED` | Node execution started but has not yet finished (active or interrupted). |
| `NOT_OBSERVED` | Planned node was never entered during this execution. |
| `EVIDENCE_INCOMPLETE` | Run reached terminal status, but node lacks a recorded completion or failure event. |

## Multi-Attempt Retries & Recovery Replay

### Multi-Attempt Tool Retries

When tools encounter retryable failures (e.g. `PROVIDER_TIMEOUT`, rate limits), multiple attempts are captured under the node span:
- Attempt 1: Marked as `failed` with specific `reasonCode`.
- Attempt 2: Marked as `completed` with successful outcome.
- The node summarizes `totalAttempts: 2` and flags `RETRIES_OBSERVED` in diagnostics.

### Recovery Replay Correlation

When durable execution resumes from a checkpoint:
- Resumed steps are traced with `recoveryReplay: true`.
- The Run Inspector flags attempts as `(recovery/replay)` in both timeline and attempt summaries.
- Prevents replayed actions from being misinterpreted as duplicate live execution attempts.

## Token Usage Accounting Rules

Token usage is strictly governed:
1. **Faithful Aggregation**: When trace events provide `tokenUsage` (`inputTokens`, `outputTokens`, `totalTokens`), amounts are summed per node, per attempt, and for the overall run.
2. **Explicit Absence**: If the underlying environment omitted token tracking (e.g. deterministic nodes or mock model adapters), `tokenUsage.recorded` is reported as `false`.
3. **No Zero Substitution**: The inspector NEVER substitutes zero (`0`) for missing token evidence. Surfaces render `"NOT RECORDED"` (CLI) and `<span class="badge">Not recorded</span>` (UI).

## Deterministic Run Diagnostics

Known failure codes and anomalies generate structured `RunDiagnostic` items:

| Code | Severity | Description |
|---|---|---|
| `AUTHORITATIVE_STATE_UNAVAILABLE` | Warning | Run status is unknown because durable runtime record is absent. |
| `TRACE_CORRUPT` | Error | Trace sequence gap, identity mismatch, or causality check failed. |
| `TRACE_UNAVAILABLE` | Warning | No trace stream was captured for this run. |
| `RUN_FAILED` | Error | Authoritative run terminated in failure. |
| `RUN_WAITING_FOR_APPROVAL` | Info | Execution paused pending eligible human approval decision. |
| `RETRIES_OBSERVED` | Info | Transient failures caused execution retries. |
| `RECOVERY_REPLAY_OBSERVED` | Info | One or more steps were executed as durable recovery replays. |
| `UNPLANNED_NODES_EXECUTED` | Warning | Nodes executed that were not present in the compiled workflow plan. |

## Surface Alignment

- **CLI**: `aao inspect run <runId> --view nodes` (Node map) and `aao inspect run <runId> --view timeline` (Attempts timeline).
- **HTTP**: `GET /api/v1/inspection/runs/:runId/analysis`.
- **UI**: `/control-center/runs/:runId` with execution summary cards, node execution map, interactive node selection (`?nodeId=...`), attempts timeline, and run diagnostics table.
