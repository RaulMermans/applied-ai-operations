# Trace Runtime

Sprint 15, [ADR-020](../decisions/ADR-020-trace-runtime-and-observability-boundary.md). `@aao/observability` records structured, privacy-minimized execution evidence for every Run. Trace answers *what happened, in what order, and why*. It never decides what AAO may do.

## Source-of-truth hierarchy

```text
Runtime / Governance / Approval / Durability      ← execution truth
                    │  emit (one direction)
                    ▼
                  Trace                          ← observational projection
                    │
                    ▼
   debugging · trace assertions · future Metrics/Audit · Evals · Run Inspector
```

Never the inverse. No Runtime, Governance, Authorization, Approval, Tool, or Durability decision reads Trace data.

- The trace port is emit-only.
- Recovery planning reads only the checkpoint chain and the operation ledger.
- A static boundary test enforces both rules.

| Concern | Durability ledger | Trace |
| --- | --- | --- |
| Purpose | execution correctness: what is safe to execute or replay | evidence: what happened, in order |
| May drive recovery | yes | never |
| Store | `DurabilityStore` | `TraceStore` (separate port) |
| Failure | stops execution at the last durable boundary | degrades trace health; execution unchanged |

`NodeExecutionRecord[]` remains Runtime-owned execution history. Trace can be validated against it (`compareTraceWithExecution`), but it does not replace it.

## Components

```text
Runtime ─┐
Node executors (via NodeExecutionContext.trace) ─┤   RuntimeTracePort.emit(draft)
Approval bridge ─┤
Durable host ────┘
                 ▼
         Trace recorder  (identity, sequence, clock, validation, content policy, dedupe, health)
                 ▼
            TraceStore
             ├── createInMemoryTraceStore()
             └── createFileTraceStore({ root })
                 ▼
   validateTrace · compareTraceWithExecution · reconstructRunTrace
```

- **Contract:** `@aao/contracts/trace.ts` (TraceEvent schema version 2) defines the envelope, the event catalog, a strict payload schema per type, canonical statuses, span refs, and typed drafts.
- **Typed drafts:** emitters build typed drafts, and the recorder validates each draft and the final event before storage. Arbitrary payloads cannot be stored.
- **Recorder:** `createTraceRecorder({ store, clock?, release? })` satisfies `RuntimeTracePort` structurally, so observability never imports the Runtime. Its `emit` never throws. `health()` and `runHealth(runId)` report `healthy` or `degraded` with bounded issue codes.
- **Optional tracing:** without `options.trace`, the Runtime behaves exactly as before.

## Nested execution

```text
Run span (traceId)
└── Node attempt span (node, step, attempt)
    ├── Model call span (invocationId, attempt)
    ├── Agent span (agentExecutionId, attempt)
    │   ├── agent.iteration.completed …
    │   └── Model call span per iteration
    └── Tool call span (toolExecutionId, attempt)
```

## Event catalog

| Family | Types |
| --- | --- |
| Run | `run.started` (entry Node, initial revision, reliability policies + `reliabilityPolicyFingerprint`, optional host release metadata), `run.completed`, `run.failed`, `run.cancelled` |
| Node | `node.started` (step, attempt, maxAttempts, state revision, `recoveryReplay`), `node.completed` (`outcomeSource`: executor / recovered / approval_resolution), `node.failed`, `node.waiting` |
| Routing & state | `route.selected`, `state.updated` (revisions + sorted changed key names; never values) |
| Model | `model.call.started` / `completed` / `failed`: invocation, policy, binding, registered provider identity, output kind, finish reason, token usage; never messages or output |
| Agent | `agent.started`, `agent.iteration.completed` (iteration, `CONTINUE`/`COMPLETE`, invocation, binding, usage), `agent.completed`, `agent.failed`; never working output or reasoning |
| Tool | `tool.call.started` (only once the handler is about to run; carries `access.decision = allow`), `tool.call.completed`, `tool.call.failed`, `tool.call.blocked` (handler never invoked: support gate, authorization denial with reason code, or validation); never input or output |
| Reliability | `retry.scheduled` (failed/next attempt, category, cause code, delay), `retry.exhausted` |
| Approval | `approval.requested` (requester id/type, approver roles, permission classes, request fingerprint; never the subject), `approval.resolved` (status, resolver id/type, `resolvedAt`) |
| Durability | `checkpoint.created`, `recovery.started`, `recovery.replayed`, `recovery.outcome_reused`, `recovery.completed`, `recovery.blocked` |
| Cancellation & failure | `cancellation.requested`, `cancellation.applied`, `failure.detected` (source runtime or durability; existing codes only) |

Retrieval, eval, artifact, memory, and side-effect events do not exist until those systems do. Failure codes reuse existing taxonomies (Runtime, Tool, Model, Agent, Approval, Durability); `TRACE_*` codes describe Trace infrastructure only.

### Emission rules

- **Committed lifecycle facts are emitted after their boundary commits.** In durable mode, this means after the boundary is persisted. These facts are state updates, Node completion, routing, waits, and terminal events. A failed persistence emits `failure.detected` and never a false commit. So `checkpoint.created` precedes the lifecycle events of the boundary it persisted.
- **In-flight facts are emitted when they happen.** These are starts, attempt failures, and retries.
- **An abandoned attempt's trace context closes when the Runtime stops waiting.** A late timed-out result never becomes a completion event.
- **A recorded outcome reused on recovery emits `recovery.outcome_reused`.** It also emits `node.completed { outcomeSource: "recovered" }` and never a new Tool or model call.
- **Unsafe ambiguous recovery emits `recovery.blocked` and `failure.detected`.** It emits no `run.failed`, because the Run stays `RUNNING`.

## Identity, ordering, idempotency

- **Trace id:** `sha256(["aao.trace.v1", runId, workflowId, workflowVersion])`, truncated to 32 hex characters. It is stable across restart and replay.
- **Span id:** 16 hex characters derived from semantic span identity. A crash replay keeps its logical span and is distinguished by `recoveryReplay`.
- **Event id:** `evt.` followed by 32 hex characters derived from trace, type, Node, span, and a small key (step, attempt, replay, ...). The same logical event re-emitted after restart deduplicates. The same id with different content is `TRACE_EVENT_CONFLICT`, and the stored evidence is kept.
- **Sequence:** contiguous from 0 per Run (`0,1,3` is a gap). A new process continues from the store.
- **Time:** `occurredAt` comes from an explicit trace clock. It is floored at the Run's last event, so a backwards wall clock never breaks order.
- **No duration fields:** latency for Sprint 16 comes from paired start/completion timestamps.

## Storage

`TraceStore` provides `append`, `getRunTrace`, `getEvent(runId, eventId)`, and `getLastSequence`, with no update or delete. Both implementations share one append decision. The file store:

```text
<root>/runs/<sha256(runId)>/events/000000000.json, 000000001.json, …
```

- **One immutable file per event.** Each write validates the event, writes a temp file, fsyncs it, hard-links it into place create-if-absent, then fsyncs the directory. Temp files are ignored.
- **Loading** validates each event's schema, contiguous sequences, unique ids, and a single trace and workflow identity. Anything else is `TRACE_STORE_CORRUPT`, and it is never repaired.
- **Paths:** identifiers are hashed, so caller text never becomes a path. Symlinked directories fail closed.
- **Scope:** local, single-host, single-writer. There is no database, collector, or vendor backend.

## Content policy

The default is metadata-only, and there is no capture mode.

- **Payload schemas:** every payload schema is strict and bounded.
- **Forbidden keys:** the explicit `FORBIDDEN_TRACE_KEYS` list (exact normalized match, never substring) is checked before storage, so `inputTokens` is safe while `token`, `apiKey`, `messages`, and `prompt` are rejected.
- **Size:** events are limited to 32 KiB (`MAX_TRACE_EVENT_BYTES`) and are never truncated.
- **People:** human identity in a trace is limited to principal id and type.

## Validation

- **`validateTrace(events, { runId?, runStatus? })`** returns `{ valid, issues }` with stable codes:
  - envelope and identity: `TRACE_INVALID_EVENT`, `TRACE_IDENTITY_MISMATCH`, `TRACE_SEQUENCE_GAP`, `TRACE_DUPLICATE_EVENT`;
  - run boundaries: `TRACE_RUN_START_MISSING`, `TRACE_TERMINAL_EVENT_MISSING`, `TRACE_TERMINAL_EVENT_MISMATCH`, `TRACE_EVENT_AFTER_TERMINAL`;
  - event families: `TRACE_NODE_EVENT_MISMATCH`, `TRACE_TOOL_EVENT_MISMATCH`, `TRACE_MODEL_EVENT_MISMATCH`, `TRACE_AGENT_EVENT_MISMATCH`, `TRACE_RETRY_EVENT_MISMATCH`, `TRACE_APPROVAL_EVENT_MISMATCH`, `TRACE_CHECKPOINT_EVENT_MISMATCH`, `TRACE_RECOVERY_EVENT_MISMATCH`.

  It checks Node, Tool, model, and Agent pairing, attempt and retry coherence, approval references, checkpoint monotonicity, and recovery ordering. Only `approval.resolved` may follow a terminal event, for a host cancelling a pending approval after `run.cancelled`.
- **`compareTraceWithExecution(events, execution)`** compares a trace with Runtime state. It checks the Node trajectory against history, attempts against `attemptCount`, the terminal event against `RunRecord.status`, waiting approvals, and the final state revision (`TRACE_STATE_MISMATCH`). It reports issues and never repairs anything.
- **`reconstructRunTrace(store, runId)`** returns the ordered `TraceRun`, which a future Run Inspector and Eval Runtime can build on.

Canonical fixtures in `packages/observability/test/fixtures/traces/` cover `successful_run`, `retry_then_success`, `approval_wait_then_resume`, `authorization_block`, `durable_recovery`, and `failed_run`. They are deterministic, validated, and sanitized.

## OpenTelemetry mapping

The AAO Trace schema is designed for OTel-compatible mapping. **No OpenTelemetry SDK, exporter, collector, or vendor backend is implemented in Sprint 15, and AAO makes no OpenTelemetry-compliance claim.** A future adapter would map:

| AAO | OTel concept |
| --- | --- |
| `traceId` (32 hex) | trace id |
| `spanId` / `parentSpanId` (16 hex) | span id / parent span id |
| Run (`run.started` → terminal event) | root span: workflow invocation |
| Node attempt (`node.started` → `node.completed`/`failed`/`waiting`) | child span per attempt |
| `model.call.*` | child span: model invocation (binding, registered provider/model identity, token usage) |
| `agent.*` | child span: agent invocation; iterations as span events |
| `tool.call.*` | child span: tool execution (Tool id/version, permission classes) |
| `type` | operation / span event name |
| `status` | span status (`failed`/`blocked` → error) |
| `occurredAt` pairs | start / end timestamps |
| retry, approval, checkpoint, recovery events | span events on the enclosing span |

## Boundaries and deferrals

- Not a logging framework. No Winston, Pino, ELK, Loki, or log shipping is added, and ordinary application logs stay separate.
- Not Audit: compliance evidence, policy-change history, and retention distinctions come in Sprint 16.
- Not Memory: Trace is never injected into model context.
- Not Artifact storage: a future `artifactRef` will point at large outputs.
- Deferred work:
  - metrics and cost: Sprint 16;
  - Eval Runtime: Sprint 17;
  - Run Inspector UI: Sprints 26/27;
  - OTel export: a future adapter.
