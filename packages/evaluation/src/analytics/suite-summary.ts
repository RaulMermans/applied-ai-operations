import {
  AggregateMetricsSchema,
  EVAL_CANONICAL_CRITICAL_CATEGORIES,
  EvalCategorySchema,
  EvalDatasetRunSchema,
  EvalDatasetSchema,
  EvalDefinitionSchema,
  EvalReportMetadataSchema,
  EvalSuiteReportSchema,
  type EvalCategory,
  type EvalMeasurement,
  type EvalOperationalSummary,
  type EvalReportMetadata,
  type EvalSuiteCase,
  type EvalSuiteReport,
  type EvalSuiteSummary,
} from "@aao/contracts";
import { caseExpectationVerdict } from "./expectation.js";
import { buildEvalComparisonIdentity, comparisonKeyOf, semanticVerdictFingerprint, sha256Canonical, verdictSummary } from "./fingerprints.js";

export class EvalAnalyticsInputError extends Error {
  constructor(readonly code: "EVAL_DATASET_INVALID" | "EVAL_INVALID_DEFINITION" | "EVAL_GATE_INCOMPLETE_EVIDENCE", readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "EvalAnalyticsInputError";
  }
}

const CATEGORY_ORDER = EvalCategorySchema.options;
const byCategoryOrder = (categories: Iterable<EvalCategory>) => [...new Set(categories)].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
const unavailable: EvalMeasurement = { status: "unavailable" };

export const isCritical = (categories: readonly EvalCategory[], critical: readonly EvalCategory[] = EVAL_CANONICAL_CRITICAL_CATEGORIES) => categories.some((category) => critical.includes(category));

/**
 * Projection of canonical `AggregateMetrics` (computed by the host with
 * `@aao/observability` over the evaluated evidence) into the advisory
 * operational measurements a gate may compare. Incomplete evidence stays
 * `partial`/`unavailable`; it is never reported as a number.
 */
export function operationalSummaryFromAggregate(aggregate: unknown): EvalOperationalSummary {
  const parsed = AggregateMetricsSchema.safeParse(aggregate);
  if (!parsed.success) throw new EvalAnalyticsInputError("EVAL_GATE_INCOMPLETE_EVIDENCE", "operational metrics are not a valid AggregateMetrics");
  const metrics = parsed.data;
  const value = (number: number | null): EvalMeasurement => (number === null ? unavailable : { status: "complete", value: number });
  if (metrics.runCount === 0) return { runsObserved: 0, metrics: { runDurationP95Ms: unavailable, estimatedCostNanos: unavailable, knownEstimatedCostNanos: unavailable, retryingRunRate: unavailable, totalTokens: unavailable, knownTotalTokens: unavailable, toolCalls: unavailable } };
  // Latency percentiles cover terminal Runs only; a Run still waiting has no duration yet (ineligible, not missing).
  // Only a terminal Run without a duration makes the measurement partial.
  const latency = metrics.latency.p95RunDurationMs === null ? unavailable : metrics.latency.eligibleRuns < metrics.runs.terminal ? ({ status: "partial" } as const) : value(metrics.latency.p95RunDurationMs);
  const complete = (status: "complete" | "partial" | "unavailable", number: number | null): EvalMeasurement => (status === "complete" && number !== null ? { status: "complete", value: number } : status === "partial" ? { status: "partial" } : unavailable);
  return {
    runsObserved: metrics.runCount,
    metrics: {
      runDurationP95Ms: latency,
      estimatedCostNanos: complete(metrics.cost.status, metrics.cost.estimatedCostNanos),
      knownEstimatedCostNanos: value(metrics.cost.knownEstimatedCostNanos),
      retryingRunRate: value(metrics.retries.retryingRunRate.value),
      totalTokens: complete(metrics.tokens.status, metrics.tokens.totalTokens),
      knownTotalTokens: value(metrics.tokens.knownTotalTokens),
      toolCalls: value(metrics.tools.totalToolCalls),
    },
  };
}

/** Summary counts over suite cases. Shared by suite reports and baselines. */
export function summarizeSuiteCases(cases: readonly EvalSuiteCase[]): EvalSuiteSummary {
  const count = (predicate: (entry: EvalSuiteCase) => boolean) => cases.filter(predicate).length;
  const scores = cases.map((entry) => entry.actual.score).filter((score): score is number => score !== undefined);
  const matched = count((entry) => entry.expectation === "MATCHED");
  return {
    casesTotal: cases.length,
    expectationsMatched: matched,
    expectationsMismatched: count((entry) => entry.expectation === "MISMATCHED"),
    expectationErrors: count((entry) => entry.expectation === "ERROR"),
    expectationMatchRate: cases.length === 0 ? 0 : matched / cases.length,
    rawStatuses: { passed: count((entry) => entry.actual.status === "passed"), failed: count((entry) => entry.actual.status === "failed"), error: count((entry) => entry.actual.status === "error") },
    averageScore: scores.length === 0 ? unavailable : { status: "complete", value: scores.reduce((sum, score) => sum + score, 0) / scores.length },
  };
}

/** Covers comparison keys, expectation verdicts, and semantic verdicts in case order — nothing execution-specific. */
export function suiteSemanticFingerprint(datasetRef: { id: string; version: string }, cases: readonly EvalSuiteCase[]): string {
  return sha256Canonical({ domain: "aao.eval-suite.v1", datasetRef, cases: cases.map((entry) => ({ caseId: entry.caseId, comparisonKey: entry.comparisonKey, expectation: entry.expectation, semanticVerdictFingerprint: entry.semanticVerdictFingerprint })) });
}

/**
 * Build the deterministic `EvalSuiteReport` for one dataset run: every
 * executed case's comparison key, declared expectation, actual verdict,
 * case expectation verdict, and semantic verdict fingerprint, plus counts,
 * category breakdown, and canonical critical findings. Categories come
 * from the case's Eval definition. Metadata (timestamps, git SHA) is
 * carried but never affects any fingerprint or verdict.
 */
export function buildEvalSuiteReport(params: { dataset: unknown; definitions: readonly unknown[]; run: unknown; operational?: unknown; metadata?: EvalReportMetadata }): EvalSuiteReport {
  const dataset = EvalDatasetSchema.safeParse(params.dataset);
  if (!dataset.success) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", "dataset");
  const run = EvalDatasetRunSchema.safeParse(params.run);
  if (!run.success) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", "dataset run");
  if (run.data.datasetRef.id !== dataset.data.id || run.data.datasetRef.version !== dataset.data.version) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", "run belongs to another dataset version");
  const definitions = new Map<string, readonly EvalCategory[]>();
  for (const candidate of params.definitions) {
    const definition = EvalDefinitionSchema.safeParse(candidate);
    if (!definition.success) throw new EvalAnalyticsInputError("EVAL_INVALID_DEFINITION", "definition");
    definitions.set(`${definition.data.id}@${definition.data.version}`, definition.data.categories ?? []);
  }
  const casesById = new Map(dataset.data.cases.map((evalCase) => [evalCase.id, evalCase]));

  const cases: EvalSuiteCase[] = run.data.cases.map((entry) => {
    const evalCase = casesById.get(entry.caseId);
    if (!evalCase) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", `case ${entry.caseId} is not in the dataset`);
    const categories = definitions.get(`${entry.result.evalRef.id}@${entry.result.evalRef.version}`);
    if (!categories) throw new EvalAnalyticsInputError("EVAL_INVALID_DEFINITION", `no definition for case ${entry.caseId}`);
    const identity = buildEvalComparisonIdentity(entry.result);
    return {
      caseId: entry.caseId,
      comparisonKey: comparisonKeyOf(identity),
      identity,
      categories: byCategoryOrder(categories),
      expected: evalCase.expected,
      actual: verdictSummary(entry.result),
      expectation: caseExpectationVerdict(evalCase.expected, entry.result),
      semanticVerdictFingerprint: semanticVerdictFingerprint(entry.result),
    };
  });

  const breakdown = new Map<EvalCategory, { total: number; matched: number; mismatched: number; errors: number }>();
  for (const entry of cases) {
    for (const category of entry.categories) {
      const bucket = breakdown.get(category) ?? { total: 0, matched: 0, mismatched: 0, errors: 0 };
      bucket.total += 1;
      if (entry.expectation === "MATCHED") bucket.matched += 1;
      else if (entry.expectation === "MISMATCHED") bucket.mismatched += 1;
      else bucket.errors += 1;
      breakdown.set(category, bucket);
    }
  }
  const datasetRef = { id: dataset.data.id, version: dataset.data.version };
  const report = {
    schemaVersion: 1 as const,
    datasetRef,
    cases,
    summary: summarizeSuiteCases(cases),
    categoryBreakdown: byCategoryOrder(breakdown.keys()).map((category) => ({ category, ...breakdown.get(category)! })),
    criticalFindings: cases.filter((entry) => entry.expectation !== "MATCHED" && isCritical(entry.categories)).map((entry) => ({ caseId: entry.caseId, comparisonKey: entry.comparisonKey, categories: entry.categories, expectation: entry.expectation })),
    ...(params.operational !== undefined ? { operational: operationalSummaryFromAggregate(params.operational) } : {}),
    semanticFingerprint: suiteSemanticFingerprint(datasetRef, cases),
    ...(params.metadata !== undefined ? { metadata: EvalReportMetadataSchema.parse(params.metadata) } : {}),
  };
  return EvalSuiteReportSchema.parse(report);
}
