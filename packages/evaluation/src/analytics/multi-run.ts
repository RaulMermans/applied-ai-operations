import { EVAL_ANALYTICS_LIMITS, EvalAnalyticsSchema, EvalSuiteReportSchema, type EvalAnalytics, type EvalSuiteReport } from "@aao/contracts";
import { EvalAnalyticsInputError } from "./suite-summary.js";

/**
 * Pure aggregation over compatible suite reports (same dataset id and
 * version), in the order given: per-case stability, regression
 * transitions, error frequency, and mean score. No clock, store, time
 * series, or dashboard: the reports are the only input and the result is
 * the only output. A case whose comparison key differs between reports is
 * incompatible input, never averaged across criteria.
 */
export function analyzeEvalSuites(reports: readonly unknown[]): EvalAnalytics {
  if (reports.length === 0 || reports.length > EVAL_ANALYTICS_LIMITS.maxAnalyticsRuns) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", `between 1 and ${EVAL_ANALYTICS_LIMITS.maxAnalyticsRuns} suite reports`);
  const suites: EvalSuiteReport[] = reports.map((report) => {
    const parsed = EvalSuiteReportSchema.safeParse(report);
    if (!parsed.success) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", "suite report");
    return parsed.data;
  });
  const datasetRef = suites[0]!.datasetRef;
  if (suites.some((suite) => suite.datasetRef.id !== datasetRef.id || suite.datasetRef.version !== datasetRef.version)) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", "suite reports from different dataset versions are not compatible");

  const order: string[] = [];
  const observations = new Map<string, Array<{ comparisonKey: string; expectation: string; semantic: string; score?: number }>>();
  for (const suite of suites) {
    for (const entry of suite.cases) {
      if (!observations.has(entry.caseId)) {
        order.push(entry.caseId);
        observations.set(entry.caseId, []);
      }
      observations.get(entry.caseId)!.push({ comparisonKey: entry.comparisonKey, expectation: entry.expectation, semantic: entry.semanticVerdictFingerprint, ...(entry.actual.score !== undefined ? { score: entry.actual.score } : {}) });
    }
  }

  let transitions = 0;
  let regressionTransitions = 0;
  let total = 0;
  let errors = 0;
  const scores: number[] = [];
  const cases = order.map((caseId) => {
    const seen = observations.get(caseId)!;
    if (new Set(seen.map((entry) => entry.comparisonKey)).size > 1) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", `case ${caseId} changed comparison identity across reports`);
    let regressions = 0;
    for (let index = 1; index < seen.length; index += 1) if (seen[index - 1]!.expectation === "MATCHED" && seen[index]!.expectation !== "MATCHED") regressions += 1;
    transitions += seen.length - 1;
    regressionTransitions += regressions;
    total += seen.length;
    const caseErrors = seen.filter((entry) => entry.expectation === "ERROR").length;
    errors += caseErrors;
    for (const entry of seen) if (entry.score !== undefined) scores.push(entry.score);
    return {
      caseId,
      comparisonKey: seen[0]!.comparisonKey,
      observed: seen.length,
      matched: seen.filter((entry) => entry.expectation === "MATCHED").length,
      mismatched: seen.filter((entry) => entry.expectation === "MISMATCHED").length,
      errors: caseErrors,
      stable: new Set(seen.map((entry) => `${entry.expectation}|${entry.semantic}`)).size === 1,
      regressions,
    };
  });

  return EvalAnalyticsSchema.parse({
    schemaVersion: 1,
    datasetRef,
    runsObserved: suites.length,
    cases,
    regressionFrequency: transitions === 0 ? null : regressionTransitions / transitions,
    errorFrequency: total === 0 ? 0 : errors / total,
    caseStabilityRate: cases.length === 0 ? 0 : cases.filter((entry) => entry.stable).length / cases.length,
    averageScore: scores.length === 0 ? { status: "unavailable" } : { status: "complete", value: scores.reduce((sum, score) => sum + score, 0) / scores.length },
  });
}
