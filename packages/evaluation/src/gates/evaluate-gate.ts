import {
  EvalBaselineSchema,
  EvalGateDecisionSchema,
  EvalGatePolicySchema,
  EvalReportMetadataSchema,
  EvalSuiteReportSchema,
  type EvalBaseline,
  type EvalComparisonReport,
  type EvalGateDecision,
  type EvalGateHardFailure,
  type EvalGateMetricRule,
  type EvalGateWarning,
  type EvalMeasurement,
  type EvalReportMetadata,
  type EvalSuiteReport,
} from "@aao/contracts";
import { evalBaselineFingerprint } from "../analytics/baseline.js";
import { compareEvalSuites } from "../analytics/comparison.js";
import { validateEvalBaselineIntegrity, validateEvalSuiteReportIntegrity } from "../analytics/integrity.js";

export interface EvalGateError {
  code: "EVAL_GATE_POLICY_INVALID" | "EVAL_BASELINE_INVALID" | "EVAL_BASELINE_INCOMPATIBLE" | "EVAL_GATE_INCOMPLETE_EVIDENCE" | "EVAL_SUITE_REPORT_INCONSISTENT";
  detail: string;
}

export type EvaluateEvalGateResult = { ok: true; decision: EvalGateDecision; comparison: EvalComparisonReport } | { ok: false; error: EvalGateError };

/** Metrics that regress when they decrease; every other metric regresses when it increases. */
const HIGHER_IS_BETTER = new Set(["averageScore"]);

function measurement(rule: EvalGateMetricRule, source: { summary: { averageScore: EvalMeasurement }; operational?: EvalSuiteReport["operational"] }): EvalMeasurement {
  if (rule.metric === "averageScore") return source.summary.averageScore;
  return source.operational?.metrics[rule.metric] ?? { status: "unavailable" };
}

/** Regression percent (positive = worse). A zero baseline makes any worsening unbounded (null, always over threshold). */
function regressionPercent(metric: string, baseline: number, candidate: number): number | null {
  const worse = HIGHER_IS_BETTER.has(metric) ? baseline - candidate : candidate - baseline;
  if (baseline === 0) return worse > 0 ? null : 0;
  return (worse / baseline) * 100;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The deterministic CI quality gate. Policy is data; this is code — no
 * model decides that a regression "seems acceptable", and identical inputs
 * always yield a deep-equal decision.
 *
 * Errors (no trustworthy comparison) are returned as `ok: false` and are
 * never reported as a regression: invalid policy, an invalid or
 * re-written baseline (fingerprint ≠ the policy pin), or a candidate for a
 * different dataset without an explicit compatibility rule.
 *
 * Hard failures: any unmatched case in a critical category (Approval,
 * Authorization, safety, and Trace integrity are always critical), any
 * unexpected Eval error, any fixture fingerprint mismatch, any missing
 * required baseline case, any incompatible case, an expectation match
 * rate below the policy, regressions above the policy, and any `required`
 * metric rule that regressed or lacks evidence. Advisory metric rules warn.
 * Missing evidence never passes.
 *
 * The decision is engineering/release quality data. It is not a Run status
 * and it cannot approve, authorize, trigger Tools, alter retries or replay
 * safety, or change Governance.
 */
export function evaluateEvalGate(params: { policy: unknown; baseline: unknown; candidate: unknown; metadata?: EvalReportMetadata }): EvaluateEvalGateResult {
  const fail = (code: EvalGateError["code"], detail: string): EvaluateEvalGateResult => ({ ok: false, error: { code, detail } });
  const policyParsed = EvalGatePolicySchema.safeParse(params.policy);
  if (!policyParsed.success) return fail("EVAL_GATE_POLICY_INVALID", "policy does not satisfy EvalGatePolicy schema version 1");
  const policy = policyParsed.data;
  const baselineParsed = EvalBaselineSchema.safeParse(params.baseline);
  if (!baselineParsed.success) return fail("EVAL_BASELINE_INVALID", "baseline does not satisfy EvalBaseline schema version 1");
  const baseline: EvalBaseline = baselineParsed.data;
  if (baseline.id !== policy.baselineRef.id || baseline.version !== policy.baselineRef.version) return fail("EVAL_BASELINE_INVALID", `policy pins baseline ${policy.baselineRef.id}@${policy.baselineRef.version}, got ${baseline.id}@${baseline.version}`);
  if (evalBaselineFingerprint(baseline) !== policy.baselineRef.fingerprint) return fail("EVAL_BASELINE_INVALID", "baseline content does not match the fingerprint pinned by the policy (baselines are immutable within a version)");
  const baselineIntegrity = validateEvalBaselineIntegrity(baseline);
  if (!baselineIntegrity.ok) return fail("EVAL_BASELINE_INVALID", `baseline is self-inconsistent: ${baselineIntegrity.issues.join("; ")}`);
  const candidateParsed = EvalSuiteReportSchema.safeParse(params.candidate);
  if (!candidateParsed.success) return fail("EVAL_GATE_INCOMPLETE_EVIDENCE", "candidate is not a valid EvalSuiteReport");
  // A schema-valid report can still self-attest counts its cases contradict: recompute before trusting any summary.
  const candidateIntegrity = validateEvalSuiteReportIntegrity(candidateParsed.data);
  if (!candidateIntegrity.ok) return fail("EVAL_SUITE_REPORT_INCONSISTENT", `candidate report is self-inconsistent: ${candidateIntegrity.issues.join("; ")}`);
  const candidate = candidateParsed.data;
  if (candidate.datasetRef.id !== policy.datasetRef.id || candidate.datasetRef.version !== policy.datasetRef.version) return fail("EVAL_BASELINE_INCOMPATIBLE", `policy gates ${policy.datasetRef.id}@${policy.datasetRef.version}, candidate ran ${candidate.datasetRef.id}@${candidate.datasetRef.version}`);
  const compatible = policy.comparison?.compatibleBaselineDatasetVersions ?? [];
  if (baseline.datasetRef.id !== policy.datasetRef.id || (baseline.datasetRef.version !== policy.datasetRef.version && !compatible.includes(baseline.datasetRef.version))) return fail("EVAL_BASELINE_INCOMPATIBLE", `baseline dataset ${baseline.datasetRef.id}@${baseline.datasetRef.version} is not declared compatible with ${policy.datasetRef.id}@${policy.datasetRef.version}`);
  const metadata = params.metadata === undefined ? undefined : EvalReportMetadataSchema.safeParse(params.metadata);
  if (metadata && !metadata.success) return fail("EVAL_GATE_INCOMPLETE_EVIDENCE", "metadata is invalid");

  const critical = policy.hardFail.criticalCategories;
  const compared = compareEvalSuites({ baseline, candidate, compatibleBaselineDatasetVersions: compatible, criticalCategories: critical });
  if (!compared.ok) return fail(compared.code, compared.detail);
  const comparison = compared.report;
  const entries = comparison.entries;
  const isCritical = (categories: readonly string[]) => categories.some((category) => (critical as readonly string[]).includes(category));
  const ids = (predicate: (entry: (typeof entries)[number]) => boolean) => entries.filter(predicate).map((entry) => entry.caseId);
  const hardFailures: EvalGateHardFailure[] = [];
  const add = (code: EvalGateHardFailure["code"], rule: string, caseIds: string[]) => {
    if (caseIds.length > 0) hardFailures.push({ code, rule, caseIds });
  };

  const candidateUnmatched = (entry: (typeof entries)[number]) => entry.candidate !== undefined && entry.candidate.expectation !== "MATCHED";
  add("EVAL_GATE_CRITICAL_REGRESSION", "critical-categories", ids((entry) => entry.classification === "REGRESSION" && isCritical(entry.categories)));
  add("EVAL_GATE_CRITICAL_MISMATCH", "critical-categories", ids((entry) => entry.classification !== "REGRESSION" && entry.classification !== "INCOMPATIBLE" && candidateUnmatched(entry) && isCritical(entry.categories)));
  add("EVAL_FIXTURE_FINGERPRINT_MISMATCH", "fixture-integrity", ids((entry) => entry.candidate?.actual.errorCode === "EVAL_FIXTURE_FINGERPRINT_MISMATCH"));
  add("EVAL_GATE_UNEXPECTED_ERROR", "unexpected-eval-error", ids((entry) => entry.candidate?.expectation === "ERROR" && entry.candidate.actual.errorCode !== "EVAL_FIXTURE_FINGERPRINT_MISMATCH"));
  // A critical baseline case can never silently disappear, whatever requireAllCasesPresent says.
  if (policy.hardFail.requireAllCasesPresent) add("EVAL_COMPARISON_MISSING_CASE", "require-all-cases-present", ids((entry) => entry.classification === "MISSING_CASE"));
  else add("EVAL_COMPARISON_MISSING_CASE", "critical-categories", ids((entry) => entry.classification === "MISSING_CASE" && isCritical(entry.categories)));
  add("EVAL_BASELINE_INCOMPATIBLE", "comparison-compatibility", ids((entry) => entry.classification === "INCOMPATIBLE"));
  if (candidate.summary.expectationMatchRate < policy.hardFail.requireExpectationMatchRate) add("EVAL_GATE_EXPECTATION_MISMATCH", "expectation-match-rate", candidate.cases.filter((entry) => entry.expectation !== "MATCHED").map((entry) => entry.caseId));
  if (comparison.summary.regressions > policy.hardFail.maxRegressions) add("EVAL_GATE_REGRESSION_LIMIT", "max-regressions", ids((entry) => entry.classification === "REGRESSION"));

  const warnings: EvalGateWarning[] = [];
  for (const rule of policy.warnings) {
    const before = measurement(rule, { summary: baseline.suiteSummary, ...(baseline.performanceBaseline ? { operational: baseline.performanceBaseline } : {}) });
    const after = measurement(rule, candidate);
    const values = { ruleId: rule.id, metric: rule.metric, baseline: before.status === "complete" ? before.value : null, candidate: after.status === "complete" ? after.value : null };
    if (before.status !== "complete" || after.status !== "complete") {
      // Unknown never passes: a missing measurement warns or fails, per rule.
      const onMissing = rule.onMissingEvidence ?? (rule.severity === "required" ? "fail" : "warn");
      if (onMissing === "fail") hardFailures.push({ code: "EVAL_GATE_INCOMPLETE_EVIDENCE", rule: rule.id, metric: rule.metric });
      else warnings.push({ code: "EVAL_GATE_INCOMPLETE_EVIDENCE", ...values, changePercent: null });
      continue;
    }
    const change = regressionPercent(rule.metric, before.value, after.value);
    if (change !== null && change <= rule.maxRegressionPercent) continue;
    if (rule.severity === "required") hardFailures.push({ code: "EVAL_GATE_METRIC_REGRESSION", rule: rule.id, metric: rule.metric });
    else warnings.push({ code: "EVAL_GATE_METRIC_REGRESSION", ...values, changePercent: change === null ? null : round2(change) });
  }

  const passed = hardFailures.length === 0;
  return {
    ok: true,
    comparison,
    decision: EvalGateDecisionSchema.parse({
      schemaVersion: 1,
      policyRef: { id: policy.id, version: policy.version },
      baselineRef: { id: baseline.id, version: baseline.version },
      datasetRef: candidate.datasetRef,
      passed,
      outcome: !passed ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS",
      hardFailures,
      warnings,
      candidateSummary: candidate.summary,
      comparisonSummary: comparison.summary,
      findings: comparison.findings,
      ...(metadata?.success ? { metadata: metadata.data } : {}),
    }),
  };
}
