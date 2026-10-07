# Reliability runtime

Sprint 13 adds bounded, deterministic, process-local retries and attempt timeouts to `@aao/runtime`. It does not make AAO "retry more". It makes the Runtime know exactly when a retry is safe and proves that retries cannot corrupt execution state. See [ADR-018](../decisions/ADR-018-runtime-reliability-and-bounded-retries.md).

## Execution

```text
READY
  ↓
RUNNING                      (Node and Run stay RUNNING for every attempt)
  ↓
attempt 1  ── same cloned input state, fresh AbortSignal, optional timeout race
  ├─ success → validate → commit patch once → SUCCEEDED
  ├─ approval wait → WAITING (not a failure, never retried)
  └─ failure / timeout / throw / invalid result
       ↓
   classify (structured category only)
       ↓
retryable category + retry-safe operation + budget left?
  ├─ yes → fixed delay (injected sleeper) → attempt N
  └─ no  → FAILED (NODE_EXECUTION_FAILED | INVALID_* | NODE_ATTEMPT_TIMEOUT | NODE_RETRY_EXHAUSTED)
```

The controller (`executeNodeAttempts`, internal to `@aao/runtime`) is called once per Node execution from the single `runLoop`. Approval continuation resumes the same loop, so a downstream retry-safe Node retries the same way after approval.

## Failure ownership

```text
Executor / provider adapter  → structured failure { namespace, code, category? }
Runtime Reliability          → classification, retry decision, attempt accounting, timeout
Runtime                      → lifecycle transitions, state commit, routing, snapshots
```

| Category | Retryable | Typical source |
| --- | --- | --- |
| `VALIDATION` | no | malformed result/patch, Tool request/input/output schema, invalid approval context |
| `AUTHORIZATION` | no | Authorization DENY (including Governance DENY and Agent ceiling), missing context |
| `POLICY` | no | Tool support gate (`TOOL_PERMISSION_UNSUPPORTED`) |
| `APPROVAL` | no | approval rejected / expired / cancelled |
| `TIMEOUT` | yes | attempt exceeded `attemptTimeoutMs` |
| `TRANSIENT_DEPENDENCY` | yes | Tool handler returned `retryable: true`; executor-declared transient failure |
| `RATE_LIMIT` | yes | executor-declared rate limit |
| `EXECUTION` | no | any unclassified executor failure, including every MCP failure code |
| `INTERNAL` | no | a thrown exception (never inspected) |

## Configuration

```ts
executeWorkflow({
  runId, plan, registry, initialState,
  options: {
    reliability: { policiesByNodeId: { lookup: { maxAttempts: 2, attemptTimeoutMs: 10_000, retryDelayMs: 50 } } },
    sleeper, // optional; defaults to createSystemSleeper()
  },
});
```

Hard limits: `maxAttempts ≤ 3`, `attemptTimeoutMs` 1–600000, `retryDelayMs` 0–60000. Unknown nodes, unknown fields, callbacks, or a multi-attempt policy on an Approval Node are rejected before the Run is created. Retry safety is executor metadata, not policy: `NodeExecutor.retrySafety?(node)`; Tool Node reads the registered Tool's `retrySafety` (`"safe"` only for all-`read_only` Tools).

## State rule

```text
failed attempt  ≠  business state mutation
```

Every attempt receives a fresh clone of the same authoritative state and revision. A patch is applied only from the single accepted successful attempt, so `RunState.revision` increments at most once per Node regardless of attempts.

## Safety rule

```text
retryable failure + unsafe operation = NO RETRY
```

Retries cannot create authority: authorization and policy failures are non-retryable, and unsupported permission classes fail preflight before any Node executes.

## Timeouts and late results

The attempt promise races the injected sleeper. On timeout the attempt's `AbortSignal` is aborted (cooperative and best-effort; the Tool Node forwards it to the handler). Only the race winner reaches validation and commit. A late settlement from a timed-out attempt is ignored. The timer of a decided race is always aborted.

## Evidence

`NodeExecutionRecord.attemptCount` and `attemptFailures[{ attempt, category, causeCode }]` answer "how many attempts happened and why each failed". Failures carry `category`, `retryable`, `attempt`, `maxAttempts`, and on exhaustion `causeCode`. This is the minimal backend data a future Run inspector needs ("Attempts: 2 / 3"); it is not a Trace Runtime.

## Boundaries

- Process-local only: no durable retry accounting, crash recovery, or replay protection (Sprint 14).
- Snapshots stay schema version 2 and are never captured mid-attempt.
- Retry safety ≠ idempotency; there is no exactly-once execution.
- `external_side_effect`, `destructive`, and `sensitive_data` remain unsupported; nothing with side effects is retried.
- No backoff, jitter, circuit breaker, distributed queue, MCP reconnect, or provider retry headers.
