import { EVAL_ANALYTICS_LIMITS, type EvalCategory, type EvalComparisonEntry, type RegressionFinding } from "@aao/contracts";

const DIAGNOSTIC: Record<RegressionFinding["classification"], string> = {
  REGRESSION: "EVAL_GATE_EXPECTATION_MISMATCH",
  UNCHANGED_MISMATCH: "EVAL_GATE_EXPECTATION_MISMATCH",
  NEW_CASE: "EVAL_GATE_EXPECTATION_MISMATCH",
  MISSING_CASE: "EVAL_COMPARISON_MISSING_CASE",
  INCOMPATIBLE: "EVAL_BASELINE_INCOMPATIBLE",
};

/**
 * Bounded review candidates from a comparison: regressions, missing and
 * incompatible cases, new cases that do not match their expectation, and
 * persisting mismatches. A finding is data for a human; nothing here
 * modifies a dataset, a baseline, a Skill, or Memory, and nothing promotes
 * a finding into a regression case automatically.
 */
export function regressionFindings(entries: readonly EvalComparisonEntry[], criticalCategories: readonly EvalCategory[]): RegressionFinding[] {
  const findings: RegressionFinding[] = [];
  for (const entry of entries) {
    const classification = entry.classification;
    if (classification === "UNCHANGED_MATCH" || classification === "IMPROVEMENT") continue;
    if (classification === "NEW_CASE" && entry.candidate?.expectation === "MATCHED") continue;
    const critical = entry.categories.some((category) => criticalCategories.includes(category));
    const actual = entry.candidate?.actual;
    const diagnostic = !critical || classification === "MISSING_CASE" || classification === "INCOMPATIBLE" ? DIAGNOSTIC[classification] : classification === "REGRESSION" ? "EVAL_GATE_CRITICAL_REGRESSION" : "EVAL_GATE_CRITICAL_MISMATCH";
    const codes = [diagnostic, ...(actual?.errorCode ? [actual.errorCode] : []), ...(actual?.reasonCodes ?? [])];
    findings.push({
      caseId: entry.caseId,
      comparisonKey: entry.comparisonKey,
      classification,
      categories: entry.categories,
      severity: critical ? "critical" : "required",
      ...(entry.baseline ? { baselineOutcome: entry.baseline } : {}),
      ...(entry.candidate ? { candidateOutcome: entry.candidate } : {}),
      reasonCodes: [...new Set(codes)].slice(0, EVAL_ANALYTICS_LIMITS.maxReasonCodes),
    });
  }
  return findings;
}
