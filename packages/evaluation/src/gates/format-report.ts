import type { EvalComparisonReport, EvalGateDecision } from "@aao/contracts";
import type { EvalGateError } from "./evaluate-gate.js";

/**
 * Machine-readable gate output: plain JSON-safe data, no ANSI, no evidence
 * content (identifiers, codes, counts, and measurements only).
 */
export function gateDecisionJson(decision: EvalGateDecision, comparison?: EvalComparisonReport) {
  const critical = decision.hardFailures.filter((failure) => failure.rule === "critical-categories").flatMap((failure) => failure.caseIds ?? []);
  return {
    gate: { passed: decision.passed, outcome: decision.outcome },
    policy: decision.policyRef,
    dataset: decision.datasetRef,
    baseline: decision.baselineRef,
    cases: { total: decision.candidateSummary.casesTotal, matched: decision.candidateSummary.expectationsMatched, mismatched: decision.candidateSummary.expectationsMismatched, errors: decision.candidateSummary.expectationErrors, rawStatuses: decision.candidateSummary.rawStatuses },
    comparison: decision.comparisonSummary,
    regressions: decision.comparisonSummary.regressions,
    criticalFailures: [...new Set(critical)],
    hardFailures: decision.hardFailures,
    warnings: decision.warnings,
    findings: decision.findings,
    ...(comparison ? { entries: comparison.entries.map((entry) => ({ caseId: entry.caseId, classification: entry.classification })) } : {}),
    ...(decision.metadata ? { metadata: decision.metadata } : {}),
  };
}

const ref = (value: { id: string; version: string }) => `${value.id}@${value.version}`;
const percent = (value: number | null) => (value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value}%`);

/** Compact human output. Per-case detail only for findings, or for every case with `verbose`. */
export function formatGateDecisionText(decision: EvalGateDecision, options: { verbose?: boolean; comparison?: EvalComparisonReport } = {}): string {
  const critical = new Set(decision.hardFailures.filter((failure) => failure.rule === "critical-categories").flatMap((failure) => failure.caseIds ?? []));
  const lines = [
    "AAO Eval Gate",
    "",
    `Policy: ${ref(decision.policyRef)}`,
    `Dataset: ${ref(decision.datasetRef)}`,
    `Baseline: ${ref(decision.baselineRef)}`,
    `Cases: ${decision.candidateSummary.expectationsMatched}/${decision.candidateSummary.casesTotal} matched`,
    `Regressions: ${decision.comparisonSummary.regressions}`,
    `Missing: ${decision.comparisonSummary.missingCases}  New: ${decision.comparisonSummary.newCases}  Incompatible: ${decision.comparisonSummary.incompatible}`,
    `Critical failures: ${critical.size}`,
    `Warnings: ${decision.warnings.length}`,
  ];
  if (decision.warnings.length > 0 || decision.hardFailures.length > 0) lines.push("");
  for (const warning of decision.warnings) lines.push(warning.code === "EVAL_GATE_INCOMPLETE_EVIDENCE" ? `WARN ${warning.ruleId} ${warning.metric}: evidence incomplete` : `WARN ${warning.ruleId} ${warning.metric} ${percent(warning.changePercent)}`);
  for (const failure of decision.hardFailures) lines.push(`FAIL ${failure.code} [${failure.rule}]${failure.metric ? ` ${failure.metric}` : ""}${failure.caseIds ? ` ${failure.caseIds.join(", ")}` : ""}`);
  if (options.verbose && options.comparison) {
    lines.push("");
    for (const entry of options.comparison.entries) lines.push(`${entry.classification.padEnd(18)} ${entry.caseId}${entry.candidate ? ` ${entry.candidate.expectation} ${entry.candidate.actual.status}` : ""}`);
  }
  lines.push("", decision.outcome);
  return `${lines.join("\n")}\n`;
}

export function formatGateErrorText(error: EvalGateError): string {
  return `AAO Eval Gate\n\nGATE ERROR ${error.code}: ${error.detail}\nNo trustworthy comparison occurred.\n\nERROR\n`;
}
