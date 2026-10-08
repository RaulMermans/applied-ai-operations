# State, memory, and durability boundaries

These terms have separate responsibilities and must not be conflated.

| Concept | Purpose | Examples | Boundary |
| --- | --- | --- | --- |
| State | Active structured data for one workflow run | Inputs, node outputs, routes, approval state, status | Authoritative active run data. |
| Short-Term Context | Context assembled for a model during the current run | Relevant state, retrieved company information, recent tool output, compressed context | Not authoritative persistence. |
| Long-Term Memory | Approved reusable knowledge across work | Stable preferences, validated corrections, reusable lessons, approved rules | Not in initial V1; never persist speculative model conclusions as truth. |
| Checkpoint | Durable recovery snapshot | Approval waitpoints, expensive work, long-running work, external actions, major boundaries | Supports resume and interruption recovery. |
| Artifact | Intentional run output | Reports, drafts, extracted files, proposals, structured datasets | A first-class output, not an incidental log. |
| Logs / Traces | Operational execution evidence | Lifecycle events, calls, retries, approvals, errors | Not business state; sensitive data is not copied indiscriminately. |

AAO owns state, checkpoint, run persistence, interruption recovery, and persisted-operation semantics. Underlying storage remains replaceable. Before durable external actions, implementation must establish idempotency keys and a recoverable side-effect design. No exactly-once semantics are claimed.

`@aao/runtime` implements the in-memory half of this boundary: an authoritative `RunState` per run and a safe, in-memory `RuntimeExecutionSnapshot` captured only between Nodes (never mid-execution). See [runtime state management](runtime-state-management.md) and [ADR-010](../decisions/ADR-010-managed-runtime-state-and-lifecycle.md).

`@aao/durability` (Sprint 14) implements the durable half. A `DurableCheckpoint` persists a snapshot and its execution history at a safe boundary. A write-ahead operation ledger records each executor attempt's intent and validated outcome, and recovery after restart replays an ambiguous operation only when trusted recovery/idempotency metadata makes that safe. Checkpoints, operation records, and Approval records are execution-correctness state. They are not long-term memory, not traces, and not authority. See [durable execution](durable-execution.md) and [ADR-019](../decisions/ADR-019-durable-execution-checkpoints-and-replay.md).

`@aao/observability` (Sprint 15) implements Logs/Traces as structured Trace Events in a separate `TraceStore`. Trace is an observational projection: it records metadata only and never state values, it is never injected into model context (it is not memory), and recovery never reads it (it is not a checkpoint). See [trace runtime](trace-runtime.md) and [ADR-020](../decisions/ADR-020-trace-runtime-and-observability-boundary.md).
