// @aao/observability — AAO's Trace Runtime (Sprint 15; see
// docs/architecture/trace-runtime.md and ADR-020). Owns the trace recorder
// (the canonical implementation of the Runtime's emit-only trace port),
// deterministic trace/span/event identity, the metadata-only content
// policy, the TraceStore port with in-memory and local file
// implementations, Trace-contract validation, Runtime comparison, and
// reconstruction. Trace is an observational projection of authoritative
// execution: nothing in AAO reads it to decide anything. Depends only on
// @aao/contracts. No Metrics, Audit, Eval Runtime, OpenTelemetry SDK or
// exporter, vendor backend, or UI.

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
