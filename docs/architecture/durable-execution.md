# Durable execution

Sprint 14 adds `@aao/durability`. With it, a Run can survive process termination and continue from its last durably committed execution boundary. Completed work is not replayed, and an operation whose outcome is unknown is never blindly repeated. The design decision is [ADR-019](../decisions/ADR-019-durable-execution-checkpoints-and-replay.md).

Durability persists and restores Runtime truth; it never redefines it. There is one Runtime and one execution loop. Durability is an explicit host capability, and the in-memory Runtime still works without it.

## Layers

```text
@aao/durability ──► @aao/runtime, @aao/approval, @aao/workflow-dsl, @aao/contracts
     │
     ├── contracts      RunManifest, DurableCheckpoint, DurableOperation, CancellationRecord
     ├── fingerprint    planFingerprint (canonical JSON + SHA-256)
     ├── store          DurabilityStore port (storage-neutral)
     ├── file-store     local filesystem reference store (single host, single writer)
     ├── recovery       checkpoint → execution; operation ledger → recovery plan
     └── host           createDurableRuntimeHost: execute / resume / getRun / getApproval / requestCancellation
```

`@aao/runtime` exposes only a generic port (`RuntimeOptions.durability`) and `resumeWorkflow`. `@aao/approval` exposes only an `ApprovalRepository` port. Neither imports durability or the filesystem.

## Protocol

```text
        SAFE CHECKPOINT                 persistCheckpoint (sequence N, immutable)
              │
              ▼
      PERSIST OPERATION INTENT          beginAttempt → operation op.s<step>.a<attempt> = STARTED
              │                         (write fails → executor never invoked)
              ▼
           EXECUTE                      one attempt, cloned state, AbortSignal
              │
              ▼
      VALIDATE NODE OUTCOME             Runtime validation + classification
              │
              ▼
      PERSIST ACCEPTED OUTCOME          recordAttemptOutcome → OUTCOME_RECORDED (validated values only)
              │                         (failure + retry allowed → next attempt, same Node execution)
              ▼
       COMMIT RUNTIME STATE             the single commit path: patch once, transition, route
              │
              ▼
       PERSIST CHECKPOINT               sequence N + 1 (COMPLETED / WAITING reported only after this)
```

Checkpoint timing:

- Initial `RUNNING` with the entry Node `READY`. This is created atomically together with the Run manifest.
- After every accepted Node completion (the next Node `READY`).
- At an approval wait (`WAITING_FOR_APPROVAL`).
- At approval resolution.
- At each terminal boundary: `COMPLETED`; `FAILED`, including preflight failure; `CANCELLED`.

No checkpoint ever contains a `RUNNING` Node.

If any durability write fails, the Runtime stops with `DURABILITY_PERSISTENCE_FAILED` and reports the **last durably persisted** boundary with its Run status unchanged. The host adds the store's redacted cause as `details.durabilityCode`.

## Recovery

```text
             RESTART
                │
                ▼
       LOAD DURABLE TRUTH              manifest + full checkpoint chain + operations + cancellation
                │                      (any corruption → DURABILITY_CORRUPT_STATE, nothing executes)
                ▼
       VALIDATE PLAN / STATE           workflow id + version + planFingerprint, execution vs plan
                │                      (mismatch → DURABILITY_PLAN_MISMATCH)
                ▼
        WHAT HAPPENED LAST?
┌────────────────────────────────────────────────────────────────────────┐
│ terminal checkpoint              → return persisted outcome, 0 calls    │
│ waiting checkpoint               → wait, or revalidate + continue       │
│ no operation after checkpoint    → continue (crash windows A, D)        │
│ recorded outcome                 → commit without invoking (window C)   │
│ ambiguous + recovery safe        → one bounded replay, same attempt (B) │
│ ambiguous + unsafe / exhausted   → fail closed, durable truth untouched │
└────────────────────────────────────────────────────────────────────────┘
```

Recovery reconstructs `RuntimeExecutionState` (Run, state, Node statuses, step, history, wait) from the checkpoint. It never creates a new Run. It computes a `NodeRecoveryDirective`: the recorded outcomes of the current `READY` Node's attempts, plus an optional `replayAttempt`. It then calls `resumeWorkflow`. The Reliability Controller replays recorded outcomes through its normal decision:

- A recorded success or wait is returned without invoking the executor.
- Recorded failures continue attempt numbering and the `maxAttempts` budget.
- A replay re-invokes the ambiguous attempt under its original attempt number.

Operations that contradict the checkpoint are corruption. That covers a wrong Node, a wrong state revision, a different Run, attempt gaps, an unfinished operation behind the checkpoint, or a raw payload as outcome.

### Crash windows

| Window | Durable truth at restart | Behavior |
| --- | --- | --- |
| A — before intent | Checkpoint (Node `READY`), no operation | The executor never became eligible; continue normally. |
| B — after intent, before outcome | `STARTED`, no outcome | Ambiguous. Replay once only if recovery-safe; otherwise `DURABILITY_UNSAFE_REPLAY`. |
| C — after outcome, before checkpoint | `OUTCOME_RECORDED` | Commit the recorded outcome through the canonical path; no executor call; then checkpoint. |
| D — after checkpoint | Next checkpoint | Continue from it; nothing behind it re-executes. |

## Recovery safety vs retry safety

| | Retry safety (ADR-018) | Recovery safety (ADR-019) |
| --- | --- | --- |
| Question | Safe to try again after a **known** failure? | Safe to replay after a crash left the outcome **unknown**? |
| Source | `NodeExecutor.retrySafety` | `NodeExecutor.recoverySafety` |
| Default | unsafe | unsafe |
| Bound | `maxAttempts ≤ 3` (policy) | `MAX_RECOVERY_REPLAYS = 1` (hard) |

Built-in recovery safety:

- `final_output`, Model, Agent, and Approval Nodes are safe.
- A Tool Node is safe when the registered Tool is all-`read_only` and declares `retrySafety: "safe"` or `idempotency: "execution_id"`.
- A Tool Node is also safe when the Tool is `read_only`/`write_draft` and declares `idempotency: "execution_id"`.
- Everything else is unsafe.

A `write_draft` Tool is still never retried after a known failure. Unsupported permission classes stay blocked by the Tool Runtime support gate.

## Idempotency

`toolExecutionId` (`tool.<sha256(runId, nodeId)>`) is the logical Tool operation key. It is identical for every retry attempt, every process restart, and every recovery replay. `idempotency: "execution_id"` is the Tool implementation's trusted assertion that it deduplicates on that key. AAO guarantees the key is stable and propagated, and that replay follows these rules. It cannot verify that an implementation or remote provider honors the key. **AAO makes no exactly-once claim.**

The idempotency fixture crashes after a draft was created and before the outcome was durable. It then shows 2 physical handler invocations, 1 logical draft, and 1 unique `toolExecutionId`. The same crash with `idempotency: "none"` fails closed with zero replay calls.

## Approvals

The Approval Engine stores records through an `ApprovalRepository`. In-memory is the default; the durable file repository lives under `<root>/approvals/`.

- Resolution is atomic `pending → terminal` compare-and-set.
- Exact request replay returns the stored record, even when it is already resolved. This makes the Approval Node crash-safe without duplicate approvals.

Before an approved record is consumed after a restart, continuation revalidates four things:

- The plan fingerprint.
- The exact subject fingerprint.
- Whether current Governance still allows the requester the stored permission classes.
- Whether the resolver is still a registered human in a required role.

Old records are evidence, never authority. A `governanceFingerprint` recorded at the wait is inspection evidence only.

## Cancellation

`host.requestCancellation(runId)` persists an idempotent request. At the next safe boundary the Run becomes `CANCELLED` and a terminal checkpoint is persisted. That boundary is before a Node would begin, or on resume of a waiting Run, whose pending Approval is cancelled too. No Node begins afterward. A durably recorded accepted outcome is still committed first. Cancellation stops future work; it does not reverse history, and it does not interrupt a running attempt.

## Reference store

```text
<root>/runs/<sha256(runId)>/manifest.json
                           /checkpoints/000000.json …   immutable, contiguous, create-if-absent
                           /operations/s000001-a1.json …
                           /cancellation.json
<root>/approvals/<sha256(approvalId)>.json
```

The reference store has these properties:

- Writes are atomic: validate, temp file in the same directory, fsync, then rename or hard-link, then directory fsync.
- Temp files are never authoritative.
- Every loaded record is schema-validated, and corruption fails closed.
- Paths come from hashed, validated identifiers, and symlinked store directories are refused.
- Errors are redacted to fixed codes.

It is local, single-host, and single-writer: one store instance serializes per-Run mutations, and stale writes are rejected. There are no leases, workers, or queues.

## Host API

```ts
const store = createFileDurabilityStore({ root });
const approvals = createApprovalEngine({ governance, clock, repository: store.approvals });
const host = createDurableRuntimeHost({ store, plan, registry, approvals, clock, reliability });

await host.execute({ runId, initialState }); // DURABLE_RUN_ALREADY_EXISTS if runId exists
await host.resume(runId);                    // after any restart
await host.getRun(runId);                    // inspection; never executes
host.getApproval(approvalId);
await host.requestCancellation(runId);
```

## Not in scope

Out of scope:

- External side effects, destructive operations, and sensitive data. They remain unsupported.
- Exactly-once execution.
- Distributed, multi-host, or HA storage.
- Queues, schedulers, and worker pools.
- Operator tooling for refused ambiguous operations, and compensation.
- Trace Runtime (Sprint 15) and long-term memory.

The two-process smoke (`pnpm --filter @aao/durability smoke`, after `pnpm build`) runs three separate Node processes over one temporary root:

1. The first process runs to a durable wait.
2. The second approves, resumes, and exits inside the Tool after the draft exists.
3. The third replays idempotently and completes. It prints `SPRINT_14_DURABLE_EXECUTION_SMOKE_OK`.
