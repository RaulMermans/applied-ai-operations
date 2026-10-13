# ADR-020: Trace Runtime and observability boundary

Status: accepted

## Context

Through Sprint 14, AAO could execute governed, reliable, durable workflows, but it could not show *how* a Run executed. The only evidence was the bounded `NodeExecutionRecord[]` history and the durability operation ledger. Both are execution-correctness state, not chronological evidence. Sprint 2 had defined a placeholder `TraceEvent` (schema version 1, open `type`, untyped `payload`) before any trace runtime existed. Sprint 15 operationalizes it.

The central risk is that observability becomes a second source of truth. That can happen if Trace is consulted for recovery, or if trace failures change execution. This ADR fixes the direction: authoritative components decide, and Trace records.

## Decision

- **`@aao/observability` owns the canonical Trace Runtime.** It contains the recorder, deterministic identity, the content policy, the `TraceStore` port with in-memory and local file implementations, Trace-contract validation, Runtime comparison, and reconstruction. Its only production dependencies are `@aao/contracts` and `zod`. Only its file store touches the filesystem. No execution package depends on it. Metrics and Audit (Sprint 16), Evaluation (Sprint 17), and UI (Sprints 27/28 in the Sprint 17 roadmap) are not part of it yet.
- **The existing `TraceEvent` contract is migrated, not duplicated.** `@aao/contracts/trace.ts` now defines schema version 2:
  - **Envelope:** `schemaVersion`, `eventId`, `traceId`, `runId`, `sequence`, `occurredAt`, `type`, `workflowId`, `workflowVersion`, `nodeId?`, `spanId`, `parentSpanId?`, `status?`, `payload`.
  - **Catalog:** a closed catalog of dot-namespaced event types.
  - **Typed payloads:** one strict, bounded payload schema per type.
  - **Status:** a fixed canonical status per type.
  - **Drafts:** a typed `TraceEventDraft` that authoritative components emit.
  - **Removed:** the version-1 envelope, which had an open `type` and an untyped payload, no longer validates.
- **Trace is non-authoritative.** Trace records what Runtime, Governance, Approval, and Durability already decided. A Trace Event cannot:
  - complete a Node;
  - grant a permission;
  - restore state;
  - authorize a replay;
  - approve anything;
  - consume retry budget;
  - select a checkpoint;
  - change a Run lifecycle state.
- **The durability ledger remains execution-correctness truth.**
  - `DurabilityStore` has no trace storage, and `TraceStore` is a separate port.
  - Recovery planning (`planRecovery`) reads only the checkpoint chain and the operation ledger.
  - The durable host computes the recovery plan before it emits anything.
  - Tests prove both directions. Trace showing a completed Tool cannot prevent an ambiguous-operation replay. A trace missing that completion cannot veto reuse of a recorded outcome.
  - Deleting or corrupting the Trace Store leaves recovery intact.
- **The Runtime never reads Trace.**
  - `RuntimeTracePort` has one method: `emit(draft): Promise<void>`. The per-attempt `NodeTraceContext` exposes only `span`, `recoveryReplay`, and `emit`.
  - The Runtime awaits `emit` only to keep events in deterministic order. It discards every result and rejection.
  - A static regression scans Runtime, Tool, Model, Agent, Approval, Durability, Governance, Authorization, MCP, DSL, and Contracts for any Trace read API.
- **Instrumentation is optional.**
  - With no `options.trace`, behavior is unchanged: the untraced attempt path performs no extra `await`, and the Sprint 13 timing tests prove it.
  - Executors receive tracing only through trusted `NodeExecutionContext.trace`. There is no global recorder, singleton, or environment discovery.
- **Trace identity is deterministic.**
  - **Trace id:** SHA-256 of `runId`, `workflowId`, and `workflowVersion`, truncated to 32 hex characters (the OTel trace-id width). It is stable across restart and replay, and it is never model-generated or user-controlled.
  - **Span ids** (16 hex characters) come from semantic identity:
    - Run: the trace itself;
    - Node attempt: `nodeId` + `step` + `attempt`;
    - Tool: `toolExecutionId` + `attempt`;
    - Model: `invocationId` + `attempt`;
    - Agent: `agentExecutionId` + `attempt`.
  - **Event ids:** SHA-256 of trace + type + Node + span + a small emitter key (step, attempt, replay flag, ...).
  - **Replays:** a durable recovery replay keeps its logical span. The physical re-invocation is a distinct event, marked `recoveryReplay: true`.
- **Ordering is `sequence`.**
  - Each Run has one contiguous sequence starting at 0. The local recorder owns it, so a gap is a validation error.
  - A restarted process continues the sequence from the store.
  - `occurredAt` is descriptive only. It comes from an explicit trace clock and is floored at the Run's last event, so it never runs backwards.
- **Append is idempotent and append-only.**
  - The same event id with an identical event is a no-op, which lets a recovery boundary re-emit the same logical event safely.
  - The same id with different content is `TRACE_EVENT_CONFLICT`, and the stored evidence is kept.
  - There is no update or delete API.
- **File store.**
  - Layout: `<root>/runs/<sha256(runId)>/events/<9-digit sequence>.json`, one immutable file per event.
  - Write path: validate, then write a temp file, fsync it, create-if-absent hard link, then fsync the directory. Temp files are never trace data.
  - Load path validates every event, contiguity, id uniqueness, and one trace and workflow identity. Anything else is `TRACE_STORE_CORRUPT`.
  - Symlinked directories fail closed.
- **Trace failure never becomes Runtime truth.**
  - The recorder never throws. Failures become bounded issues (`TRACE_INVALID_EVENT`, `TRACE_EVENT_CONFLICT`, `TRACE_SEQUENCE_CONFLICT`, `TRACE_EVENT_TOO_LARGE`, `TRACE_FORBIDDEN_CONTENT`, `TRACE_STORE_FAILURE`, `TRACE_STORE_CORRUPT`, `TRACE_RECORDER_FAILURE`), with no raw exception text.
  - `health()` and `runHealth(runId)` report `healthy` or `degraded`. A Run can succeed with a degraded trace; these are separate facts, and `RunRecord.status` never changes because of Trace.
  - Trace failure never triggers a retry or replay. Tested: a Tool succeeds, then trace append throws, and the Tool is still called exactly once.
- **Metadata-only content by default.** No capture mode exists. Payload schemas have no field that could hold:
  - prompts, messages, or model output;
  - Tool input or output;
  - state values;
  - the approval subject;
  - credentials;
  - reasoning or chain-of-thought;
  - stack traces or provider responses.

  An explicit exact-key content policy (`FORBIDDEN_TRACE_KEYS`; no substring matching, so `inputTokens` stays valid) is checked before storage as defense in depth. Events are limited to 32 KiB and are never truncated. Human identity is limited to stable principal ids and types. Agent iteration events carry the decision (`CONTINUE`/`COMPLETE`) and model metadata, never the working output or a rationale.
- **First-class event families.** Run, Node, routing, state (sorted key names and revisions only), model call, Agent, Tool call (including `tool.call.blocked` when the handler was never invoked), retry, approval, checkpoint, recovery, cancellation, and `failure.detected`. Retrieval, eval, artifact, memory, and side-effect events are absent until those systems exist.
- **Emission points.**
  - **Lifecycle commits are emitted after their boundary commits.** This covers state, Node completion, routing, waits, and terminal events. In durable mode, "commits" means the boundary has been persisted. A persistence failure yields `failure.detected`, not a false commit. So `checkpoint.created` precedes the lifecycle events of the boundary it made durable.
  - **In-flight events are emitted when they happen.** This covers node, tool, and model starts, failures, and retries. `tool.call.started` is emitted only after the support gate, authorization, and input validation have passed.
  - **Late results never become evidence.** An abandoned (timed-out) attempt's trace context closes when the Runtime stops waiting, so its late completion is never recorded.
  - **Recovered outcomes are labelled.** A reused recorded outcome emits `recovery.outcome_reused` and `node.completed { outcomeSource: "recovered" }`, never a new Tool or model call.
  - **Approval events.** `approval.resolved` is emitted when a resolution is consumed by continuation. It carries the authoritative `resolvedAt`.
  - **Unsafe recovery.** It emits `recovery.blocked` and `failure.detected`, but not `run.failed`, because the Run is not FAILED.
- **Trusted model identity.**
  - `ModelBinding` gains optional trusted `identity: { provider, model, revision? }` registration metadata.
  - It is traced only when registered, and never parsed from a binding id or output.
  - No prompt version is fabricated; Agent version, model policy, and workflow version are traced instead.
  - Token usage is traced. No cost is estimated.
- **Reliability configuration fingerprint.** `run.started` records the trusted reliability policies and a `reliabilityPolicyFingerprint`. This is observability metadata: it is not the durable plan fingerprint, and it does not change durability compatibility.
- **Runtime history remains distinct.** `NodeExecutionRecord[]` stays bounded, Runtime-owned execution evidence. `compareTraceWithExecution` reports trace/Runtime disagreement as trace integrity issues. It never repairs Runtime from Trace.
- **OpenTelemetry is a future adapter, not a dependency.** The schema is designed for OTel-compatible mapping (see [trace runtime](../architecture/trace-runtime.md)). No OTel SDK, exporter, collector, or vendor backend is introduced, and AAO does not claim OpenTelemetry compliance.
- **Trace is neither Audit nor Memory.** Trace answers "what happened, in what order, and why". Compliance-grade Audit evidence is Sprint 16. Trace is never injected into model context.

## Consequences

- Given a Run id, the meaningful execution trajectory can be reconstructed from structured, privacy-minimized events without using Trace as execution authority.
- Event-count growth is bounded by existing Runtime bounds: `maxSteps`, `maxAttempts ≤ 3`, `maxIterations ≤ 16`, and at most one recovery replay. Each executor emits a fixed, small number of events per attempt.
- Events are emitted synchronously in order. A slow trace store slows local execution, but it never changes it.
- The single-writer assumption is shared with the durability reference store; cross-process exclusion remains out of scope.
