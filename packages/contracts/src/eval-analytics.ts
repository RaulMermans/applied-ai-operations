import { z } from "zod";
import { entityVersionSchema, identifierSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";
import {
  EVAL_LIMITS,
  EvalCategorySchema,
  EvalDatasetRefSchema,
  EvalErrorCodeSchema,
  EvalExpectedVerdictSchema,
  EvalGraderRefSchema,
  EvalModeSchema,
  EvalReasonCodeSchema,
  EvalRefSchema,
  EvalResultStatusSchema,
  EvalTargetTypeSchema,
  findForbiddenEvalCodeKeys,
  type EvalCategory,
} from "./evaluation.js";

/**
 * Evaluation analytics, baseline comparison, and CI quality-gate contracts
 * (Sprint 18, ADR-023, docs/architecture/eval-analytics-ci.md).
 *
 * These describe *engineering and release quality*: they consume
 * EvalResults and never become execution authority. Nothing here is a Run
 * status, a permission, an Approval, a retry budget, or Memory. A gate
 * PASS changes nothing in the Runtime; the only effect a gate has is the
 * exit code of a developer/CI command.
 *
 * Reports carry identifiers, codes, statuses, counts, scores, and
 * fingerprints only — never Tool input/output, prompts, model output, state
 * values, Approval subjects, or credentials.
 */

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1);
const sortedUnique = (values: readonly string[]) => values.join("\n") === [...new Set(values)].sort().join("\n");

export const EVAL_ANALYTICS_LIMITS = Object.freeze({
  maxSuiteCases: EVAL_LIMITS.maxCasesPerDataset,
  maxReasonCodes: 32,
  maxFindings: 256,
  maxWarnings: 32,
  maxWarningRules: 16,
  maxPolicyCategories: 10,
  maxCompatibleDatasetVersions: 8,
  /** Serialized size of one gate policy. */
  maxPolicyBytes: 16 * 1024,
  maxAnalyticsRuns: 64,
});

/**
 * Categories whose expectation mismatch is always a hard gate failure,
 * whatever a policy says: Approval bypass, Authorization bypass, safety,
 * and Trace integrity regressions are never warnings. A policy may add
 * categories; it can never remove these.
 */
export const EVAL_CANONICAL_CRITICAL_CATEGORIES: readonly EvalCategory[] = Object.freeze(["approval", "authorization", "safety", "trace_contract"]);

/** Analytics and gate diagnostics. They are not EvalResult error codes and never Runtime failure codes. */
export const EVAL_GATE_DIAGNOSTIC_CODES = [
  "EVAL_BASELINE_INVALID",
  "EVAL_BASELINE_INCOMPATIBLE",
  "EVAL_COMPARISON_MISSING_CASE",
  "EVAL_FIXTURE_FINGERPRINT_MISMATCH",
  "EVAL_GATE_POLICY_INVALID",
  "EVAL_GATE_CRITICAL_REGRESSION",
  "EVAL_GATE_CRITICAL_MISMATCH",
  "EVAL_GATE_EXPECTATION_MISMATCH",
  "EVAL_GATE_REGRESSION_LIMIT",
  "EVAL_GATE_UNEXPECTED_ERROR",
  "EVAL_GATE_INCOMPLETE_EVIDENCE",
  "EVAL_GATE_METRIC_REGRESSION",
  /** A suite report or baseline whose derived fields (counts, verdicts, breakdown, findings, fingerprints) disagree with its own case data. */
  "EVAL_SUITE_REPORT_INCONSISTENT",
] as const;
export const EvalGateDiagnosticCodeSchema = z.enum(EVAL_GATE_DIAGNOSTIC_CODES);
export type EvalGateDiagnosticCode = z.infer<typeof EvalGateDiagnosticCodeSchema>;

// --- Comparison identity ----------------------------------------------------------------

/**
 * The *logical* identity of one evaluation: what was judged, by which exact
 * criterion and grader, as which dataset case, in which mode. `resultId`
 * is observation identity (it includes the evidence) and is never a
 * comparison key. Run, Trace, provider, model, result id, and evidence
 * fingerprint are deliberately absent, so the same case judged yesterday,
 * today, on provider A or B, or in Run 123 or 456 has one comparison key.
 */
export const EvalComparisonIdentitySchema = z
  .object({
    evalRef: EvalRefSchema,
    graderRef: EvalGraderRefSchema,
    datasetRef: EvalDatasetRefSchema,
    caseId: identifierSchema.max(128),
    mode: EvalModeSchema,
    targetType: EvalTargetTypeSchema,
  })
  .strict();
export type EvalComparisonIdentity = z.infer<typeof EvalComparisonIdentitySchema>;

/** `evk.` + SHA-256 over the canonical comparison identity. */
export const EvalComparisonKeySchema = z.string().regex(/^evk\.[a-f0-9]{64}$/);
/** `evs.` + SHA-256 over the comparison key and the normalized semantic judgment. Distinct from the evidence fingerprint. */
export const SemanticVerdictFingerprintSchema = z.string().regex(/^evs\.[a-f0-9]{64}$/);

// --- Case expectation verdict ------------------------------------------------------------

/**
 * Did the *regression case* behave as declared? This is not
 * `EvalResult.status` (the evaluator's judgment of the system): a negative
 * case expecting `failed(APPROVAL_BYPASSED)` whose result is exactly that is
 * `MATCHED`. `MISMATCHED`: a trustworthy judgment that differs from the
 * expectation. `ERROR`: the evaluator could not judge where the case did
 * not expect exactly that error — infrastructure inability, never success.
 */
export const CaseExpectationVerdictSchema = z.enum(["MATCHED", "MISMATCHED", "ERROR"]);
export type CaseExpectationVerdict = z.infer<typeof CaseExpectationVerdictSchema>;

/** The bounded semantic outcome of one EvalResult: status, error code, failed-assertion reason codes, score. */
export const EvalVerdictSummarySchema = z
  .object({
    status: EvalResultStatusSchema,
    errorCode: EvalErrorCodeSchema.optional(),
    reasonCodes: z.array(EvalReasonCodeSchema).max(EVAL_ANALYTICS_LIMITS.maxReasonCodes).refine(sortedUnique, "reasonCodes must be sorted and unique"),
    score: z.number().min(0).max(1).optional(),
  })
  .strict();
export type EvalVerdictSummary = z.infer<typeof EvalVerdictSummarySchema>;

/** A measurement is a value only when its evidence is complete; partial or unavailable evidence is never a number. */
export const EvalMeasurementSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("complete"), value: z.number().nonnegative() }).strict(),
  z.object({ status: z.literal("partial") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);
export type EvalMeasurement = z.infer<typeof EvalMeasurementSchema>;

export const EvalSuiteCaseSchema = z
  .object({
    caseId: identifierSchema.max(128),
    comparisonKey: EvalComparisonKeySchema,
    identity: EvalComparisonIdentitySchema,
    categories: z.array(EvalCategorySchema).max(EVAL_LIMITS.maxCategories),
    expected: EvalExpectedVerdictSchema,
    actual: EvalVerdictSummarySchema,
    expectation: CaseExpectationVerdictSchema,
    semanticVerdictFingerprint: SemanticVerdictFingerprintSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.identity.caseId !== entry.caseId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", "caseId"], message: "identity names the case" });
  });
export type EvalSuiteCase = z.infer<typeof EvalSuiteCaseSchema>;

// --- Operational summary (advisory) ----------------------------------------------------------

export const EVAL_OPERATIONAL_METRICS = ["runDurationP95Ms", "estimatedCostNanos", "knownEstimatedCostNanos", "retryingRunRate", "totalTokens", "knownTotalTokens", "toolCalls"] as const;
export const EvalOperationalMetricSchema = z.enum(EVAL_OPERATIONAL_METRICS);
export type EvalOperationalMetric = z.infer<typeof EvalOperationalMetricSchema>;

/**
 * Operational measurements projected from the canonical `AggregateMetrics`
 * of the evaluated evidence (the host aggregates with
 * `@aao/observability`; Evaluation never derives Metrics). Partial or
 * unavailable evidence is reported as such, never as zero.
 */
export const EvalOperationalSummarySchema = z
  .object({
    runsObserved: count,
    metrics: z.object(Object.fromEntries(EVAL_OPERATIONAL_METRICS.map((metric) => [metric, EvalMeasurementSchema])) as Record<EvalOperationalMetric, typeof EvalMeasurementSchema>).strict(),
  })
  .strict();
export type EvalOperationalSummary = z.infer<typeof EvalOperationalSummarySchema>;

/** Optional trusted, host-supplied context. Never part of a comparison key, fingerprint, or verdict. */
export const EvalReportMetadataSchema = z
  .object({
    generatedAt: isoTimestampSchema.optional(),
    gitSha: z.string().regex(/^[a-f0-9]{7,64}$/).optional(),
    releaseId: identifierSchema.optional(),
    environment: identifierSchema.max(64).optional(),
  })
  .strict();
export type EvalReportMetadata = z.infer<typeof EvalReportMetadataSchema>;

// --- Suite report (schema version 1) -------------------------------------------------------

const RawStatusesSchema = z.object({ passed: count, failed: count, error: count }).strict();

export const EvalSuiteSummarySchema = z
  .object({
    casesTotal: count,
    expectationsMatched: count,
    expectationsMismatched: count,
    expectationErrors: count,
    /** matched / casesTotal. */
    expectationMatchRate: rate,
    /** Raw EvalResult statuses. A `failed` result is not a failed case: negative cases expect it. */
    rawStatuses: RawStatusesSchema,
    /** Mean score over results that report one; `unavailable` when none does. */
    averageScore: EvalMeasurementSchema,
  })
  .strict();
export type EvalSuiteSummary = z.infer<typeof EvalSuiteSummarySchema>;

export const EvalCriticalFindingSchema = z
  .object({ caseId: identifierSchema.max(128), comparisonKey: EvalComparisonKeySchema, categories: z.array(EvalCategorySchema).max(EVAL_LIMITS.maxCategories), expectation: CaseExpectationVerdictSchema })
  .strict();

/**
 * One deterministic dataset execution, judged against every case's
 * declared expectation. `semanticFingerprint` covers the cases' comparison
 * keys, expectation verdicts, and semantic verdict fingerprints only —
 * never metadata, operational measurements, Run ids, or evidence.
 */
export const EvalSuiteReportSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    datasetRef: EvalDatasetRefSchema,
    cases: z.array(EvalSuiteCaseSchema).min(1).max(EVAL_ANALYTICS_LIMITS.maxSuiteCases),
    summary: EvalSuiteSummarySchema,
    categoryBreakdown: z.array(z.object({ category: EvalCategorySchema, total: count, matched: count, mismatched: count, errors: count }).strict()).max(16),
    /** Unmatched cases in a canonical critical category (Approval, Authorization, safety, Trace integrity). */
    criticalFindings: z.array(EvalCriticalFindingSchema).max(EVAL_ANALYTICS_LIMITS.maxSuiteCases),
    operational: EvalOperationalSummarySchema.optional(),
    semanticFingerprint: hex64,
    metadata: EvalReportMetadataSchema.optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    const ids = report.cases.map((entry) => entry.caseId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: "case ids must be unique" });
    if (report.cases.some((entry) => entry.identity.datasetRef.id !== report.datasetRef.id || entry.identity.datasetRef.version !== report.datasetRef.version)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: "every case belongs to the report's dataset" });
  });
export type EvalSuiteReport = z.infer<typeof EvalSuiteReportSchema>;

// --- Baseline (schema version 1) -------------------------------------------------------------

/**
 * One deliberately accepted evaluation state, version-controlled under
 * `evals/baselines/`. A baseline is approved *evidence for comparison*: it
 * is never execution policy, never Memory, never loaded into a model
 * context, and never written by CI. It changes only through an explicit,
 * reviewed repository change with a new pinned fingerprint in the gate
 * policy that reads it.
 */
export const EvalBaselineSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: identifierSchema,
    version: entityVersionSchema,
    description: z.string().min(1).max(2000).optional(),
    datasetRef: EvalDatasetRefSchema,
    generatedFrom: z.object({ suiteSemanticFingerprint: hex64 }).strict(),
    caseExpectations: z.array(EvalSuiteCaseSchema).min(1).max(EVAL_ANALYTICS_LIMITS.maxSuiteCases),
    suiteSummary: EvalSuiteSummarySchema,
    performanceBaseline: EvalOperationalSummarySchema.optional(),
  })
  .strict()
  .superRefine((baseline, ctx) => {
    const ids = baseline.caseExpectations.map((entry) => entry.caseId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["caseExpectations"], message: "case ids must be unique" });
    if (baseline.caseExpectations.some((entry) => entry.identity.datasetRef.id !== baseline.datasetRef.id || entry.identity.datasetRef.version !== baseline.datasetRef.version)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["caseExpectations"], message: "every case belongs to the baseline's dataset" });
  });
export type EvalBaseline = z.infer<typeof EvalBaselineSchema>;

/** A gate policy pins its baseline by id, version, and content fingerprint: an edited baseline file is invalid until re-pinned. */
export const EvalBaselineRefSchema = z.object({ id: identifierSchema, version: entityVersionSchema, fingerprint: hex64 }).strict();
export type EvalBaselineRef = z.infer<typeof EvalBaselineRefSchema>;

// --- Comparison -------------------------------------------------------------------------

/**
 * `UNCHANGED_MATCH`/`UNCHANGED_MISMATCH`: comparable, same expectation
 * outcome. `REGRESSION`: the baseline matched its expectation and the
 * candidate does not. `IMPROVEMENT`: the reverse. `NEW_CASE`: only the
 * candidate has it. `MISSING_CASE`: the approved baseline has it and the
 * candidate did not execute it. `INCOMPATIBLE`: same case slot, different
 * logical identity (Eval, grader, or dataset version, mode, target) with
 * no explicit compatibility rule — never silently a regression.
 */
export const EvalComparisonClassificationSchema = z.enum(["UNCHANGED_MATCH", "UNCHANGED_MISMATCH", "REGRESSION", "IMPROVEMENT", "NEW_CASE", "MISSING_CASE", "INCOMPATIBLE"]);
export type EvalComparisonClassification = z.infer<typeof EvalComparisonClassificationSchema>;

export const EvalFindingSeveritySchema = z.enum(["critical", "required", "advisory"]);
export type EvalFindingSeverity = z.infer<typeof EvalFindingSeveritySchema>;

const OutcomeSchema = z.object({ expectation: CaseExpectationVerdictSchema, actual: EvalVerdictSummarySchema }).strict();

/** Identity fields that made a case slot incompatible. */
export const EvalIncompatibleFieldSchema = z.enum(["evalRef.id", "evalRef.version", "graderRef.id", "graderRef.version", "datasetRef.id", "datasetRef.version", "mode", "targetType"]);

export const EvalComparisonEntrySchema = z
  .object({
    caseId: identifierSchema.max(128),
    classification: EvalComparisonClassificationSchema,
    comparisonKey: EvalComparisonKeySchema,
    categories: z.array(EvalCategorySchema).max(EVAL_LIMITS.maxCategories * 2),
    baseline: OutcomeSchema.optional(),
    candidate: OutcomeSchema.optional(),
    incompatibleFields: z.array(EvalIncompatibleFieldSchema).max(8).optional(),
    /** candidate − baseline score, only for comparable cases that both report a score. */
    scoreDelta: z.number().min(-1).max(1).optional(),
  })
  .strict();
export type EvalComparisonEntry = z.infer<typeof EvalComparisonEntrySchema>;

/**
 * A bounded candidate for human review — never an automatic dataset,
 * baseline, Skill, or Memory change. Promotion into a regression case is
 * a deliberate repository change.
 */
export const RegressionFindingSchema = z
  .object({
    caseId: identifierSchema.max(128),
    comparisonKey: EvalComparisonKeySchema,
    classification: z.enum(["REGRESSION", "MISSING_CASE", "INCOMPATIBLE", "NEW_CASE", "UNCHANGED_MISMATCH"]),
    categories: z.array(EvalCategorySchema).max(EVAL_LIMITS.maxCategories * 2),
    severity: EvalFindingSeveritySchema,
    baselineOutcome: OutcomeSchema.optional(),
    candidateOutcome: OutcomeSchema.optional(),
    reasonCodes: z.array(EvalReasonCodeSchema).max(EVAL_ANALYTICS_LIMITS.maxReasonCodes),
  })
  .strict();
export type RegressionFinding = z.infer<typeof RegressionFindingSchema>;

const ComparisonSummarySchema = z.object({ unchangedMatch: count, unchangedMismatch: count, regressions: count, improvements: count, newCases: count, missingCases: count, incompatible: count }).strict();

export const EvalComparisonReportSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    baseline: z.object({ id: identifierSchema, version: entityVersionSchema, datasetRef: EvalDatasetRefSchema }).strict(),
    candidateDatasetRef: EvalDatasetRefSchema,
    entries: z.array(EvalComparisonEntrySchema).max(EVAL_ANALYTICS_LIMITS.maxSuiteCases * 2),
    summary: ComparisonSummarySchema,
    findings: z.array(RegressionFindingSchema).max(EVAL_ANALYTICS_LIMITS.maxSuiteCases * 2),
  })
  .strict();
export type EvalComparisonReport = z.infer<typeof EvalComparisonReportSchema>;

// --- Gate policy (schema version 1) ----------------------------------------------------------

export const EVAL_GATE_WARNING_METRICS = [...EVAL_OPERATIONAL_METRICS, "averageScore"] as const;
export const EvalGateWarningMetricSchema = z.enum(EVAL_GATE_WARNING_METRICS);
export type EvalGateWarningMetric = z.infer<typeof EvalGateWarningMetricSchema>;

/**
 * A measured regression rule. `advisory` rules warn; `required` rules
 * hard-fail. Missing or partial evidence never passes: it warns
 * (`onMissingEvidence: warn`, the advisory default) or fails (`fail`, the
 * required default; a required rule cannot be downgraded to `warn`).
 * Direction is fixed per metric: cost, duration, tokens, retries, and Tool
 * calls regress upward; `averageScore` regresses downward.
 */
export const EvalGateMetricRuleSchema = z
  .object({
    id: identifierSchema.max(64),
    metric: EvalGateWarningMetricSchema,
    maxRegressionPercent: z.number().min(0).max(1000),
    severity: z.enum(["advisory", "required"]),
    onMissingEvidence: z.enum(["warn", "fail"]).optional(),
  })
  .strict()
  .refine((rule) => !(rule.severity === "required" && rule.onMissingEvidence === "warn"), "a required measurement cannot be downgraded to a warning when its evidence is missing");
export type EvalGateMetricRule = z.infer<typeof EvalGateMetricRuleSchema>;

/**
 * Strict, versioned gate data. The gate evaluator is deterministic code;
 * no model decides whether a regression is acceptable. Changing a
 * threshold, a category, the dataset, the baseline, or missing-evidence
 * behavior requires a new policy `version`. No code, module paths, or
 * commands: the same no-code rule as Eval definitions applies.
 */
export const EvalGatePolicySchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: identifierSchema,
    version: entityVersionSchema,
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000).optional(),
    datasetRef: EvalDatasetRefSchema,
    baselineRef: EvalBaselineRefSchema,
    hardFail: z
      .object({
        requireAllCasesPresent: z.boolean(),
        requireExpectationMatchRate: rate,
        maxRegressions: count,
        criticalCategories: z.array(EvalCategorySchema).min(EVAL_CANONICAL_CRITICAL_CATEGORIES.length).max(EVAL_ANALYTICS_LIMITS.maxPolicyCategories),
      })
      .strict(),
    /** Explicit, reviewed compatibility: baseline dataset versions whose cases may be compared with this policy's dataset version. */
    comparison: z.object({ compatibleBaselineDatasetVersions: z.array(entityVersionSchema).min(1).max(EVAL_ANALYTICS_LIMITS.maxCompatibleDatasetVersions) }).strict().optional(),
    warnings: z.array(EvalGateMetricRuleSchema).max(EVAL_ANALYTICS_LIMITS.maxWarningRules),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const categories = policy.hardFail.criticalCategories;
    if (new Set(categories).size !== categories.length) issue(["hardFail", "criticalCategories"], "critical categories must be unique");
    for (const required of EVAL_CANONICAL_CRITICAL_CATEGORIES) if (!categories.includes(required)) issue(["hardFail", "criticalCategories"], `"${required}" is always critical and cannot be removed`);
    const ruleIds = policy.warnings.map((rule) => rule.id);
    if (new Set(ruleIds).size !== ruleIds.length) issue(["warnings"], "rule ids must be unique");
    if (new TextEncoder().encode(JSON.stringify(policy)).length > EVAL_ANALYTICS_LIMITS.maxPolicyBytes) issue([], `policy exceeds ${EVAL_ANALYTICS_LIMITS.maxPolicyBytes} bytes`);
    const forbidden = findForbiddenEvalCodeKeys(policy);
    if (forbidden.length > 0) issue([], `policy may not carry code-bearing keys: ${forbidden.slice(0, 4).join(", ")}`);
  });
export type EvalGatePolicy = z.infer<typeof EvalGatePolicySchema>;

// --- Gate decision (schema version 1) ----------------------------------------------------------

export const EvalGateHardFailureSchema = z
  .object({
    code: EvalGateDiagnosticCodeSchema,
    rule: identifierSchema.max(64),
    caseIds: z.array(identifierSchema.max(128)).max(EVAL_ANALYTICS_LIMITS.maxSuiteCases).optional(),
    metric: EvalGateWarningMetricSchema.optional(),
  })
  .strict();
export type EvalGateHardFailure = z.infer<typeof EvalGateHardFailureSchema>;

export const EvalGateWarningSchema = z
  .object({
    code: z.enum(["EVAL_GATE_METRIC_REGRESSION", "EVAL_GATE_INCOMPLETE_EVIDENCE"]),
    ruleId: identifierSchema.max(64),
    metric: EvalGateWarningMetricSchema,
    baseline: z.number().nonnegative().nullable(),
    candidate: z.number().nonnegative().nullable(),
    /** Rounded to two decimals; null when not computable (missing evidence or a zero baseline). */
    changePercent: z.number().nullable(),
  })
  .strict();
export type EvalGateWarning = z.infer<typeof EvalGateWarningSchema>;

/**
 * The deterministic quality decision for one candidate suite. It is not a
 * Run status and carries no authority: it cannot approve, authorize,
 * trigger a Tool, change Run state, mark replay safe, or alter retries.
 * `passed` is false exactly when a hard failure exists; warnings alone pass.
 */
export const EvalGateDecisionSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    policyRef: z.object({ id: identifierSchema, version: entityVersionSchema }).strict(),
    baselineRef: z.object({ id: identifierSchema, version: entityVersionSchema }).strict(),
    datasetRef: EvalDatasetRefSchema,
    passed: z.boolean(),
    outcome: z.enum(["PASS", "WARN", "FAIL"]),
    hardFailures: z.array(EvalGateHardFailureSchema).max(EVAL_ANALYTICS_LIMITS.maxFindings),
    warnings: z.array(EvalGateWarningSchema).max(EVAL_ANALYTICS_LIMITS.maxWarnings),
    candidateSummary: EvalSuiteSummarySchema,
    comparisonSummary: ComparisonSummarySchema,
    findings: z.array(RegressionFindingSchema).max(EVAL_ANALYTICS_LIMITS.maxSuiteCases * 2),
    metadata: EvalReportMetadataSchema.optional(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.passed !== (decision.hardFailures.length === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["passed"], message: "a gate passes exactly when it has no hard failure" });
    const outcome = decision.hardFailures.length > 0 ? "FAIL" : decision.warnings.length > 0 ? "WARN" : "PASS";
    if (decision.outcome !== outcome) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: `outcome must be ${outcome}` });
  });
export type EvalGateDecision = z.infer<typeof EvalGateDecisionSchema>;

// --- Multi-run analytics ----------------------------------------------------------------

/** Pure aggregation over compatible suite reports. No time series, store, or dashboard. */
export const EvalAnalyticsSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    datasetRef: EvalDatasetRefSchema,
    runsObserved: count,
    cases: z
      .array(
        z
          .object({
            caseId: identifierSchema.max(128),
            comparisonKey: EvalComparisonKeySchema,
            observed: count,
            matched: count,
            mismatched: count,
            errors: count,
            /** Every observation produced the same semantic verdict fingerprint and expectation verdict. */
            stable: z.boolean(),
            /** Consecutive observations that went from MATCHED to not MATCHED. */
            regressions: count,
          })
          .strict(),
      )
      .max(EVAL_ANALYTICS_LIMITS.maxSuiteCases),
    /** Regression transitions / (consecutive observation pairs × cases); null for a single run. */
    regressionFrequency: rate.nullable(),
    /** Errors / all observations. */
    errorFrequency: rate,
    caseStabilityRate: rate,
    averageScore: EvalMeasurementSchema,
  })
  .strict();
export type EvalAnalytics = z.infer<typeof EvalAnalyticsSchema>;
