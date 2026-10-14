import { EvalBaselineSchema, EvalSuiteReportSchema, entityVersionSchema, identifierSchema, type EvalBaseline } from "@aao/contracts";
import { sha256Canonical } from "./fingerprints.js";
import { EvalAnalyticsInputError } from "./suite-summary.js";

/**
 * Content fingerprint of a baseline. A gate policy pins it (`baselineRef`),
 * so a baseline file edited in place — the "silent mutation" a reviewer
 * could miss — is `EVAL_BASELINE_INVALID` until the policy deliberately
 * re-pins a new baseline version.
 */
export function evalBaselineFingerprint(baseline: EvalBaseline): string {
  return sha256Canonical({ domain: "aao.eval-baseline.v1", baseline });
}

/**
 * Turn a candidate suite report into a baseline *proposal*. Nothing is
 * written: the host prints the proposal, and a human reviews and commits
 * it under `evals/baselines/` with a new version and a re-pinned gate
 * policy. There is no "accept all" path and no automatic baseline update —
 * least of all after a regression.
 */
export function proposeEvalBaseline(params: { suite: unknown; id: string; version: string; description?: string }): EvalBaseline {
  const suite = EvalSuiteReportSchema.safeParse(params.suite);
  if (!suite.success) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", "suite report");
  if (!identifierSchema.safeParse(params.id).success || !entityVersionSchema.safeParse(params.version).success) throw new EvalAnalyticsInputError("EVAL_DATASET_INVALID", "baseline identity");
  return EvalBaselineSchema.parse({
    schemaVersion: 1,
    id: params.id,
    version: params.version,
    ...(params.description !== undefined ? { description: params.description } : {}),
    datasetRef: suite.data.datasetRef,
    generatedFrom: { suiteSemanticFingerprint: suite.data.semanticFingerprint },
    caseExpectations: suite.data.cases,
    suiteSummary: suite.data.summary,
    ...(suite.data.operational !== undefined ? { performanceBaseline: suite.data.operational } : {}),
  });
}
