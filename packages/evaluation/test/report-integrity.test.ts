import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EvalBaseline, EvalSuiteReport } from "@aao/contracts";
import {
  analyzeEvalSuites,
  buildEvalSuiteReport,
  compareEvalSuites,
  evalBaselineFingerprint,
  evaluateEvalGate,
  parseEvalBaseline,
  parseEvalGatePolicy,
  proposeEvalBaseline,
  runEvalDataset,
  validateEvalBaselineIntegrity,
  validateEvalSuiteReportIntegrity,
} from "../src/index.js";
import { evalsRoot, fixtureResolver, loadDataset, loadDefinitions, registry } from "./support/evals.js";

async function genuineSuite(): Promise<EvalSuiteReport> {
  const dataset = loadDataset();
  const definitions = loadDefinitions();
  const run = await runEvalDataset({ dataset, definitions, registry: registry(), evidenceResolver: fixtureResolver() });
  if (!run.ok) throw new Error(JSON.stringify(run.issues));
  return buildEvalSuiteReport({ dataset, definitions, run: run.run });
}

function committedPolicyAndBaseline() {
  const policy = parseEvalGatePolicy(readFileSync(join(evalsRoot, "gates", "foundation-ci.v1.yaml"), "utf8"), "yaml");
  const baseline = parseEvalBaseline(readFileSync(join(evalsRoot, "baselines", "runtime-foundation.v1.json"), "utf8"));
  if (!policy.ok || !baseline.ok) throw new Error("committed gate assets are invalid");
  return { policy: policy.value, baseline: baseline.value };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A schema-valid expectation the case's actual verdict contradicts. */
const contradicting = (entry: EvalSuiteReport["cases"][number]): EvalSuiteReport["cases"][number]["expected"] =>
  entry.actual.status === "passed" ? { status: "failed", reasonCodes: ["FORGED_REASON"] } : { status: "passed" };

/** Every case judged MISMATCHED (consistently at case level) while the summary still self-attests a full match. */
function forgedAllMatchedSummary(suite: EvalSuiteReport): EvalSuiteReport {
  const forged = clone(suite);
  forged.cases = forged.cases.map((entry) => ({ ...entry, expected: contradicting(entry), expectation: entry.actual.status === "error" ? "ERROR" : "MISMATCHED" }));
  return forged;
}

describe("EvalSuiteReport integrity: summaries are recomputed, never self-attested", () => {
  it("a genuinely built report and the committed baseline are internally consistent", async () => {
    const suite = await genuineSuite();
    expect(validateEvalSuiteReportIntegrity(suite)).toEqual({ ok: true, value: suite });
    expect(validateEvalBaselineIntegrity(committedPolicyAndBaseline().baseline).ok).toBe(true);
    expect(validateEvalBaselineIntegrity(proposeEvalBaseline({ suite, id: "b", version: "1.0.0" })).ok).toBe(true);
  });

  it("forged report: cases mismatched, summary claims all matched → rejected by the validator, the gate, comparison, proposal, and analytics", async () => {
    const suite = await genuineSuite();
    const forged = forgedAllMatchedSummary(suite);
    expect(forged.summary.expectationsMatched).toBe(forged.summary.casesTotal);
    const verdict = validateEvalSuiteReportIntegrity(forged);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.issues).toEqual(expect.arrayContaining(["summary does not match the cases", "categoryBreakdown does not match the cases", "criticalFindings do not match the cases", "semanticFingerprint does not match the cases"]));

    const { policy, baseline } = committedPolicyAndBaseline();
    const gate = evaluateEvalGate({ policy, baseline, candidate: forged });
    expect(gate).toMatchObject({ ok: false, error: { code: "EVAL_SUITE_REPORT_INCONSISTENT" } });
    expect(compareEvalSuites({ baseline, candidate: forged })).toMatchObject({ ok: false, code: "EVAL_SUITE_REPORT_INCONSISTENT" });
    expect(() => proposeEvalBaseline({ suite: forged, id: "laundered", version: "1.0.0" })).toThrow("EVAL_SUITE_REPORT_INCONSISTENT");
    expect(() => analyzeEvalSuites([suite, forged])).toThrow("EVAL_SUITE_REPORT_INCONSISTENT");
  });

  it("each derived field is checked independently", async () => {
    const suite = await genuineSuite();
    const issuesOf = (mutate: (report: EvalSuiteReport) => void) => {
      const report = clone(suite);
      mutate(report);
      const result = validateEvalSuiteReportIntegrity(report);
      return result.ok ? [] : result.issues;
    };
    const first = suite.cases[0]!.caseId;
    // A case claims MATCHED although its actual verdict contradicts the declared expectation.
    expect(issuesOf((report) => { report.cases[0]!.actual = { status: report.cases[0]!.expected.status === "passed" ? "failed" : "passed", reasonCodes: [] }; })).toContain(`case ${first}: expectation MATCHED does not follow from expected and actual verdicts`);
    expect(issuesOf((report) => { report.summary.expectationMatchRate = 0.5; })).toEqual(["summary does not match the cases"]);
    expect(issuesOf((report) => { report.categoryBreakdown = []; })).toEqual(["categoryBreakdown does not match the cases"]);
    expect(issuesOf((report) => { report.semanticFingerprint = "0".repeat(64); })).toEqual(["semanticFingerprint does not match the cases"]);
    expect(issuesOf((report) => { report.cases[0]!.comparisonKey = `evk.${"0".repeat(64)}`; })).toContain(`case ${first}: comparisonKey does not match its identity`);
    // Hiding a critical finding: an unmatched Approval case whose finding was removed.
    const approval = suite.cases.findIndex((entry) => entry.categories.includes("approval"));
    expect(issuesOf((report) => {
      const entry = report.cases[approval]!;
      entry.expected = contradicting(entry);
      entry.expectation = entry.actual.status === "error" ? "ERROR" : "MISMATCHED";
    })).toContain("criticalFindings do not match the cases");
    expect(validateEvalSuiteReportIntegrity({ not: "a report" })).toMatchObject({ ok: false, code: "EVAL_SUITE_REPORT_INCONSISTENT" });
  });

  it("issues are bounded, and the verdict is deterministic", async () => {
    const forged = forgedAllMatchedSummary(await genuineSuite());
    const a = validateEvalSuiteReportIntegrity(forged);
    const b = validateEvalSuiteReportIntegrity(clone(forged));
    expect(a).toEqual(b);
    expect(!a.ok && a.issues.length).toBeLessThanOrEqual(20);
  });

  it("a self-inconsistent baseline is invalid even when a policy re-pins its fingerprint", () => {
    const { policy, baseline } = committedPolicyAndBaseline();
    const forged: EvalBaseline = clone(baseline);
    forged.suiteSummary = { ...forged.suiteSummary, expectationsMatched: forged.suiteSummary.expectationsMatched - 1 };
    const repinned = { ...policy, baselineRef: { ...policy.baselineRef, fingerprint: evalBaselineFingerprint(forged) } };
    expect(validateEvalBaselineIntegrity(forged)).toMatchObject({ ok: false, issues: ["suiteSummary does not match the case expectations"] });
    expect(evaluateEvalGate({ policy: repinned, baseline: forged, candidate: forged })).toMatchObject({ ok: false, error: { code: "EVAL_BASELINE_INVALID" } });
  });
});
