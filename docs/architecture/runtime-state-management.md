# Runtime state management

`@aao/runtime` (`packages/runtime`) turns Sprint 4's deterministic execution function into a *managed* run execution system: an authoritative Run lifecycle, an authoritative Node lifecycle, revisioned state, and safe execution snapshots at every safe boundary. See [ADR-010](../decisions/ADR-010-managed-runtime-state-and-lifecycle.md) for the accepted decision this document elaborates, [runtime V1](runtime-v1.md) for the execution pipeline this extends, and [runtime lifecycle](runtime-lifecycle.md) for the frozen `RunStatus`/`NodeStatus` contract this implements.

## Why these concepts stay separate

`docs/architecture/state-memory-durability.md` already separates State, Checkpoint, and Logs/Traces. This sprint adds several more Runtime-specific concepts, and conflating any of them is the single easiest way to corrupt this design:

| Concept | What it is | Owned by | Durable? |
| --- | --- | --- | --- |
| `RunState` | Authoritative workflow business/execution data for one run | `@aao/contracts` | No — in-memory only |
| `RunRecord` | Authoritative Run lifecycle: identity, status, timestamps, cursor | `@aao/contracts` (schema); `@aao/runtime` (transitions) | No |
| `NodeStatusMap` | Authoritative per-Node lifecycle for one run | `@aao/runtime` | No |
| `RuntimeExecutionState` | The single in-memory bundle of the three above, plus step and history | `@aao/runtime` | No |
| `StateSnapshot` | An immutable, timestamped capture of `RunState` alone | `@aao/contracts` (schema); `@aao/runtime` (`captureStateSnapshot`) | No — a capture, not a store |
| `RuntimeExecutionSnapshot` | A safe capture of Run lifecycle + `StateSnapshot` + Node lifecycle + cursor + step | `@aao/runtime` | No |
| `DurableCheckpoint` | Proof that one safe boundary (snapshot + history) was durably stored | `@aao/durability` (Sprint 14) | Yes, when a host opts in |
| Trace | Future operational execution evidence (latency, cost, spans) | Not yet implemented | N/A |
| Memory | Approved reusable knowledge across runs | Not in scope this sprint | N/A |

The critical distinction: **`StateSnapshot` ≠ `RuntimeExecutionSnapshot` ≠ a durably persisted `DurableCheckpoint`.** A `RuntimeExecutionSnapshot` is the Runtime's serializable state at a safe boundary; it is not a recovery guarantee by itself. Since Sprint 14, `@aao/durability` wraps it with its execution history in a `DurableCheckpoint`, which is the one canonical durable checkpoint. The Sprint 2 `CheckpointRecord` placeholder was deleted (ADR-019). The Runtime itself still writes to no filesystem, database, or queue.

## Conceptual flow

```text
Request validation (validateRuntimeInput)
      |
CREATED                                    <- createRunRecord (clock)
      |
VALIDATING                                 <- transitionRunRecord
      |
Runtime preflight (runPreflight)
      |  (failure -> FAILED, safe snapshot, stop)
      v
QUEUED                                     <- transient in-process only, no queue infra
      |
RUNNING
      |
Node READY   (entry node; next node after each success)
      |
Node RUNNING
      |
Node SUCCEEDED  ---------------------------> Safe snapshot (captureExecutionSnapshot)
      |  (or Node FAILED -> Run FAILED, safe snapshot, stop)
      v
next Node READY, or terminal reached
      |
COMPLETED / FAILED                         <- transitionRunRecord, cursor cleared
      |
Final safe snapshot
```

## Run lifecycle

`RunRecord.status` (canonical `RunStatus`, `@aao/contracts`) is the **sole** source of Run lifecycle truth. Sprint 4's `WorkflowExecutionResult` carried its own ad hoc `status: "COMPLETED"` field alongside a separate `run.state`; Sprint 5 removes that duplicate source entirely — `WorkflowExecutionResult.execution.run.status` is now the only place lifecycle status lives (see [ADR-010](../decisions/ADR-010-managed-runtime-state-and-lifecycle.md)'s "no duplicate Run status" decision).

`run-lifecycle.ts` provides:

- `createRunRecord({ runId, workflowId, workflowVersion }, clock)` — builds a `CREATED` record; `createdAt`/`updatedAt` start identical, both from the clock.
- `isLegalRunTransition(from, to)` — the frozen legal-transition table from [runtime lifecycle](runtime-lifecycle.md), and nowhere else.
- `transitionRunRecord(run, nextStatus, timestamp)` — the only way Runtime code changes `RunRecord.status`. Immutable; preserves `createdAt`; throws `IllegalRunTransitionError` for any transition `isLegalRunTransition` rejects, including any transition attempted from a terminal status. This is a Runtime-internal invariant violation, not a `RuntimeFailure` value — it can only happen if Runtime code itself attempts an illegal transition, which every code path in `engine.ts` is written not to do.
- `setCurrentNodeId(run, nodeId | undefined)` — the single execution cursor. While `RUNNING`, it identifies the Node currently `READY` or `RUNNING`. Every transition into a terminal status (`COMPLETED`, `FAILED`, `CANCELLED`) clears it, so a terminal Run's "current node" is never ambiguous — the failed/last-successful Node remains identifiable through `NodeStatusMap` and `history` instead.

Managed execution walks `CREATED -> VALIDATING -> QUEUED -> RUNNING -> COMPLETED | FAILED`. `QUEUED` is deliberately transient: it means "validation passed, this run is eligible to execute", and the local Runtime claims capacity immediately — it is not a Redis queue, a worker job, or durable scheduling, and none of that infrastructure is introduced by this sprint.

### Basic invalid input vs. a managed Run failure

These are different failure classes:

- **Before a `RunRecord` can be trusted to exist** — a malformed `CompiledWorkflowPlan`, an invalid `RunState`, a `runId` mismatch, or a malformed `NodeRegistry`/options — `validateRuntimeInput` rejects the request with `INVALID_RUNTIME_INPUT`. No `RunRecord`, `execution`, or `latestSnapshot` is ever constructed for this case; the request could not be trusted enough to create a Run at all.
- **After a `RunRecord` exists** — a preflight failure, a Node throwing, an invalid Node result, or exceeding the step ceiling — is a **managed Run failure**: `RunRecord.status` becomes authoritatively `FAILED`, and both `execution` (the `RuntimeExecutionState` at the last safe boundary) and `latestSnapshot` are always present on the returned failure.

## Node lifecycle

`NodeStatusMap` (`node-lifecycle.ts`) is a small `Record<NodeId, NodeStatus>` — deliberately not a larger `NodeRun` domain model, since nothing yet demonstrates a need for more than a status per Node. Canonical `NodeStatus` (`@aao/contracts`) has eight values; Runtime V1 implements behavior for exactly four of them:

```text
PENDING -> READY -> RUNNING -> SUCCEEDED
                             -> FAILED
```

`WAITING`, `SKIPPED`, and `CANCELLED` remain valid contract values with **no** Runtime V1 behavior — nothing in this package ever produces them. `isLegalNodeTransition`/`transitionNodeStatus` enforce this table the same way the Run lifecycle manager enforces `RunStatus`; an illegal transition throws `IllegalNodeTransitionError`, a Runtime-internal invariant violation.

When a Run is created, every plan Node starts `PENDING` (`initializeNodeStatuses`). Once preflight passes and execution actually begins, the entry Node becomes `READY`. On a Node's success, if there is a next Node, it becomes `READY` (`PENDING -> READY`) and the Run's cursor moves to it. On a Node's failure (an executor throwing, or returning an invalid result), that Node becomes `FAILED` and the Run becomes `FAILED` — **downstream Nodes are left exactly as they were (`PENDING`)**, never marked `CANCELLED`. `CANCELLED` means an authorized cancellation happened, which this sprint does not implement; a downstream Node that never got a chance to run is not the same thing.

## Managed execution state

`RuntimeExecutionState` (`types.ts`) is the one Runtime-owned, JSON-safe bundle:

```ts
interface RuntimeExecutionState {
  run: RunRecord;
  state: RunState;
  nodeStatusesById: NodeStatusMap;
  step: number;
  history: NodeExecutionRecord[];
}
```

`run` is the only source of Run lifecycle truth; `nodeStatusesById` the only source of Node lifecycle truth; `state` the only source of authoritative workflow data. There is no Node Registry, executor, clock, or logger inside it — those are Runtime *dependencies* for producing execution, not part of the state itself, and are never serialized.

`engine.ts` threads exactly one `execution` variable through `executeWorkflow`, reassigning it immutably at every safe boundary. Every failure path builds its `RuntimeFailure` from the *last safely committed* `execution` plus whatever Node-level change that specific failure caused (e.g. the failing Node's own transition to `FAILED` and its `NodeExecutionRecord`) — never from a half-updated intermediate state.

### Execution history

`NodeExecutionRecord.status` is now `"SUCCEEDED" | "FAILED"` (Sprint 4 only had `"SUCCEEDED"`). A `FAILED` record's `stateRevisionBefore` always equals `stateRevisionAfter`: no state patch is ever applied from a Node that threw, returned a safe executor failure (`{ ok: false, failure }`, Sprint 7), or returned a result that failed validation. This remains deliberately minimal execution evidence — no per-Node timestamps, latency, tokens, cost, or trace ids. It is not the future canonical AAO Trace; it exists so tests (and eventually a real tracing layer) have deterministic proof of what ran, in what order, with what state effect.

## The clock boundary

`clock.ts` is the only place Runtime lifecycle code is allowed to ask "what time is it":

```ts
interface RuntimeClock {
  now(): string;
}
```

`createSystemClock()` is the production implementation (wall-clock `Date.now()` as ISO, held monotonic per clock instance so an NTP step backwards never produces an earlier instant). `RuntimeOptions.clock` lets a caller — in practice, tests — inject a deterministic one, so `run-lifecycle.test.ts`, `execution-snapshot.test.ts`, and `managed-execution.test.ts` can assert exact `createdAt`/`updatedAt`/`capturedAt` values and ordering without touching real wall-clock time. Every timestamp minted this way is validated against `@aao/contracts`'s canonical `isoTimestampSchema` before it enters a `RunRecord` or `StateSnapshot` — a malformed clock output can never silently enter a canonical record.

### Temporal integrity

Two lifecycle invariants are enforced by comparing *instants*, never raw ISO strings (`timestamps.ts`, `compareIsoInstants`), so `2026-09-24T10:00:00Z` and `2026-09-24T12:00:00+02:00` are treated as the same moment:

- **Monotonic Run time** — `transitionRunRecord` requires the next `updatedAt` to be the same instant as, or later than, the previous one. An earlier instant throws: it is an internal lifecycle invariant (a broken clock or caller), not a `RuntimeFailure` code.
- **Snapshot coherence** — a `RuntimeExecutionSnapshot` must satisfy `stateSnapshot.capturedAt >= run.updatedAt`. `captureExecutionSnapshot` throws on violation, and `RuntimeExecutionSnapshotSchema` rejects such a snapshot, so `validateSnapshotAgainstPlan` reports `INVALID_EXECUTION_SNAPSHOT`.

Node execution history intentionally carries no timestamps.

A `model` node's `ModelRequest`/`ModelResult` appear in `RunState` (and therefore in snapshots) only because the workflow put them there under explicit top-level keys — Model Runtime keeps no hidden conversation state (see [model runtime](model-runtime.md)).

An `agent` node (Sprint 7, [agent runtime](agent-runtime.md)) is **atomic** at this boundary. All of its internal iterations run while that one Node is `RUNNING`, so they are one workflow `step`, never a safe boundary, and never produce a snapshot — the "no `RUNNING` Node in a safe snapshot" invariant holds unchanged. Agent-local working state (drafts, iteration history) never touches `RunState` mid-execution: on success the node proposes exactly one patch (`{ [resultStateKey]: AgentResult }`, one revision increment regardless of iteration count); on failure it proposes none, and the last safe snapshot remains the latest valid one. Agent durability (checkpointing mid-Agent) is deliberately not implemented.

## State snapshots and Runtime execution snapshots

`captureStateSnapshot(state, capturedAt)` (`state.ts`) builds a canonical `StateSnapshot` (`@aao/contracts`): a deep clone of `RunState.values`, its `runId` and `revision`, and the given `capturedAt`. It is domain data, not a persistence guarantee.

`RuntimeExecutionSnapshot` (`execution-snapshot.ts`, `@aao/runtime`-owned — not `@aao/contracts`, since it is an execution-engine artifact, not a cross-product canonical contract) wraps this with the rest of a safe execution boundary:

```ts
{
  schemaVersion: 2,
  run: RunRecord,
  stateSnapshot: StateSnapshot,
  nodeStatusesById: Record<NodeId, NodeStatus>,
  step: number,
  wait?: { kind: "approval"; nodeId: NodeId; referenceId: string; requestFingerprint: string },
}
```

### The safe-boundary invariant

A `RuntimeExecutionSnapshot` must never represent a half-executed Node. `captureExecutionSnapshot` enforces this by throwing if any Node in `nodeStatusesById` is currently `RUNNING` — a Runtime-internal invariant violation (calling it from the wrong place in `engine.ts`), never a value that reaches a caller. Safe boundaries are:

- **Before the first Node executes** — `Run = RUNNING`, entry Node `= READY`, `step = 0`.
- **After a Node succeeds** — the executed Node `= SUCCEEDED`, the next Node `= READY` (or the Run is already `COMPLETED` if it was terminal), and its state patch is already accepted.
- **After a Node fails** — the failing Node `= FAILED`, `Run = FAILED`, and `state`/`stateSnapshot` reflect only the last *validly accepted* patch — never anything proposed by the failing Node itself.
- **After completion** — the final Node `= SUCCEEDED`, `Run = COMPLETED`.
- **At approval wait** — `Run = WAITING_FOR_APPROVAL`, current Approval Node `= WAITING`, and a bounded wait descriptor identifies the request. No Node is `RUNNING`.

This matters most once real side effects exist: a snapshot captured mid-Node could never later establish whether that Node's operation actually completed.

### Latest snapshot only

The Runtime does not accumulate a full in-memory snapshot archive. `WorkflowExecutionResult` (both success and failure) exposes exactly one `latestSnapshot`, updated at each safe boundary as execution proceeds — bounding Runtime memory to roughly "current execution state + one safe snapshot + lightweight history", not a growing log. A future durability layer can choose which safe boundaries to persist; this sprint does not make that choice for it.

### Snapshot/plan compatibility

A structurally valid `RuntimeExecutionSnapshot` is not automatically compatible with a particular `CompiledWorkflowPlan` — a snapshot from one workflow version handed to a different plan, or a hand-corrupted one, should never be silently trusted. `validateSnapshotAgainstPlan(snapshot, plan)` checks: workflow identity (`workflowId`/`workflowVersion` match), internal identity (`run.runId` matches `stateSnapshot.runId`), that `nodeStatusesById`'s keys exactly match the plan's Node set, that `currentNodeId` (when present) resolves in the plan, and safe-boundary coherence for `RUNNING`/`WAITING_FOR_APPROVAL`/`COMPLETED`/`FAILED` snapshots (e.g. a `RUNNING` snapshot's current Node must itself be `READY`; a `COMPLETED`/`FAILED` snapshot must carry no cursor). This is the smallest set of invariants needed to catch obviously corrupt or incompatible execution state — not a general-purpose graph/state verifier — and exists as groundwork for a future snapshot handoff, persistence, or Run Inspector feature, none of which this sprint implements.

## What this sprint deliberately does not build

*Historical (Sprint 5). Durable resume, a filesystem run store, safe-boundary cancellation, and durable retry accounting were added in Sprint 14 outside this package. See the Sprint 14 section below.*

Consistent with [ADR-010](../decisions/ADR-010-managed-runtime-state-and-lifecycle.md):

- **No durable resume.** `continueWaitingWorkflow` advances an in-process waiting Run after validation. There is no restoring a Run from a persisted snapshot.
- **No persistence.** No database, filesystem run store, queue, or object storage. Everything is process-local and in-memory.
- **No general cancellation or durable retry.** Approval cancellation is implemented at a waiting boundary. Bounded in-process retries (Sprint 13) stay inside one `RUNNING` Node lifecycle; `RETRYING` remains unused and is reserved for future durable, scheduled retry.
- **No reducer registry.** State patch semantics are unchanged from Sprint 4: a shallow top-level merge, nothing more, until a real Node/workflow demonstrates a need for domain-specific merge behavior.
- **No tracing.** `NodeExecutionRecord` is still not the canonical AAO Trace — no latency, cost, tokens, or spans.

Runtime snapshots are recovery-*ready* data structures. They are not a durable-recovery guarantee.

## Sprint 12 approval boundary

An explicitly registered Approval Node now returns a bounded Runtime wait result. The Run enters `WAITING_FOR_APPROVAL`, the Approval Node enters `WAITING`, and downstream nodes remain pending. The version-2 safe snapshot includes an approval reference and fingerprint. A trusted host may resolve the process-local Approval and invoke validated in-process continuation through the same Runtime loop. Approval only confirms the exact request; Governance, Authorization, Agent ceilings, and Tool Runtime support still apply. See [approval engine](approval-engine.md) and [ADR-017](../decisions/ADR-017-human-approval-and-runtime-waitpoints.md).

## Sprint 13 reliability boundary

Attempts are Runtime metadata, not business state. Every attempt receives a clone of the same authoritative state. Only the accepted successful attempt's patch is applied, so `RunState.revision` changes at most once per Node. Failed and timed-out attempts commit nothing, and a late result from a timed-out attempt is ignored. Safe snapshot boundaries are unchanged and are never captured mid-attempt. Snapshot `schemaVersion` stays 2 because attempt evidence lives in history and failures. A snapshot never implies that a timed-out, still-running attempt can be resumed. Durable retry accounting arrived in Sprint 14 (below). See [reliability runtime](reliability-runtime.md) and [ADR-018](../decisions/ADR-018-runtime-reliability-and-bounded-retries.md).

## Sprint 14 durability boundary

A durability host persists the Runtime's own state representation without redefining it:

- A `DurableCheckpoint` (`@aao/durability`) wraps the version-2 `RuntimeExecutionSnapshot` and its `NodeExecutionRecord[]` history.
- Checkpoints are taken only at safe boundaries (never with a `RUNNING` Node) and are immutable and contiguous per Run.
- Recovery reconstructs `RuntimeExecutionState` — Run, state, Node statuses, step, history, and wait — without creating a new Run, and validates it with `validateExecutionAgainstPlan`.
- `resumeWorkflow` continues it through the single loop. A recorded accepted outcome's patch is applied exactly once through the normal commit path, so `RunState.revision` advances once.
- A resumed process's clock is floored at the persisted `run.updatedAt`.

See [durable execution](durable-execution.md) and [ADR-019](../decisions/ADR-019-durable-execution-checkpoints-and-replay.md).
