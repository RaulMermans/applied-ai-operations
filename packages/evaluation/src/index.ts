// @aao/evaluation — AAO's Evaluation Runtime (Sprint 17; ADR-022,
// docs/architecture/evaluation-runtime.md). It observes and judges AAO
// execution evidence — Trace, Runtime execution state, Trace-derived
// Metrics, Audit, and (for semantic judges only) an explicit bounded
// subject — and returns serializable, versioned EvalResults.
//
// Evaluation is never execution authority. Nothing here can grant
// permission, approve, change Run state, call a Tool, retry, route,
// recover, modify Governance, or enable a side effect, and no execution
// package depends on this one. Definitions select trusted, code-registered
// graders by exact id + version; Eval data can never load code. Graders
// target canonical AAO semantics, never a framework or provider. Depends
// only on @aao/contracts, @aao/observability (canonical validators), yaml,
// and zod. No Eval store, analytics, CI gate, or model SDK.

export {
  EvalEvidenceBundleSchema,
  EvalSubjectSchema,
  ExecutionEvidenceSchema,
  MAX_EVAL_TRACE_EVENTS,
  MAX_EVAL_AUDIT_EVENTS,
  MAX_EVAL_SUBJECT_BYTES,
  MAX_EVAL_SUBJECT_CONTEXT_BYTES,
  evidenceFingerprint,
  evidenceRefs,
  freezeEvidence,
  isEvalJsonSafe,
  type DeepReadonly,
  type EvalEvidenceBundle,
  type EvalSubject,
  type ExecutionEvidence,
} from "./evidence.js";
export { assertion, gradeError, judged, zodConfig, type EvalGrader, type GraderContext, type GraderOutcome } from "./grader.js";
export { EVALUATOR_REGISTRY_ERROR_CODES, EvaluatorRegistryError, createEvaluatorRegistry, type EvaluatorRegistry, type EvaluatorRegistryErrorCode, type GraderLookup } from "./registry.js";
export { EvalInputError, deriveEvalResultId, evaluate, failedEvaluation, type EvaluateParams } from "./runner.js";
export {
  EvalDefinitionFileSchema,
  MAX_EVAL_DEFINITIONS,
  MAX_EVAL_SOURCE_BYTES,
  createStaticEvidenceResolver,
  parseEvalDataset,
  parseEvalDefinitions,
  runEvalDataset,
  validateEvalDataset,
  type EvalSourceFormat,
  type EvalSourceIssue,
  type EvalSourceResult,
  type EvidenceResolver,
  type RunEvalDatasetResult,
} from "./dataset.js";
export {
  deterministicGraders,
  createApprovalComplianceGrader,
  createAuthorizationComplianceGrader,
  createMetricsThresholdGrader,
  createModelJudgeGrader,
  createRetryBehaviorGrader,
  createRunOutcomeGrader,
  createStateAssertionGrader,
  createToolUsageGrader,
  createTraceContractGrader,
  createTrajectoryGrader,
  MODEL_JUDGE_LIMITS,
  type ModelJudgePort,
  type ModelJudgeRequest,
  type ModelJudgeResult,
} from "./graders/index.js";
