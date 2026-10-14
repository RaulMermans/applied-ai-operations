import { describe, expect, it } from "vitest";
import { EVAL_CANONICAL_CRITICAL_CATEGORIES, EvalBaselineSchema, EvalGateDecisionSchema, EvalGateMetricRuleSchema, EvalGatePolicySchema, EvalMeasurementSchema, EvalSuiteCaseSchema, EvalVerdictSummarySchema } from "../src/index.js";

const identity = { evalRef: { id: "tool.lookup-required", version: "1.0.0" }, graderRef: { id: "aao.tool-usage", version: "1.0.0" }, datasetRef: { id: "aao.runtime-foundation", version: "2.0.0" }, caseId: "tool.required.001", mode: "OFFLINE", targetType: "tool_use" };
const suiteCase = { caseId: "tool.required.001", comparisonKey: `evk.${"a".repeat(64)}`, identity, categories: ["tool_use"], expected: { status: "passed" }, actual: { status: "passed", reasonCodes: [] }, expectation: "MATCHED", semanticVerdictFingerprint: `evs.${"b".repeat(64)}` };
const summary = { casesTotal: 1, expectationsMatched: 1, expectationsMismatched: 0, expectationErrors: 0, expectationMatchRate: 1, rawStatuses: { passed: 1, failed: 0, error: 0 }, averageScore: { status: "unavailable" } };
const policy = { schemaVersion: 1, id: "foundation-ci", version: "1.0.0", name: "Gate", datasetRef: identity.datasetRef, baselineRef: { id: "runtime-foundation", version: "1.0.0", fingerprint: "c".repeat(64) }, hardFail: { requireAllCasesPresent: true, requireExpectationMatchRate: 1, maxRegressions: 0, criticalCategories: [...EVAL_CANONICAL_CRITICAL_CATEGORIES] }, warnings: [] };
const decision = { schemaVersion: 1, policyRef: { id: "foundation-ci", version: "1.0.0" }, baselineRef: { id: "runtime-foundation", version: "1.0.0" }, datasetRef: identity.datasetRef, passed: true, outcome: "PASS", hardFailures: [], warnings: [], candidateSummary: summary, comparisonSummary: { unchangedMatch: 1, unchangedMismatch: 0, regressions: 0, improvements: 0, newCases: 0, missingCases: 0, incompatible: 0 }, findings: [] };

describe("Sprint 18 analytics contracts", () => {
  it("comparison keys and semantic fingerprints are distinct, prefixed hashes; verdict summaries are sorted and bounded", () => {
    expect(EvalSuiteCaseSchema.safeParse(suiteCase).success).toBe(true);
    expect(EvalSuiteCaseSchema.safeParse({ ...suiteCase, comparisonKey: `evr.${"a".repeat(64)}` }).success).toBe(false);
    expect(EvalSuiteCaseSchema.safeParse({ ...suiteCase, semanticVerdictFingerprint: "b".repeat(64) }).success).toBe(false);
    expect(EvalSuiteCaseSchema.safeParse({ ...suiteCase, identity: { ...identity, caseId: "other.001" } }).success).toBe(false);
    expect(EvalSuiteCaseSchema.safeParse({ ...suiteCase, identity: { ...identity, runId: "run.x" } }).success).toBe(false);
    expect(EvalVerdictSummarySchema.safeParse({ status: "failed", reasonCodes: ["B", "A"] }).success).toBe(false);
  });

  it("a measurement is a number only when complete", () => {
    expect(EvalMeasurementSchema.safeParse({ status: "complete", value: 1 }).success).toBe(true);
    expect(EvalMeasurementSchema.safeParse({ status: "partial", value: 1 }).success).toBe(false);
    expect(EvalMeasurementSchema.safeParse({ status: "unavailable", value: 0 }).success).toBe(false);
  });

  it("baselines are strict and belong to one dataset version", () => {
    const baseline = { schemaVersion: 1, id: "runtime-foundation", version: "1.0.0", datasetRef: identity.datasetRef, generatedFrom: { suiteSemanticFingerprint: "d".repeat(64) }, caseExpectations: [suiteCase], suiteSummary: summary };
    expect(EvalBaselineSchema.safeParse(baseline).success).toBe(true);
    expect(EvalBaselineSchema.safeParse({ ...baseline, datasetRef: { ...identity.datasetRef, version: "3.0.0" } }).success).toBe(false);
    expect(EvalBaselineSchema.safeParse({ ...baseline, caseExpectations: [suiteCase, suiteCase] }).success).toBe(false);
    expect(EvalBaselineSchema.safeParse({ ...baseline, autoUpdate: true }).success).toBe(false);
  });

  it("gate policies keep the canonical critical categories, carry no code, and never downgrade a required measurement", () => {
    expect(EvalGatePolicySchema.safeParse(policy).success).toBe(true);
    expect(EvalGatePolicySchema.safeParse({ ...policy, hardFail: { ...policy.hardFail, criticalCategories: ["approval", "safety", "trace_contract", "tool_use"] } }).success).toBe(false);
    expect(EvalGatePolicySchema.safeParse({ ...policy, hardFail: { ...policy.hardFail, criticalCategories: [...EVAL_CANONICAL_CRITICAL_CATEGORIES, "approval"] } }).success).toBe(false);
    expect(EvalGatePolicySchema.safeParse({ ...policy, javascript: "x" }).success).toBe(false);
    expect(EvalGatePolicySchema.safeParse({ ...policy, warnings: [{ id: "r", metric: "toolCalls", maxRegressionPercent: 10, severity: "advisory", command: "rm -rf" }] }).success).toBe(false);
    expect(EvalGateMetricRuleSchema.safeParse({ id: "r", metric: "toolCalls", maxRegressionPercent: 10, severity: "required", onMissingEvidence: "warn" }).success).toBe(false);
    expect(EvalGateMetricRuleSchema.safeParse({ id: "r", metric: "toolCalls", maxRegressionPercent: 10, severity: "advisory", onMissingEvidence: "fail" }).success).toBe(true);
  });

  it("a gate decision passes exactly when it has no hard failure, and its outcome is derived, not chosen", () => {
    expect(EvalGateDecisionSchema.safeParse(decision).success).toBe(true);
    expect(EvalGateDecisionSchema.safeParse({ ...decision, hardFailures: [{ code: "EVAL_GATE_CRITICAL_REGRESSION", rule: "critical-categories", caseIds: ["x.001"] }] }).success).toBe(false);
    expect(EvalGateDecisionSchema.safeParse({ ...decision, passed: false, outcome: "FAIL", hardFailures: [{ code: "EVAL_GATE_CRITICAL_REGRESSION", rule: "critical-categories", caseIds: ["x.001"] }] }).success).toBe(true);
    expect(EvalGateDecisionSchema.safeParse({ ...decision, outcome: "WARN" }).success).toBe(false);
    expect(EvalGateDecisionSchema.safeParse({ ...decision, runStatus: "CI_FAILED" }).success).toBe(false);
  });
});
