# ADR-021: Metrics and Audit boundaries

Status: accepted

## Context

Sprint 15 gave AAO chronological execution evidence (Trace, [ADR-020](ADR-020-trace-runtime-and-observability-boundary.md)). AAO still could not say *how a Run performed* (latency, retries, Tool and model usage, tokens, cost) or keep *accountability evidence* of who requested, decided, or was refused a security- or governance-relevant action, and when.

Two Sprint 15 questions were left open:

- **Approval timing.** Trace `approval.resolved` is emitted when the Runtime consumes a resolution, not when the human decided.
- **Latency ordering.** In durable mode, `checkpoint.created` precedes the lifecycle events of the boundary it persisted, so checkpoint timing is not execution duration.

The central risk is collapsing three different things — chronology, measurement, and accountability — into one store or letting any of them become execution authority.

## Decision

- **Three concepts, three contracts, no shared store.**

  | Concept | Purpose | Authoritative? |
  | --- | --- | --- |
  | Runtime state | current execution truth | yes |
  | Durability | restart and replay correctness | yes |
  | Governance | authority resolution | yes |
  | Approval | human decision state | yes |
  | Trace | chronological execution evidence | no |
  | Metrics | derived quantitative measurements | no |
  | Audit | immutable accountability evidence | no for execution; yes as audit evidence |

  Audit does not grant authority. Metrics do not control execution. Trace does not recover Runs.
- **One package.** `@aao/observability` gains `metrics/` and `audit/` beside the Sprint 15 Trace modules. No `@aao/metrics`, `@aao/security-audit`, or `@aao/analytics` package exists. Its only production dependencies stay `@aao/contracts` and `zod`.
- **Contracts live in `@aao/contracts`.** `AuditEvent` (schema version 1), `AuditEventDraft`, the emit-only `AuditPort`, `RunMetrics`, `AggregateMetrics`, and `ModelPricingProfile` (all schema version 1) are strict, bounded, and JSON-safe. `AuditEvent` does not reuse `TraceEvent`.
- **Metrics are a deterministic projection of Trace.**
  - Pipeline: Trace → `validateTrace` → `deriveRunMetrics` → `RunMetrics` → `aggregateRunMetrics` → `AggregateMetrics`.
  - There is no Metrics store and no mutable Metrics source of truth; Metrics can always be recomputed from Trace.
  - Projection is pure: no clock, randomness, I/O, or external call. The same Trace and the same pricing produce deep-equal output.
  - The aggregator reads `RunMetrics[]`, never Trace files and never Audit.
  - Metrics measure operational behavior, not task quality, correctness, or grounding (Evaluation, Sprint 17).
- **Missing evidence stays missing.**
  - An invalid Trace yields `METRICS_INVALID_TRACE` and no metrics, never normal-looking numbers.
  - A valid Trace whose recorder reported the Run degraded yields `traceQuality: partial`. The recorder's own `runHealth` is reused; no parallel quality source exists.
  - Unavailable measurements are `null` or a non-`complete` status, never zero: duration without a terminal event, tokens a call did not report, cost without a matching profile.
- **Latency comes from lifecycle events.** Run duration is `run.started` → terminal Run event; node attempt duration is `node.started` → the attempt's first end marker on the same attempt span. Checkpoint timing is excluded. Approval wait (`node.waiting` → Trace `approval.resolved`) is reported separately from execution and is not human response time.
- **Cost requires explicit pricing.**
  - Pricing comes only from trusted host configuration. It never comes from models, Agents, Tools, MCP, memory, workflow state, or Trace.
  - Matching is exact on registered provider + model, and on revision when the profile names one. There is no substring matching and no Internet or provider lookup.
  - Accounting uses integers: nano-units of one currency per million tokens, computed in BigInt and rounded half-up per call.
  - Unknown cost stays unknown, and partial coverage is labelled partial.
  - Modelled cost is an operational estimate, not an invoice or provider billing truth.
  - Pricing never affects execution, durability, permissions, or recovery.
- **Audit is recorded at the authoritative source boundary**, through the emit-only `AuditPort`:
  - Approval Engine: `approval.requested` when the record is created (at `requestedAt`); `approval.resolved` only after the repository's atomic `pending → approved | rejected` transition succeeded, at the record's `resolvedAt` by its `resolvedBy`; `approval.resolution_denied` for attributable refused attempts.
  - Tool Runtime: `tool.access.allowed` / `tool.access.denied` exactly where Authorization decides. Allowed means the invocation path may continue, not that the Tool succeeded. Support-gate and validation failures are not access decisions and are not audited.
  - Durable host: `run.cancellation.requested` at the attributed request and `run.cancellation.applied` when the Run actually became CANCELLED. `requestCancellation` now requires a host-attested principal. Unattributed (pre-Sprint 16) records are never given a fabricated actor.
- **Trace approval semantics are unchanged.** Trace `approval.resolved` remains Runtime-consumption chronology carrying `resolvedAt`; Audit records the authoritative resolution time. They intentionally model different facts.
- **Audit storage is separate, append-only, and hash-chained.**
  - `AuditStore` (append, getStream, getEvent, verifyStream) is separate from `TraceStore` and `DurabilityStore`. It has no update, delete, query language, or Run reconstruction.
  - Streams are explicit: `run:<runId>` in V1, leaving room for future `system`, `policy`, and `deployment` streams.
  - The sequence is contiguous from 0 per stream and continues after restart.
  - Each event carries `previousHash`, starting from a fixed all-zero genesis hash, and `eventHash = SHA-256(canonical JSON of the event without eventHash)`. The hashed content includes the sequence, stream, and `previousHash`.
  - Idempotency: the same event id with the same content is a no-op; different content is `AUDIT_EVENT_CONFLICT`, and nothing is ever overwritten.
  - A stream failing integrity verification is `AUDIT_STORE_CORRUPT` and is never extended or repaired.
  - The local file store reuses the Trace store's atomic write path: temp file, fsync, create-if-absent link, directory fsync. Paths are hashed; symlinked directories fail closed.
- **Tamper-evident, not tamper-proof.** Verification detects modified, removed, reordered, or relinked committed events. An actor with write access to the whole local stream can rewrite an entire unsigned chain consistently. There are no signatures, HSM, or external anchoring in Sprint 16.
- **Audit is evidence, never authority.** No Governance, Authorization, Approval, Runtime, Tool, or Durability path reads Audit. A forged Audit approval or allow decision has no effect. Recovery reads only the durability ledger.
- **Audit failure never changes execution.** The recorder never throws into its caller. Failures become bounded `AUDIT_*` issues and `degraded` health, with no raw exception text. An authoritative decision that already committed is never rolled back, and Audit failure never causes a retry.
- **Trace and Audit do not substitute for each other.**
  - `checkAuditCompleteness` uses Trace only to reveal missing Audit evidence. It never converts a Trace event into an Audit record.
  - Audit cannot rebuild a Run or its Metrics.
  - `ObservabilityHealth` reports Trace and Audit health separately; Metrics quality (`complete | partial | invalid`) is a third fact.
- **Audit is privacy-minimized.** Payloads are strict and limited to identifiers, reason codes, permission classes, role ids, and fingerprints. Actors are principal id and type only. Events are limited to 16 KiB and never truncated. The Trace exact-key content policy is reused as defense in depth.
- **Retention is not decided.** Trace retention and Audit retention are different concerns, and real deployments may require longer Audit retention. No retention or deletion policy is chosen, no scheduler exists, and no claim is made that Audit is permanently retained. Future deletion obligations may conflict with Audit obligations; that is a later legal and product decision.

## Consequences

- Given a valid Trace, AAO measures how a Run behaved without changing how it executes. Given a security- or accountability-sensitive action, AAO preserves privacy-minimized evidence of who did what and when without using it as authority.
- Future fail-closed Audit is possible for `external_side_effect`, `destructive`, and `sensitive_data`: a policy could require healthy mandatory Audit before execution. It is not implemented, and those permission classes remain unsupported.
- The Reliability policy fingerprint is now a Metrics dimension. Durability plan compatibility is unchanged (the Sprint 14 debt stands, documented).
- Deferred:
  - Evaluation Runtime: Sprint 17;
  - Eval analytics and CI gates: Sprint 18;
  - dashboards, Run Inspector, and Control Center: Sprints 26/27;
  - alerting, SLOs, Prometheus/OpenTelemetry exporters, SIEM integration, signed or distributed Audit, operator overrides, and retention policy.
- External side effects remain unsupported. Having Audit does not unlock them; hardening, operator recovery, integration verification, security validation, and benchmark/eval proof come first.
