# Metrics

Sprint 16, [ADR-021](../decisions/ADR-021-metrics-and-audit-boundaries.md). `@aao/observability` derives deterministic operational measurements from Trace. Metrics answer *how did the Run perform?* They never decide anything.

## Pipeline

```text
Trace (TraceStore.getRunTrace)
  ↓
validateTrace                      invalid → METRICS_INVALID_TRACE, no metrics
  ↓
deriveRunMetrics({ trace, pricing?, traceHealth? })   pure, deterministic
  ↓
RunMetrics (schema version 1)
  ↓
aggregateRunMetrics({ runs })      reads RunMetrics[], never Trace or Audit
  ↓
AggregateMetrics (schema version 1)
```

- **No Metrics store.** Metrics are always recomputable from Trace, so there is no mutable Metrics database. Caching or materialization can be added later only if it is proven necessary.
- **Pure projection.** It uses no clock, randomness, I/O, or external call. The same Trace and the same pricing give deep-equal `RunMetrics`.
- **Non-authoritative.** No execution package reads Metrics, and a forged `RunMetrics` changes nothing (tested).
- **Operational, not evaluative.** Metrics cover duration, retries, Tool and model usage, approvals, recovery, tokens, and cost. Task quality, correctness, grounding, and tool-selection quality belong to Evaluation (Sprint 17).

Contracts (`RunMetrics`, `AggregateMetrics`, `ModelPricingProfile`, `MetricRate`) live in `@aao/contracts/metrics.ts`. They are strict and JSON-safe, with no Maps or Sets, and every list is deterministically sorted.

## Completeness

Missing telemetry is never read as zero.

| Situation | Result |
| --- | --- |
| Trace fails `validateTrace` (gap, bad causality, empty, schema) | `{ ok: false, quality: "invalid", code: "METRICS_INVALID_TRACE", traceIssues }` |
| Valid Trace; recorder reported this Run degraded (`traceHealth` = `runHealth(runId)`) | `traceQuality: { status: "partial", issues: [METRICS_INCOMPLETE_TRACE] }` |
| Valid Trace, healthy or unknown recorder health | `traceQuality: complete` |
| No terminal Run event | `runStatus` `RUNNING` or `WAITING_FOR_APPROVAL`, `durationMs: null` |
| A model call without reported usage | `tokenUsage.status: partial`; the field totals are `null`; `known*` sums are explicit lower bounds |
| Usage but no matching pricing profile | tokens unchanged, `cost.status: unavailable`, `estimatedCostNanos: null` |

The status reported for a Run is what its Trace shows; `RunRecord.status` stays the only lifecycle truth.

## Latency

- **Run duration** is `run.started.occurredAt` → `run.completed | run.failed | run.cancelled`. It is never derived from `checkpoint.created`. In durable mode, a checkpoint precedes the lifecycle events of the boundary it persisted, so checkpoint timing is not execution duration. Without a terminal event, duration is `null`.
- **Node attempts** are paired by attempt span (Node + step + attempt). An attempt runs from `node.started` to its first end marker on that span: `node.completed`, `node.failed`, `node.waiting`, or `retry.scheduled`. Separate attempts are never merged.
  - A crash replay keeps its logical span and appears as its own `recoveryReplay` attempt.
  - An attempt whose end was never observed is `outcome: "open"` with `durationMs: null`.
  - A recovered attempt includes the recovery gap.
- **Approval wait** is `node.waiting` → Trace `approval.resolved`, which is the Runtime's consumption of the resolution, on the same Trace clock. This is time the Run was blocked on approval. It is not executor latency and not human response time. The authoritative decision time is in Audit (`approval.resolved.occurredAt = resolvedAt`). It is never mixed with Trace-clock durations, because the two come from different clocks.
  - `approvalWaitDurationMs` is the sum over waits. It is `null` while any wait is unresolved in the trace.
  - `durationExcludingApprovalWaitMs` is `durationMs − approvalWaitDurationMs`. It includes any process downtime.

## Retries, failures, Tools, models, Agents

- **Retries** are derived only from explicit retry evidence: `scheduled` (`retry.scheduled`), `exhausted` (`retry.exhausted`), and `nodesRetried` (distinct Node + step).
- **Failures** use the existing `FailureCategory` taxonomy only.
  - `failedAttempts` = `retry.scheduled` + `node.failed`.
  - `byCategory` and `byCode` use the most specific existing code: the attempt cause, else the executor code, else the Runtime code.
  - `detectedEvents` counts `failure.detected`. `runFailure` is the Run outcome.
- **Tools.**
  - `physicalInvocations` counts `tool.call.started`, i.e. the handler was invoked.
  - `logicalExecutions` counts distinct `toolExecutionId`s. A durable crash replay is 2 physical invocations and 1 logical execution.
  - `completed`, `failed`, and `blocked` count the matching events. A blocked call never invoked the handler.
  - `byTool` is keyed by exact id + version.
- **Models.**
  - Calls are counted as started, completed, and failed.
  - `byModel` is keyed by the registered `{ provider, model, revision? }`. Calls without registered identity are bucketed as `identity: null`, never parsed from a binding id.
  - Token sums come only from recorded usage on `model.call.completed`, never estimated from text. A total is non-null only when every call reported it. Failed calls report no usage, so they make accounting `partial`.
- **Agents.** `executions`, `iterations`, `completed`, and `failed` come from Agent events. No semantic quality is derived.
- **Approvals, durability, state.**
  - Approvals: requested, approved, rejected, expired, cancelled, and pending counts.
  - Durability: checkpoints, recovery starts, replays, reused outcomes, blocks, and completions. These counts do not prove durability correctness.
  - State: update count and the final revision, taken from the terminal event when present. State values never appear.
- **Dimensions** are optional and present only when the Trace carries them: `reliabilityPolicyFingerprint`, and host release metadata (`releaseId`, `gitSha`, `environment`). The fingerprint enables policy A/B comparison without changing execution or durability compatibility.

## Pricing and cost

`ModelPricingProfile`:

```text
{ schemaVersion: 1, profileId, profileVersion, provider, model, revision?, currency (ISO 4217),
  inputNanosPerMillionTokens, outputNanosPerMillionTokens }   // integers
```

- **Authority.** Profiles come only from trusted host or version-controlled configuration passed to `deriveRunMetrics`. They never come from model, Agent, Tool, MCP, memory, workflow state, or Trace. Invalid or ambiguous sets are refused with `METRICS_INVALID_PRICING_PROFILE`: schema failure, duplicate identity, mixed currency, or non-integer price.
- **Matching is exact.** An exact revision match wins. A profile without a revision matches any revision of the same provider + model. A profile with a revision never matches a different or absent revision. There is no substring matching and no lookup.
- **Arithmetic.** Per call: `(input × inPrice + output × outPrice) / 1,000,000`, computed in BigInt and rounded half-up once to a whole nano-unit, then summed. A total beyond exact JSON-integer range is refused (`METRICS_COST_OVERFLOW`), never clamped.
- **Coverage.**
  - `complete`: every call was priced, or there were no model calls.
  - `partial`: some calls were priced. `estimatedCostNanos` is `null`, and only `knownEstimatedCostNanos` is reported.
  - `unavailable`: no calls were priced.
  - Unpriced reasons: `MODEL_IDENTITY_MISSING`, `PRICING_PROFILE_NOT_FOUND`, `USAGE_MISSING`, `CALL_FAILED`.
- **Not billing.** This is modelled operational cost. It is not an invoice or provider billing truth: negotiated rates, cache and batch discounts, provider rounding, taxes, and credits are not represented. The same Trace can be re-priced for analysis. Historically frozen billing would be a separate requirement.

## Aggregation and denominators

`aggregateRunMetrics({ runs })` validates every `RunMetrics`. It rejects duplicates (`METRICS_DUPLICATE_RUN`) and invalid input (`METRICS_INVALID_RUN_METRICS`). Every ratio is `{ numerator, denominator, value }`, where `value` is `null` when the denominator is 0.

| Rate | Definition |
| --- | --- |
| `successRate` / `failureRate` / `cancellationRate` | completed / failed / cancelled Runs ÷ terminal Runs (by Run outcome, never failure-event count) |
| `retries.retryingRunRate` | Runs with ≥ 1 `retry.scheduled` ÷ all Runs (`totalRetries` reported separately) |
| `approvals.approvalRequiredRunRate` | Runs with ≥ 1 `approval.requested` ÷ all Runs (decisions as a separate breakdown) |
| `recovery.recoveredRunRate` | Runs with ≥ 1 `recovery.started` ÷ durable Runs (Runs whose trace has ≥ 1 `checkpoint.created`) |
| `cost.costCoverage` | Runs with complete modelled cost ÷ all Runs |

- **Latency** is reported only over Runs with a terminal duration (`latency.eligibleRuns`); missing latency is never coerced to 0.
- **Percentiles use nearest-rank.** For `n` ascending values, the p-th percentile (integer p) is the value at rank `ceil(p × n / 100)`, computed in integer arithmetic. It is always an observed value and never interpolated; no library default applies, and an empty sample has none. With values `[5, 8, 10, 20]` s, p50 is 8 s and p95 is 20 s.
- **Tokens.** A total exists only when every Run's total exists.
- **Cost** is never summed across currencies (`METRICS_CURRENCY_MISMATCH`).
- **Breakdowns** are by model identity, Tool id + version, workflow id + version (versions never merged), and reliability-policy fingerprint, each deterministically sorted.

## Boundaries

- **No Metrics SDK, exporter, dashboard, chart, alert, threshold, or SLO.** No Prometheus client, OpenTelemetry metrics SDK, StatsD, or vendor agent is added. Future exporters can map from these contracts.
- **No Eval Runtime, grader, dataset, or CI Eval gate.** Those are Sprints 17/18.
- **Fixtures.** Canonical fixtures in `packages/observability/test/fixtures/metrics/` are deterministic and sanitized, for Sprints 17/18: `simple_success`, `retry_then_success`, `approval_wait`, `approval_rejected`, `durable_recovery`, `tool_denied`, `trace_partial`, `cost_priced`, `cost_unpriced`.
