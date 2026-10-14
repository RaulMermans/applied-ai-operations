import { EvalBaselineSchema, EvalSuiteReportSchema, canonicalJsonStringify, type EvalBaseline, type EvalSuiteCase, type EvalSuiteReport, type JsonValue } from "@aao/contracts";
import { expectationOfVerdict } from "./expectation.js";
import { comparisonKeyOf } from "./fingerprints.js";
import { canonicalCategoryOrder, categoryBreakdownOf, criticalFindingsOf, suiteSemanticFingerprint, summarizeSuiteCases } from "./suite-summary.js";

/** Bounded so a forged report cannot produce an unbounded diagnostic. */
const MAX_INTEGRITY_ISSUES = 20;

export type EvalReportIntegrityResult<T> = { ok: true; value: T } | { ok: false; code: "EVAL_SUITE_REPORT_INCONSISTENT"; issues: string[] };

const same = (a: unknown, b: unknown) => canonicalJsonStringify(JSON.parse(JSON.stringify(a)) as JsonValue) === canonicalJsonStringify(JSON.parse(JSON.stringify(b)) as JsonValue);

/**
 * Every derivable field of a list of suite cases, recomputed from the cases'
 * own data: the comparison key from the logical identity, canonical
 * category order, and the case expectation verdict from the declared
 * expectation and the normalized actual verdict. Per-case semantic verdict
 * fingerprints cover assertion-level detail a report does not carry, so
 * they are not derivable here.
 */
function caseIssues(cases: readonly EvalSuiteCase[]): string[] {
  const issues: string[] = [];
  for (const entry of cases) {
    if (entry.comparisonKey !== comparisonKeyOf(entry.identity)) issues.push(`case ${entry.caseId}: comparisonKey does not match its identity`);
    if (!same(entry.categories, canonicalCategoryOrder(entry.categories))) issues.push(`case ${entry.caseId}: categories are not in canonical order`);
    if (entry.expectation !== expectationOfVerdict(entry.expected, entry.actual)) issues.push(`case ${entry.caseId}: expectation ${entry.expectation} does not follow from expected and actual verdicts`);
  }
  return issues;
}

const bounded = <T>(value: T, issues: string[]): EvalReportIntegrityResult<T> => (issues.length === 0 ? { ok: true, value } : { ok: false, code: "EVAL_SUITE_REPORT_INCONSISTENT", issues: issues.slice(0, MAX_INTEGRITY_ISSUES) });

/**
 * Deterministic integrity check for a caller-supplied `EvalSuiteReport`
 * (Sprint 19 closure of the Sprint 18 proof-layer gap). Schema validity is
 * not enough: a report could self-attest `summary.expectationsMatched: 35`
 * while its cases say otherwise. This recomputes, from the report's own
 * case data, every case expectation verdict and comparison key, the
 * summary counts and match rate, the category breakdown, the critical
 * findings (canonical critical categories), and the suite semantic
 * fingerprint, and rejects any disagreement.
 *
 * Proof-layer only: it never grants, approves, executes, or changes Runtime
 * or Governance state.
 */
export function validateEvalSuiteReportIntegrity(report: unknown): EvalReportIntegrityResult<EvalSuiteReport> {
  const parsed = EvalSuiteReportSchema.safeParse(report);
  if (!parsed.success) return { ok: false, code: "EVAL_SUITE_REPORT_INCONSISTENT", issues: ["not a valid EvalSuiteReport"] };
  const suite = parsed.data;
  const issues = caseIssues(suite.cases);
  if (!same(suite.summary, summarizeSuiteCases(suite.cases))) issues.push("summary does not match the cases");
  if (!same(suite.categoryBreakdown, categoryBreakdownOf(suite.cases))) issues.push("categoryBreakdown does not match the cases");
  if (!same(suite.criticalFindings, criticalFindingsOf(suite.cases))) issues.push("criticalFindings do not match the cases");
  if (suite.semanticFingerprint !== suiteSemanticFingerprint(suite.datasetRef, suite.cases)) issues.push("semanticFingerprint does not match the cases");
  return bounded(suite, issues);
}

/**
 * The same recomputation for an `EvalBaseline`: its case expectations, its
 * suite summary, and the suite semantic fingerprint it claims to be
 * generated from. A gate policy additionally pins the baseline's content
 * fingerprint; this check makes a self-inconsistent baseline invalid even
 * when someone re-pins it.
 */
export function validateEvalBaselineIntegrity(baseline: unknown): EvalReportIntegrityResult<EvalBaseline> {
  const parsed = EvalBaselineSchema.safeParse(baseline);
  if (!parsed.success) return { ok: false, code: "EVAL_SUITE_REPORT_INCONSISTENT", issues: ["not a valid EvalBaseline"] };
  const value = parsed.data;
  const issues = caseIssues(value.caseExpectations);
  if (!same(value.suiteSummary, summarizeSuiteCases(value.caseExpectations))) issues.push("suiteSummary does not match the case expectations");
  if (value.generatedFrom.suiteSemanticFingerprint !== suiteSemanticFingerprint(value.datasetRef, value.caseExpectations)) issues.push("generatedFrom.suiteSemanticFingerprint does not match the case expectations");
  return bounded(value, issues);
}
