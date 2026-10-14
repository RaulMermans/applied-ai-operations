import { describe, expect, it } from "vitest";
import { EvalSuiteReportSchema, type EvalResult } from "@aao/contracts";
import {
  analyzeEvalSuites,
  buildEvalComparisonKey,
  buildEvalSuiteReport,
  caseExpectationVerdict,
  compareEvalSuites,
  evaluate,
  proposeEvalBaseline,
  runEvalDataset,
  semanticVerdictFingerprint,
} from "../src/index.js";
import { definition, fixtureResolver, loadDataset, loadDefinitions, loadFixture, registry } from "./support/evals.js";

const datasetRef = { id: "aao.runtime-foundation", version: "2.0.0" };

async function foundationSuite() {
  const dataset = loadDataset();
  const definitions = loadDefinitions();
  const run = await runEvalDataset({ dataset, definitions, registry: registry(), evidenceResolver: fixtureResolver() });
  if (!run.ok) throw new Error(JSON.stringify(run.issues));
  return { dataset, definitions, run: run.run, suite: buildEvalSuiteReport({ dataset, definitions, run: run.run }) };
}

describe("comparison identity: resultId is observation identity, the comparison key is logical identity", () => {
  it("the same case on provider A / run A / trace A and provider B / run B / trace B: evidence fingerprints and result ids differ, comparison keys and semantic verdict fingerprints are equal", async () => {
    const caseIdentity = { datasetRef, caseId: "portability.model-then-tool.001" };
    const a = await evaluate({ definition: definition("trajectory.model-then-tool"), mode: "OFFLINE", evidence: loadFixture("portability-provider-a"), registry: registry(), ...caseIdentity });
    const b = await evaluate({ definition: definition("trajectory.model-then-tool"), mode: "OFFLINE", evidence: loadFixture("portability-provider-b"), registry: registry(), ...caseIdentity });
    expect(a.status).toBe("passed");
    expect(b.status).toBe("passed");
    expect(a.runId).not.toBe(b.runId);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.evidenceFingerprint).not.toBe(b.evidenceFingerprint);
    expect(a.resultId).not.toBe(b.resultId);
    expect(a.evidenceRefs).not.toEqual(b.evidenceRefs);
    expect(buildEvalComparisonKey(a)).toBe(buildEvalComparisonKey(b));
    expect(semanticVerdictFingerprint(a)).toBe(semanticVerdictFingerprint(b));
    expect(buildEvalComparisonKey(a)).toMatch(/^evk\.[a-f0-9]{64}$/);
    expect(semanticVerdictFingerprint(a)).toMatch(/^evs\.[a-f0-9]{64}$/);
  });

  it("the key excludes run, trace, provider, model, result id, and evidence fingerprint — and includes every logical field", async () => {
    const result = await evaluate({ definition: definition("tool.lookup-required"), mode: "OFFLINE", evidence: loadFixture("flagship-approved"), registry: registry(), datasetRef, caseId: "tool.required-lookup-invoked.001" });
    const key = buildEvalComparisonKey(result);
    const noise: Partial<EvalResult> = { resultId: `evr.${"0".repeat(64)}`, runId: "run.other", traceId: "f".repeat(32), evidenceFingerprint: "e".repeat(64), evidenceRefs: [] };
    expect(buildEvalComparisonKey({ ...result, ...noise })).toBe(key);
    for (const change of [
      { evalRef: { ...result.evalRef, version: "9.9.9" } },
      { graderRef: { ...result.graderRef, version: "9.9.9" } },
      { datasetRef: { ...datasetRef, version: "9.9.9" } },
      { caseId: "tool.other.001" },
      { mode: "RUNTIME" as const },
      { targetType: "run" as const },
    ]) expect(buildEvalComparisonKey({ ...result, ...change })).not.toBe(key);
  });

  it("only dataset cases have a logical comparison identity", async () => {
    const adHoc = await evaluate({ definition: definition("tool.lookup-required"), mode: "OFFLINE", evidence: loadFixture("flagship-approved"), registry: registry() });
    expect(() => buildEvalComparisonKey(adHoc)).toThrow("EVAL_DATASET_INVALID");
  });

  it("the semantic verdict fingerprint changes with the judgment, never with evidence references", async () => {
    const passed = await evaluate({ definition: definition("approval.no-bypass"), mode: "OFFLINE", evidence: loadFixture("flagship-approved"), registry: registry(), datasetRef, caseId: "approval.bypass-detected.001" });
    const failed = await evaluate({ definition: definition("approval.no-bypass"), mode: "OFFLINE", evidence: loadFixture("negative-approval-bypass"), registry: registry(), datasetRef, caseId: "approval.bypass-detected.001" });
    expect(buildEvalComparisonKey(passed)).toBe(buildEvalComparisonKey(failed));
    expect(semanticVerdictFingerprint(passed)).not.toBe(semanticVerdictFingerprint(failed));
    expect(semanticVerdictFingerprint({ ...failed, evidenceRefs: [], assertions: failed.assertions.map((entry) => ({ ...entry, evidenceRefs: [] })) })).toBe(semanticVerdictFingerprint(failed));
  });
});

describe("case expectation verdict ≠ EvalResult status", () => {
  const caseIdentity = { datasetRef, caseId: "case.001" };

  it("actual failed + expected failed(APPROVAL_BYPASSED) → MATCHED; a different reason → MISMATCHED; passed → MISMATCHED", async () => {
    const failed = await evaluate({ definition: definition("approval.no-bypass"), mode: "OFFLINE", evidence: loadFixture("negative-approval-bypass"), registry: registry(), ...caseIdentity });
    expect(failed.status).toBe("failed");
    expect(caseExpectationVerdict({ status: "failed", reasonCodes: ["APPROVAL_BYPASSED"] }, failed)).toBe("MATCHED");
    expect(caseExpectationVerdict({ status: "failed", reasonCodes: ["TOOL_AFTER_REJECTED_APPROVAL"] }, failed)).toBe("MISMATCHED");
    expect(caseExpectationVerdict({ status: "passed" }, failed)).toBe("MISMATCHED");
  });

  it("actual error + expected error(EVAL_REQUIRED_EVIDENCE_INCOMPLETE) → MATCHED; an unexpected error code never matches (ERROR)", async () => {
    const incomplete = await evaluate({ definition: definition("metrics.cost-budget"), mode: "OFFLINE", evidence: loadFixture("metrics-cost-unavailable"), registry: registry(), ...caseIdentity });
    expect(incomplete).toMatchObject({ status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" });
    expect(caseExpectationVerdict({ status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" }, incomplete)).toBe("MATCHED");
    expect(caseExpectationVerdict({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING" }, incomplete)).toBe("ERROR");
    expect(caseExpectationVerdict({ status: "passed" }, incomplete)).toBe("ERROR");
  });

  it("expected error but a trustworthy judgment → MISMATCHED (not ERROR)", async () => {
    const passed = await evaluate({ definition: definition("tool.lookup-required"), mode: "OFFLINE", evidence: loadFixture("flagship-approved"), registry: registry(), ...caseIdentity });
    expect(caseExpectationVerdict({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING" }, passed)).toBe("MISMATCHED");
  });
});

describe("EvalSuiteReport", () => {
  it("foundation: 35 cases, all matched, raw statuses kept separate from expectations, critical categories broken down, schema-valid", async () => {
    const { suite } = await foundationSuite();
    expect(EvalSuiteReportSchema.parse(JSON.parse(JSON.stringify(suite)))).toEqual(suite);
    expect(suite.datasetRef).toEqual(datasetRef);
    expect(suite.summary).toEqual({ casesTotal: 35, expectationsMatched: 35, expectationsMismatched: 0, expectationErrors: 0, expectationMatchRate: 1, rawStatuses: { passed: 19, failed: 10, error: 6 }, averageScore: { status: "unavailable" } });
    expect(suite.criticalFindings).toEqual([]);
    const breakdown = Object.fromEntries(suite.categoryBreakdown.map((entry) => [entry.category, entry]));
    expect(breakdown.approval).toMatchObject({ matched: breakdown.approval!.total, mismatched: 0, errors: 0 });
    expect(breakdown.authorization!.total).toBeGreaterThanOrEqual(3);
    expect(breakdown.trace_contract!.total).toBe(2);
    const bypass = suite.cases.find((entry) => entry.caseId === "approval.bypass-detected.001")!;
    expect(bypass).toMatchObject({ expected: { status: "failed", reasonCodes: ["APPROVAL_BYPASSED"] }, actual: { status: "failed", reasonCodes: ["APPROVAL_BYPASSED"] }, expectation: "MATCHED", categories: ["safety", "approval"] });
    const incomplete = suite.cases.find((entry) => entry.caseId === "retry.incomplete-run-not-judged.001")!;
    expect(incomplete).toMatchObject({ actual: { status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" }, expectation: "MATCHED" });
  });

  it("a mismatched critical case is a critical finding; metadata never changes the semantic fingerprint", async () => {
    const { dataset, definitions, run, suite } = await foundationSuite();
    const index = run.cases.findIndex((entry) => entry.caseId === "approval.bypass-detected.001");
    const passedInstead = await evaluate({ definition: definition("approval.no-bypass"), mode: "OFFLINE", evidence: loadFixture("flagship-approved"), registry: registry(), datasetRef, caseId: "approval.bypass-detected.001" });
    const cases = run.cases.map((entry, position) => (position === index ? { ...entry, matchesExpectation: false, result: passedInstead } : entry));
    const broken = buildEvalSuiteReport({ dataset, definitions, run: { ...run, cases } });
    expect(broken.summary).toMatchObject({ expectationsMatched: 34, expectationsMismatched: 1, expectationMatchRate: 34 / 35 });
    expect(broken.criticalFindings).toEqual([{ caseId: "approval.bypass-detected.001", comparisonKey: suite.cases[index]!.comparisonKey, categories: ["safety", "approval"], expectation: "MISMATCHED" }]);
    expect(broken.semanticFingerprint).not.toBe(suite.semanticFingerprint);
    const stamped = buildEvalSuiteReport({ dataset, definitions, run, metadata: { generatedAt: "2026-10-13T12:00:00.000Z", gitSha: "abcdef1", environment: "ci" } });
    expect(stamped.semanticFingerprint).toBe(suite.semanticFingerprint);
    expect(stamped.cases).toEqual(suite.cases);
  });
});

describe("baseline comparison classifies every logical case once", () => {
  const baselineOf = (suite: unknown) => proposeEvalBaseline({ suite, id: "test-baseline", version: "1.0.0" });

  it("unchanged, regression (matched → mismatched, even when both results are `failed`), improvement, new, missing", async () => {
    const { dataset, definitions, run, suite } = await foundationSuite();
    const baseline = baselineOf(suite);
    const same = compareEvalSuites({ baseline, candidate: suite });
    expect(same.ok && same.report.summary).toEqual({ unchangedMatch: 35, unchangedMismatch: 0, regressions: 0, improvements: 0, newCases: 0, missingCases: 0, incompatible: 0 });

    // A negative case whose *failure reason* changed: both results are `failed`, yet the case regressed.
    const wrongReason = await evaluate({ definition: definition("approval.no-bypass"), mode: "OFFLINE", evidence: loadFixture("authorization-denied"), registry: registry(), datasetRef, caseId: "approval.bypass-detected.001" });
    expect(wrongReason.assertions.filter((entry) => entry.status === "failed").map((entry) => entry.reasonCode)).toEqual(["APPROVAL_NOT_REQUESTED"]);
    const swapped = run.cases.map((entry) => (entry.caseId === "approval.bypass-detected.001" ? { ...entry, matchesExpectation: false, result: wrongReason } : entry));
    const regressed = buildEvalSuiteReport({ dataset, definitions, run: { ...run, cases: swapped } });
    const compared = compareEvalSuites({ baseline, candidate: regressed });
    if (!compared.ok) throw new Error(compared.detail);
    const entry = compared.report.entries.find((candidate) => candidate.caseId === "approval.bypass-detected.001")!;
    expect(entry).toMatchObject({ classification: "REGRESSION", baseline: { expectation: "MATCHED", actual: { status: "failed" } }, candidate: { expectation: "MISMATCHED", actual: { status: "failed" } } });
    expect(compared.report.findings).toEqual([expect.objectContaining({ caseId: "approval.bypass-detected.001", classification: "REGRESSION", severity: "critical", reasonCodes: expect.arrayContaining(["EVAL_GATE_CRITICAL_REGRESSION"]) })]);

    // Reverse direction: the regressed state as baseline, the healthy suite as candidate.
    const improved = compareEvalSuites({ baseline: baselineOf(regressed), candidate: suite });
    expect(improved.ok && improved.report.summary).toMatchObject({ improvements: 1, regressions: 0, unchangedMatch: 34 });

    // Missing: the candidate did not execute a baseline case. New: the candidate has a case the baseline lacks.
    const subset = buildEvalSuiteReport({ dataset, definitions, run: { ...run, cases: run.cases.filter((candidate) => candidate.caseId !== "trace.flagship-approved-valid.001") } });
    const missing = compareEvalSuites({ baseline, candidate: subset });
    expect(missing.ok && missing.report.summary).toMatchObject({ missingCases: 1, unchangedMatch: 34 });
    expect(missing.ok && missing.report.findings[0]).toMatchObject({ classification: "MISSING_CASE", severity: "critical", reasonCodes: ["EVAL_COMPARISON_MISSING_CASE"] });
    const fresh = compareEvalSuites({ baseline: baselineOf(subset), candidate: suite });
    expect(fresh.ok && fresh.report.summary).toMatchObject({ newCases: 1, unchangedMatch: 34, missingCases: 0 });
    expect(fresh.ok && fresh.report.findings).toEqual([]);
  });

  it("a changed Eval, grader, or dataset version is INCOMPATIBLE — never a regression — unless a dataset version is explicitly declared compatible", async () => {
    const { suite } = await foundationSuite();
    const baseline = baselineOf(suite);
    const bumpEval = { ...suite, cases: suite.cases.map((entry) => (entry.caseId === "tool.required-lookup-invoked.001" ? { ...entry, identity: { ...entry.identity, evalRef: { ...entry.identity.evalRef, version: "1.1.0" } } } : entry)) };
    const evalChange = compareEvalSuites({ baseline, candidate: bumpEval });
    expect(evalChange.ok && evalChange.report.summary).toMatchObject({ incompatible: 1, regressions: 0, unchangedMatch: 34 });
    expect(evalChange.ok && evalChange.report.entries.find((entry) => entry.classification === "INCOMPATIBLE")).toMatchObject({ caseId: "tool.required-lookup-invoked.001", incompatibleFields: ["evalRef.version"] });
    const nextDataset = { ...datasetRef, version: "2.1.0" };
    const datasetBump = { ...suite, datasetRef: nextDataset, cases: suite.cases.map((entry) => ({ ...entry, identity: { ...entry.identity, datasetRef: nextDataset } })) };
    const silent = compareEvalSuites({ baseline, candidate: datasetBump });
    expect(silent.ok && silent.report.summary).toMatchObject({ incompatible: 35, regressions: 0 });
    const declared = compareEvalSuites({ baseline, candidate: datasetBump, compatibleBaselineDatasetVersions: ["2.0.0"] });
    expect(declared.ok && declared.report.summary).toMatchObject({ unchangedMatch: 35, incompatible: 0 });
    expect(compareEvalSuites({ baseline, candidate: { ...datasetBump, datasetRef: { id: "other.dataset", version: "1.0.0" } } })).toMatchObject({ ok: false });
  });

  it("scores are compared only for comparable cases", async () => {
    const { suite } = await foundationSuite();
    const scored = (score: number) => ({ ...suite, cases: suite.cases.map((entry, index) => (index === 0 ? { ...entry, actual: { ...entry.actual, score } } : entry)) });
    const compared = compareEvalSuites({ baseline: baselineOf(scored(0.9)), candidate: scored(0.6) });
    expect(compared.ok && compared.report.entries[0]!.scoreDelta).toBe(-0.3);
    const incompatible = scored(0.6);
    incompatible.cases[0] = { ...incompatible.cases[0]!, identity: { ...incompatible.cases[0]!.identity, graderRef: { ...incompatible.cases[0]!.identity.graderRef, version: "2.0.0" } } };
    const notCompared = compareEvalSuites({ baseline: baselineOf(scored(0.9)), candidate: incompatible });
    expect(notCompared.ok && notCompared.report.entries[0]).toMatchObject({ classification: "INCOMPATIBLE" });
    expect(notCompared.ok && notCompared.report.entries[0]!.scoreDelta).toBeUndefined();
  });
});

describe("multi-run analytics", () => {
  it("aggregates compatible suite reports: stability, regression frequency, error frequency", async () => {
    const { dataset, definitions, run, suite } = await foundationSuite();
    const wrong = await evaluate({ definition: definition("approval.no-bypass"), mode: "OFFLINE", evidence: loadFixture("flagship-approved"), registry: registry(), datasetRef, caseId: "approval.bypass-detected.001" });
    const regressed = buildEvalSuiteReport({ dataset, definitions, run: { ...run, cases: run.cases.map((entry) => (entry.caseId === "approval.bypass-detected.001" ? { ...entry, result: wrong } : entry)) } });
    const analytics = analyzeEvalSuites([suite, suite, regressed]);
    expect(analytics).toMatchObject({ runsObserved: 3, datasetRef, errorFrequency: 0 });
    expect(analytics.regressionFrequency).toBeCloseTo(1 / 70);
    expect(analytics.caseStabilityRate).toBeCloseTo(34 / 35);
    expect(analytics.cases.find((entry) => entry.caseId === "approval.bypass-detected.001")).toMatchObject({ observed: 3, matched: 2, mismatched: 1, stable: false, regressions: 1 });
    expect(analyzeEvalSuites([suite])).toMatchObject({ regressionFrequency: null, caseStabilityRate: 1 });
    expect(() => analyzeEvalSuites([suite, { ...suite, datasetRef: { ...datasetRef, version: "3.0.0" }, cases: suite.cases.map((entry) => ({ ...entry, identity: { ...entry.identity, datasetRef: { ...datasetRef, version: "3.0.0" } } })) }])).toThrow("EVAL_DATASET_INVALID");
    expect(() => analyzeEvalSuites([])).toThrow();
  });
});
