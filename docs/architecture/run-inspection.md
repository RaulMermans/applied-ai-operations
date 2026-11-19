# Advanced Run Inspection Architecture

The **Advanced Run Inspector** (`@aao/operator-inspection`, `projectAdvancedRunInspection`) projects one Run's canonical evidence into a bounded, read-only inspection DTO shared by the CLI, the HTTP API and the Control Center. See ADR-033 (including its Sprint 28C amendment).

It answers, from evidence only: which planned nodes executed, how many times and at which steps, how many attempts each execution took and why, which Tool and model invocations each attempt made, how much token usage was recorded and how complete that accounting is, and whether the evidence itself is missing, partial or corrupt. It never executes, retries, approves or writes anything.

## Pipeline

```text
Canonical Trace (TraceStore / KnownRunEvidence.traceEvents)
      |
      v
Trace Validation            validateTrace (strict; never relaxed for inspection)
      |                       invalid -> health "corrupt": no attempts, counters or tokens
      v
Execution Identity          deriveRunMetrics (Observability, ADR-021): one attempt record
Correlation                   per node.started, keyed by node + step + attempt + span
      |
      v
Node / Tool / Model         evidence attached to attempts by canonical span
Attempts                      (event.parentSpanId, else event.spanId)
      |
      v
Evidence Completeness       token completeness, open attempts, unattributed events,
      |                       missing authoritative state, missing approval records
      v
Safe Inspection DTO         AdvancedRunInspectionSchema (strict, bounded, redaction-checked)
```

The projection receives canonical `TraceEvent`s. It is never given, and never reconstructs, Trace or Runtime records from the redacted `RunInspection` summary. A source that cannot supply canonical evidence makes `getAdvancedRunInspection` fail with `INSPECTION_SOURCE_UNAVAILABLE` (after confirming the Run exists, so an unknown Run is still `INSPECTION_NOT_FOUND`).

## Execution identity

```text
Run ID
  +-- Node ID
  +-- Execution Step       a repeated node at another step is a separate execution
  +-- Attempt Number       a retry is a new attempt at the same step
  +-- Canonical Span       derived by the recorder from (node, step, attempt)
```

Algorithm (`projectAdvancedRunInspection`):

1. Validate the Trace. If invalid or absent, stop: `attempts = []`, `counters` and run-level `tokenUsage` are omitted, and `TRACE_CORRUPT` / `TRACE_UNAVAILABLE` is reported.
2. Call `deriveRunMetrics({ trace })`. Its `nodes.attemptDetails` holds exactly one record per `node.started`, in Trace order, with step, attempt, `recoveryReplay`, outcome and duration. Pair the *i*-th record with the *i*-th `node.started` event to obtain its span. A count mismatch is treated as corruption.
3. Walk the Trace once, keeping `owner: spanId -> attempt`:
   - `node.started` opens an attempt and claims its span. A recovery replay re-opens the same logical span, so later evidence belongs to the replay.
   - Attempt-scoped events (`node.completed|failed|waiting`, `retry.*`, `tool.call.*`, `model.call.*`, `agent.*`, `approval.requested`) attach to `owner[parentSpanId] ?? owner[spanId]`. An attached event also claims its own span, so grandchildren resolve too.
   - An attempt-scoped event with no owner is **unattributed evidence**. It is listed in `unattributedEvents` and never counted against a node.
   - Run-scoped events (run, state, checkpoint, recovery bookkeeping, `approval.resolved`) are not attempt evidence.
4. Per attempt: outcome and timing come from the metrics record; Tool/model refs, failure reason code and approval id come from attached events. `toolPhysicalInvocations` counts attached `tool.call.started` events, `modelInvocations` counts attached `model.call.started` events, and `tokenUsage` summarizes the attached model events.
5. Per node: all attempts for that node ID; status is derived from the last attempt.

### Attempt outcomes

| Outcome | Evidence |
|---|---|
| `completed` | `node.completed` on the attempt span (including approval continuation) |
| `failed` | `node.failed` on the attempt span |
| `retried` | `retry.scheduled` on the attempt span |
| `waiting` | `node.waiting` without a later terminal event |
| `open` | `node.started` only (in progress, interrupted, or superseded by a recovery replay) |

### Node status vocabulary

| Status | Meaning |
|---|---|
| `OBSERVED_COMPLETED` | Last observed attempt completed. |
| `OBSERVED_FAILED` | Last observed attempt failed. |
| `OBSERVED_STARTED` | Last attempt is open, waiting or retried, and the Run is not terminal. |
| `EVIDENCE_INCOMPLETE` | As above, but the Run is terminal: the closing evidence is missing. |
| `NOT_OBSERVED` | Planned node with no `node.started`. |

## Counter definitions

`counters` is present only for a valid Trace. Every value except `traceEvents` comes from `deriveRunMetrics`.

| Counter | Definition |
|---|---|
| `traceEvents` | Number of canonical Trace events (lifecycle events, **not** attempts). |
| `nodeExecutionOccurrences` | Distinct `(nodeId, step)` pairs with a `node.started`. |
| `nodeAttempts` | `node.started` events with `recoveryReplay: false`. |
| `recoveryReplayAttempts` | `node.started` events with `recoveryReplay: true`. |
| `scheduledRetries` | `retry.scheduled` events. |
| `exhaustedRetries` | `retry.exhausted` events. |
| `toolPhysicalInvocations` | `tool.call.started` events (one handler invocation each; a blocked call is not one). |
| `toolLogicalExecutions` | Distinct `toolExecutionId`s among `tool.call.started`. |
| `toolBlocked` | `tool.call.blocked` events. |
| `modelInvocations` | `model.call.started` events: one per canonical `(invocationId, attempt)`. |

Per node: `executionCount` (distinct steps), `attemptCount` (non-replay attempts), `recoveryReplayCount`, `scheduledRetries`.

Examples taken from the canonical fixtures:

- `run.northstar.cr.001` `search`: four lifecycle events, giving 1 attempt and 1 physical invocation.
- `run.northstar.cr.retry`: 1 execution occurrence, 2 node attempts, 1 scheduled retry, 2 physical invocations.
- `run.northstar.cr.repeat` `plan`: 2 execution occurrences at steps 1 and 3, with 0 retries.
- `run.northstar.ops.recovery`: 0 node attempts and 1 recovery replay attempt.

## Token accounting

`summarizeTokenUsage` operates on model invocations, never on lifecycle events. Usage is read only from an invocation's single `model.call.completed`. A valid Trace cannot contain a duplicate, because duplicates fail validation, so usage cannot be double counted.

| Status | Rule |
|---|---|
| `complete` | Every invocation completed and reported input, output and total tokens. Also `complete` when there were zero invocations, shown as "0 model invocations". |
| `partial` | Some usage was reported, but at least one invocation failed, never finished, or omitted a field. |
| `unavailable` | Invocations occurred and none reported usage. |

- `inputTokens` / `outputTokens` / `totalTokens` are present only when that field is known for every invocation. An unknown total is omitted; it is never derived from input + output and never shown as `0`.
- `knownInputTokens` / `knownOutputTokens` / `knownTotalTokens` are the sums of what was recorded. For `partial` accounting they are labelled **known recorded totals**.
- Completeness follows Observability's `MetricCompleteness` and is tested to equal `deriveRunMetrics().tokenUsage` on every canonical fixture. Inspection additionally treats a started-but-unfinished invocation as unknown usage.
- Attempt, node and run levels use the same function. Node known totals plus unattributed usage equal the run's known totals.

## When evidence is missing, partial or corrupt

| Situation | Result |
|---|---|
| Invalid Trace (gap, duplicate, orphan Tool event, missing attempt field, bad span relationship) | `evidenceHealth: corrupt`, `TRACE_CORRUPT`; no attempts, counters or tokens |
| No Trace | `TRACE_UNAVAILABLE`; no attempts, counters or tokens |
| No authoritative Run record | `UNKNOWN`, `AUTHORITATIVE_STATE_UNAVAILABLE` |
| Terminal Run without a terminal Trace event | `TRACE_INCOMPLETE` |
| Retry scheduled, next attempt never started | attempt `retried`, `RETRY_NOT_STARTED` |
| Attempt-scoped event without an attributable span | listed in `unattributedEvents`, `UNATTRIBUTED_EVIDENCE` |
| Approval referenced but no ApprovalRecord | no approval status, `APPROVAL_RECORD_MISSING` |
| Partial / absent model usage | `TOKEN_USAGE_PARTIAL` / `TOKEN_USAGE_NOT_RECORDED` |
| Source cannot supply canonical evidence | `INSPECTION_SOURCE_UNAVAILABLE` (basic summary inspection still works) |

## Run diagnostics

| Code | Severity | Trigger |
|---|---|---|
| `AUTHORITATIVE_STATE_UNAVAILABLE` | warning | No authoritative RunRecord |
| `TRACE_CORRUPT` | error | Trace failed validation |
| `TRACE_UNAVAILABLE` | warning | No Trace |
| `TRACE_INCOMPLETE` | warning | Terminal Run, no terminal Trace event |
| `RETRIES_OBSERVED` | info | Node has `retry.scheduled` evidence |
| `NODE_REPEATED` | info | Node executed at more than one step |
| `RETRY_NOT_STARTED` | warning | Scheduled attempt never observed |
| `UNATTRIBUTED_EVIDENCE` | warning | Unattributed attempt-scoped events |
| `TOKEN_USAGE_PARTIAL` / `TOKEN_USAGE_NOT_RECORDED` | info | Token completeness `partial` / `unavailable` |
| `APPROVAL_RECORD_MISSING` | warning | Trace approval id without ApprovalRecord |
| failure codes (`describeRunFailure`) | error | Node's last attempt failed |

## Surface alignment

All three surfaces render the same `AdvancedRunInspection` DTO. Counter rows and token wording come from the shared `executionCounterRows` and `formatTokenUsageText` helpers, so the frontend does no reconstruction of its own.

- **CLI**: `aao inspect run <runId> --view nodes` shows counters and the node map. `--view timeline` shows counters and one line per node attempt.
- **HTTP**: `GET /api/v1/inspection/runs/:runId/analysis`.
- **UI**: `/control-center/runs/:runId[?nodeId=…]` shows counter cards, the node map, node detail and node attempts. When advanced inspection is unavailable it says so with the error code instead of showing figures.

The Sprint 28 compiled smoke asserts that the CLI, HTTP and UI counters, attempts, token accounting and requirement statuses are identical over one shared source.
