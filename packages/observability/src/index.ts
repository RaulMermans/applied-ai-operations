// @aao/observability — AAO's evidence layer. Three separate concepts:
//
// - Trace (Sprint 15; docs/architecture/trace-runtime.md, ADR-020):
//   chronological operational evidence. The recorder implements the
//   Runtime's emit-only trace port; TraceStore (in-memory, local file),
//   Trace-contract validation, Runtime comparison, reconstruction.
// - Metrics (Sprint 16; docs/architecture/metrics.md, ADR-021): pure,
//   deterministic projections of validated Trace plus explicit trusted
//   pricing. No Metrics store: they are always recomputable from Trace.
// - Audit (Sprint 16; docs/architecture/audit.md, ADR-021): immutable,
//   hash-chained accountability evidence recorded at authoritative source
//   boundaries through the emit-only AuditPort; AuditStore (in-memory,
//   local file) is separate from TraceStore.
//
// None of them is execution authority: nothing in AAO reads Trace, Metrics,
// or Audit to decide anything. Depends only on @aao/contracts. No Eval
// Runtime, OpenTelemetry SDK or exporter, metrics SDK, vendor backend,
// alerting, or UI.

export { deriveTraceId, deriveSpanId, deriveEventId, reliabilityPolicyFingerprint } from "./identity.js";
export { FORBIDDEN_TRACE_KEYS, findForbiddenTraceKeys, isTraceJsonSafe, serializeTraceEvent, checkTraceEvent, type TraceEventCheck } from "./content-policy.js";
export { TRACE_ISSUE_CODES, TraceStoreError, createInMemoryTraceStore, type TraceIssueCode, type TraceStore } from "./store.js";
export { createFileTraceStore } from "./file-store.js";
export { createTraceRecorder, createSystemTraceClock, TraceReleaseSchema, MAX_RECORDED_ISSUES, type TraceRecorder, type TraceRecorderOptions, type TraceClock, type TraceHealth, type TraceIssue, type TraceRelease } from "./recorder.js";
export {
  TRACE_DIAGNOSTIC_CODES,
  TRACE_POST_TERMINAL_EVENT_TYPES,
  validateTrace,
  compareTraceWithExecution,
  reconstructRunTrace,
  type TraceDiagnostic,
  type TraceDiagnosticCode,
  type TraceValidationResult,
  type ComparableExecution,
  type TraceRun,
} from "./validator.js";

export { deriveRunMetrics, type DeriveRunMetricsParams, type RunMetricsProjection } from "./metrics/run-metrics.js";
export { aggregateRunMetrics, rate, type AggregateMetricsResult } from "./metrics/aggregate.js";
export { nearestRankPercentile } from "./metrics/percentile.js";
export { validatePricingProfiles, matchPricingProfile, modelCallCostNanos, type PricingValidation } from "./metrics/pricing.js";

export { deriveAuditEventId, computeAuditEventHash, serializeAuditEvent, checkAuditEvent, type AuditEventCheck } from "./audit/event.js";
export { AUDIT_ISSUE_CODES, AuditStoreError, createInMemoryAuditStore, type AuditIssueCode, type AuditStore } from "./audit/store.js";
export { createFileAuditStore } from "./audit/file-store.js";
export { createAuditRecorder, createSystemAuditClock, MAX_RECORDED_AUDIT_ISSUES, type AuditRecorder, type AuditClock, type AuditHealth, type AuditIssue } from "./audit/recorder.js";
export { AUDIT_DIAGNOSTIC_CODES, validateAuditStream, type AuditDiagnostic, type AuditDiagnosticCode, type AuditValidationResult } from "./audit/validator.js";

export { summarizeObservabilityHealth, checkAuditCompleteness, type ObservabilityHealth, type AuditCompleteness, type MissingAuditEvidence } from "./health.js";
