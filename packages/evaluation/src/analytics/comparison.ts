import {
  EVAL_CANONICAL_CRITICAL_CATEGORIES,
  EvalBaselineSchema,
  EvalCategorySchema,
  EvalComparisonReportSchema,
  EvalSuiteReportSchema,
  type EvalCategory,
  type EvalComparisonClassification,
  type EvalComparisonEntry,
  type EvalComparisonReport,
  type EvalSuiteCase,
} from "@aao/contracts";
import { regressionFindings } from "./regression.js";

type IncompatibleField = NonNullable<EvalComparisonEntry["incompatibleFields"]>[number];

const CATEGORY_ORDER = EvalCategorySchema.options;
const union = (a: readonly EvalCategory[], b: readonly EvalCategory[]) => [...new Set([...a, ...b])].sort((x, y) => CATEGORY_ORDER.indexOf(x) - CATEGORY_ORDER.indexOf(y));
const outcome = (entry: EvalSuiteCase) => ({ expectation: entry.expectation, actual: entry.actual });

/** Logical identity fields that differ between a baseline and a candidate case in the same slot (dataset id + case id). */
function incompatibleFields(baseline: EvalSuiteCase, candidate: EvalSuiteCase, compatibleBaselineDatasetVersions: readonly string[]): IncompatibleField[] {
  const a = baseline.identity;
  const b = candidate.identity;
  const fields: IncompatibleField[] = [];
  if (a.evalRef.id !== b.evalRef.id) fields.push("evalRef.id");
  if (a.evalRef.version !== b.evalRef.version) fields.push("evalRef.version");
  if (a.graderRef.id !== b.graderRef.id) fields.push("graderRef.id");
  if (a.graderRef.version !== b.graderRef.version) fields.push("graderRef.version");
  if (a.datasetRef.id !== b.datasetRef.id) fields.push("datasetRef.id");
  if (a.datasetRef.version !== b.datasetRef.version && !compatibleBaselineDatasetVersions.includes(a.datasetRef.version)) fields.push("datasetRef.version");
  if (a.mode !== b.mode) fields.push("mode");
  if (a.targetType !== b.targetType) fields.push("targetType");
  return fields;
}

function classify(baseline: EvalSuiteCase, candidate: EvalSuiteCase): EvalComparisonClassification {
  const before = baseline.expectation === "MATCHED";
  const after = candidate.expectation === "MATCHED";
  if (before && after) return "UNCHANGED_MATCH";
  if (before) return "REGRESSION";
  if (after) return "IMPROVEMENT";
  return "UNCHANGED_MISMATCH";
}

export type CompareEvalSuitesResult = { ok: true; report: EvalComparisonReport } | { ok: false; code: "EVAL_BASELINE_INVALID" | "EVAL_BASELINE_INCOMPATIBLE"; detail: string };

/**
 * Compare a candidate suite with an approved baseline, one classification
 * per logical case slot (case id within the dataset):
 *
 * - comparable slots (identical comparison identity, or a dataset version
 *   the caller explicitly declared compatible) classify by *case
 *   expectation*, never by raw `EvalResult.status`: matched → not matched
 *   is a REGRESSION even when both results are `failed`;
 * - a changed Eval, grader, or dataset version without an explicit rule is
 *   INCOMPATIBLE — never a regression;
 * - baseline-only cases are MISSING_CASE; candidate-only cases NEW_CASE.
 *
 * Scores are compared only for comparable slots. Deterministic and pure.
 */
export function compareEvalSuites(params: { baseline: unknown; candidate: unknown; compatibleBaselineDatasetVersions?: readonly string[]; criticalCategories?: readonly EvalCategory[] }): CompareEvalSuitesResult {
  const baseline = EvalBaselineSchema.safeParse(params.baseline);
  if (!baseline.success) return { ok: false, code: "EVAL_BASELINE_INVALID", detail: "baseline does not satisfy EvalBaseline schema version 1" };
  const candidate = EvalSuiteReportSchema.safeParse(params.candidate);
  if (!candidate.success) return { ok: false, code: "EVAL_BASELINE_INCOMPATIBLE", detail: "candidate is not a valid EvalSuiteReport" };
  if (baseline.data.datasetRef.id !== candidate.data.datasetRef.id) return { ok: false, code: "EVAL_BASELINE_INCOMPATIBLE", detail: "baseline and candidate gate different datasets" };
  const compatible = params.compatibleBaselineDatasetVersions ?? [];
  const candidates = new Map(candidate.data.cases.map((entry) => [entry.caseId, entry]));
  const baselineIds = new Set(baseline.data.caseExpectations.map((entry) => entry.caseId));
  const entries: EvalComparisonEntry[] = [];

  for (const before of baseline.data.caseExpectations) {
    const after = candidates.get(before.caseId);
    if (!after) {
      entries.push({ caseId: before.caseId, classification: "MISSING_CASE", comparisonKey: before.comparisonKey, categories: before.categories, baseline: outcome(before) });
      continue;
    }
    const categories = union(before.categories, after.categories);
    const fields = incompatibleFields(before, after, compatible);
    if (fields.length > 0) {
      entries.push({ caseId: before.caseId, classification: "INCOMPATIBLE", comparisonKey: after.comparisonKey, categories, baseline: outcome(before), candidate: outcome(after), incompatibleFields: fields });
      continue;
    }
    const scoreDelta = before.actual.score !== undefined && after.actual.score !== undefined ? Math.round((after.actual.score - before.actual.score) * 1e6) / 1e6 : undefined;
    entries.push({ caseId: before.caseId, classification: classify(before, after), comparisonKey: after.comparisonKey, categories, baseline: outcome(before), candidate: outcome(after), ...(scoreDelta !== undefined ? { scoreDelta } : {}) });
  }
  for (const after of candidate.data.cases) {
    if (!baselineIds.has(after.caseId)) entries.push({ caseId: after.caseId, classification: "NEW_CASE", comparisonKey: after.comparisonKey, categories: after.categories, candidate: outcome(after) });
  }

  const count = (classification: EvalComparisonClassification) => entries.filter((entry) => entry.classification === classification).length;
  return {
    ok: true,
    report: EvalComparisonReportSchema.parse({
      schemaVersion: 1,
      baseline: { id: baseline.data.id, version: baseline.data.version, datasetRef: baseline.data.datasetRef },
      candidateDatasetRef: candidate.data.datasetRef,
      entries,
      summary: { unchangedMatch: count("UNCHANGED_MATCH"), unchangedMismatch: count("UNCHANGED_MISMATCH"), regressions: count("REGRESSION"), improvements: count("IMPROVEMENT"), newCases: count("NEW_CASE"), missingCases: count("MISSING_CASE"), incompatible: count("INCOMPATIBLE") },
      findings: regressionFindings(entries, params.criticalCategories ?? EVAL_CANONICAL_CRITICAL_CATEGORIES),
    }),
  };
}
