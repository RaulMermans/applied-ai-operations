import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvalGateDecisionSchema, type EvalBaseline, type EvalSuiteReport } from "@aao/contracts";
import { createEvaluatorRegistry, createStaticEvidenceResolver, deterministicGraders, evalBaselineFingerprint, evaluateEvalGate, evidenceFingerprint, parseEvalGatePolicy, runEvalDataset, zodConfig, type EvalEvidenceBundle, type EvalGrader } from "../src/index.js";
import { z } from "zod";
// The Eval CI host is the canonical `aao` CLI in @aao/framework since Sprint 19 (ADR-024); these Sprint 18 regressions run against it.
import { proposeBaseline } from "../../framework/src/cli/eval/baseline.js";
import { renderGateOutcome, runEvalCi } from "../../framework/src/cli/eval/ci.js";
import { loadFoundationInputs, runGatePipeline, type FoundationInputs } from "../../framework/src/cli/eval/host.js";
import { installNetworkGuard } from "../../framework/src/cli/eval/network-guard.js";
import { runCli } from "../../framework/src/cli/run.js";
import { evalsRoot, loadFixture, repositoryRoot } from "./support/evals.js";

/**
 * Sprint 18 gate E2E: the real host pipeline (pinned fixtures → dataset →
 * suite report → approved baseline → comparison → foundation-ci policy →
 * rendered output and exit code) over the committed assets, plus
 * deliberate candidate changes. Every candidate change here is in memory;
 * nothing under evals/ is ever written.
 */
const inputs = () => loadFoundationInputs(repositoryRoot);

/** A candidate whose case now resolves to different evidence, re-pinned the way a regenerated fixture would be. */
function repoint(base: FoundationInputs, caseId: string, evidence: EvalEvidenceBundle): FoundationInputs {
  const ref = `fixture://candidate-${caseId}`;
  const fixtures = new Map(base.fixtures);
  fixtures.set(ref, evidence);
  return { ...base, fixtures, dataset: { ...base.dataset, cases: base.dataset.cases.map((evalCase) => (evalCase.id === caseId ? { ...evalCase, evidenceRef: ref, evidenceFingerprint: evidenceFingerprint(evidence) } : evalCase)) } };
}

/** Deliberately accept a different baseline: re-pin the policy to its fingerprint. */
function withBaseline(base: FoundationInputs, baseline: EvalBaseline): FoundationInputs {
  return { ...base, baseline, policy: { ...base.policy, baselineRef: { id: baseline.id, version: baseline.version, fingerprint: evalBaselineFingerprint(baseline) } } };
}

const hashTree = (dir: string): string => {
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)])).sort();
  const hash = createHash("sha256");
  for (const file of walk(dir)) hash.update(file).update(readFileSync(file));
  return hash.digest("hex");
};

describe("baseline comparison E2E", () => {
  it("Candidate A — the committed state: 0 regressions, every expectation matched, gate PASS, exit 0", async () => {
    const outcome = await runGatePipeline(inputs());
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.decision).toMatchObject({ passed: true, outcome: "PASS", hardFailures: [], warnings: [], policyRef: { id: "foundation-ci", version: "1.0.0" }, baselineRef: { id: "runtime-foundation", version: "1.0.0" }, datasetRef: { id: "aao.runtime-foundation", version: "2.0.0" } });
    expect(outcome.decision.comparisonSummary).toEqual({ unchangedMatch: 35, unchangedMismatch: 0, regressions: 0, improvements: 0, newCases: 0, missingCases: 0, incompatible: 0 });
    expect(EvalGateDecisionSchema.parse(JSON.parse(JSON.stringify(outcome.decision)))).toEqual(outcome.decision);
    const rendered = renderGateOutcome(outcome, { format: "text" });
    expect(rendered.exitCode).toBe(0);
    expect(rendered.output).toContain("Cases: 35/35 matched\nRegressions: 0");
    expect(rendered.output.trimEnd().endsWith("PASS")).toBe(true);
  });

  it("Candidate B — the Authorization-denial case now shows the handler executing after the denial: 1 REGRESSION, critical failure, gate FAIL, exit 1", async () => {
    const outcome = await runGatePipeline(repoint(inputs(), "tool.blocked-not-invoked.001", loadFixture("negative-denied-then-executed")));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.decision.comparisonSummary).toMatchObject({ regressions: 1, unchangedMatch: 34 });
    expect(outcome.decision.passed).toBe(false);
    expect(outcome.decision.hardFailures).toContainEqual({ code: "EVAL_GATE_CRITICAL_REGRESSION", rule: "critical-categories", caseIds: ["tool.blocked-not-invoked.001"] });
    expect(outcome.decision.findings).toEqual([expect.objectContaining({ caseId: "tool.blocked-not-invoked.001", classification: "REGRESSION", severity: "critical", categories: ["tool_use", "safety", "authorization"] })]);
    const rendered = renderGateOutcome(outcome, { format: "text" });
    expect(rendered.exitCode).toBe(1);
    expect(rendered.output).toContain("Critical failures: 1");
    expect(rendered.output.trimEnd().endsWith("FAIL")).toBe(true);
  });

  it("negative and deliberate-error cases are successful regression cases, not CI failures", async () => {
    const outcome = await runGatePipeline(inputs());
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    const byId = new Map(outcome.suite.cases.map((entry) => [entry.caseId, entry]));
    expect(byId.get("approval.bypass-detected.001")).toMatchObject({ actual: { status: "failed", reasonCodes: ["APPROVAL_BYPASSED"] }, expectation: "MATCHED" });
    expect(byId.get("approval.multi-unrelated-approval-no-authority.001")).toMatchObject({ actual: { status: "failed", reasonCodes: ["APPROVAL_BYPASSED"] }, expectation: "MATCHED" });
    expect(byId.get("metrics.cost-unavailable-not-passed.001")).toMatchObject({ actual: { status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" }, expectation: "MATCHED" });
    expect(byId.get("retry.incomplete-run-not-judged.001")).toMatchObject({ actual: { status: "error", errorCode: "EVAL_REQUIRED_EVIDENCE_INCOMPLETE" }, expectation: "MATCHED" });
    expect(outcome.suite.summary.rawStatuses).toEqual({ passed: 19, failed: 10, error: 6 });
    expect(outcome.decision.passed).toBe(true);
  });

  it("critical regression — the Approval-bypass case no longer detects the bypass: hard fail, exit 1", async () => {
    const outcome = await runGatePipeline(repoint(inputs(), "approval.bypass-detected.001", loadFixture("flagship-approved")));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.decision.hardFailures.map((failure) => failure.code)).toEqual(expect.arrayContaining(["EVAL_GATE_CRITICAL_REGRESSION", "EVAL_GATE_EXPECTATION_MISMATCH", "EVAL_GATE_REGRESSION_LIMIT"]));
    expect(renderGateOutcome(outcome, { format: "text" }).exitCode).toBe(1);
  });

  it("an unexpected Eval error in a required case fails the gate (infrastructure inability is never success)", async () => {
    const outcome = await runGatePipeline(repoint(inputs(), "tool.required-lookup-invoked.001", loadFixture("execution-only")));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.suite.cases.find((entry) => entry.caseId === "tool.required-lookup-invoked.001")).toMatchObject({ actual: { status: "error", errorCode: "EVAL_EVIDENCE_MISSING" }, expectation: "ERROR" });
    expect(outcome.decision.hardFailures).toContainEqual({ code: "EVAL_GATE_UNEXPECTED_ERROR", rule: "unexpected-eval-error", caseIds: ["tool.required-lookup-invoked.001"] });
    expect(outcome.decision.passed).toBe(false);
  });
});

describe("missing, mutated, and incompatible evidence", () => {
  it("missing case — a required baseline case was not executed: MISSING_CASE, gate FAIL", async () => {
    const base = inputs();
    const outcome = await runGatePipeline({ ...base, caseIds: base.dataset.cases.map((evalCase) => evalCase.id).filter((id) => id !== "approval.bypass-detected.001") });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.decision.comparisonSummary).toMatchObject({ missingCases: 1, unchangedMatch: 34 });
    expect(outcome.decision.hardFailures).toContainEqual({ code: "EVAL_COMPARISON_MISSING_CASE", rule: "require-all-cases-present", caseIds: ["approval.bypass-detected.001"] });
    expect(renderGateOutcome(outcome, { format: "text" }).exitCode).toBe(1);
  });

  it("fixture mutation — content changed without a re-pinned fingerprint: EVAL_FIXTURE_FINGERPRINT_MISMATCH, no evaluation, no rewrite, no regression wording", async () => {
    const before = readFileSync(join(evalsRoot, "datasets", "runtime-foundation.v2.yaml"), "utf8");
    const base = inputs();
    const tampered = JSON.parse(JSON.stringify(base.fixtures.get("fixture://flagship-approved"))) as { trace: Array<{ payload: Record<string, unknown> }> };
    tampered.trace[0]!.payload.nodeCount = 99;
    const fixtures = new Map(base.fixtures);
    fixtures.set("fixture://flagship-approved", tampered as unknown as EvalEvidenceBundle);
    const outcome = await runGatePipeline({ ...base, fixtures });
    expect(outcome).toMatchObject({ ok: false, error: { code: "EVAL_FIXTURE_FINGERPRINT_MISMATCH" } });
    expect("suite" in outcome && outcome.suite).toBeFalsy();
    const rendered = renderGateOutcome(outcome, { format: "text" });
    expect(rendered.exitCode).toBe(1);
    expect(rendered.output).toContain("GATE ERROR EVAL_FIXTURE_FINGERPRINT_MISMATCH");
    expect(rendered.output).not.toMatch(/REGRESSION|Regressions/);
    expect(readFileSync(join(evalsRoot, "datasets", "runtime-foundation.v2.yaml"), "utf8")).toBe(before);
  });

  it("a fingerprint mismatch inside a dataset run reaches no grader", async () => {
    let calls = 0;
    const counting: EvalGrader = { id: "aao.tool-usage", version: "1.0.0", supportedModes: ["OFFLINE"], supportedTargetTypes: ["tool_use"], validateConfig: zodConfig(z.object({}).passthrough()), evaluate: () => { calls += 1; return { kind: "judged", assertions: [{ id: "x", status: "passed", evidenceRefs: [] }] }; } };
    const base = inputs();
    const dataset = { ...base.dataset, cases: base.dataset.cases.filter((evalCase) => evalCase.id === "tool.required-lookup-invoked.001").map((evalCase) => ({ ...evalCase, evidenceFingerprint: "0".repeat(64) })) };
    const outcome = await runEvalDataset({ dataset, definitions: base.definitions, registry: createEvaluatorRegistry([counting]), evidenceResolver: createStaticEvidenceResolver([...base.fixtures.entries()]) });
    expect(outcome.ok && outcome.run.cases[0]!.result).toMatchObject({ status: "error", errorCode: "EVAL_FIXTURE_FINGERPRINT_MISMATCH", assertions: [] });
    expect(outcome.ok && outcome.run.cases[0]!.matchesExpectation).toBe(false);
    expect(calls).toBe(0);
  });

  it("version incompatibility — a changed EvalDefinition version is INCOMPATIBLE, never a false regression", async () => {
    const base = inputs();
    const definitions = base.definitions.map((entry) => (entry.id === "tool.lookup-required" ? { ...entry, version: "1.1.0" } : entry));
    const dataset = { ...base.dataset, cases: base.dataset.cases.map((evalCase) => (evalCase.evalRef.id === "tool.lookup-required" ? { ...evalCase, evalRef: { ...evalCase.evalRef, version: "1.1.0" } } : evalCase)) };
    const outcome = await runGatePipeline({ ...base, definitions, dataset });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.decision.comparisonSummary).toMatchObject({ incompatible: 3, regressions: 0, unchangedMatch: 32 });
    expect(outcome.decision.hardFailures).toEqual([{ code: "EVAL_BASELINE_INCOMPATIBLE", rule: "comparison-compatibility", caseIds: ["trace.corrupt-evidence-not-judged.001", "tool.required-lookup-invoked.001", "tool.missing-trace-not-passed.001"] }]);
    const rendered = renderGateOutcome(outcome, { format: "text" });
    expect(rendered.output).toContain("Regressions: 0");
    expect(rendered.output).toContain("Incompatible: 3");
    expect(rendered.exitCode).toBe(1);
  });

  it("a different dataset version without an explicit compatibility rule is a gate error with no trustworthy comparison", async () => {
    const base = inputs();
    const outcome = await runGatePipeline({ ...base, dataset: { ...base.dataset, version: "2.1.0" } });
    expect(outcome).toMatchObject({ ok: false, error: { code: "EVAL_BASELINE_INCOMPATIBLE" } });
    expect(renderGateOutcome(outcome, { format: "text" }).output).toContain("No trustworthy comparison occurred.");
  });
});

describe("operational warnings and partial evidence", () => {
  async function committedSuite(): Promise<EvalSuiteReport> {
    const outcome = await runGatePipeline(inputs());
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    return outcome.suite;
  }
  const withMetric = (suite: EvalSuiteReport, metric: string, measurement: object): EvalSuiteReport => ({ ...suite, operational: { ...suite.operational!, metrics: { ...suite.operational!.metrics, [metric]: measurement } } });

  it("performance warning — baseline p95 1000 ms, candidate 1250 ms, threshold 20%: WARN, gate still PASS, exit 0", async () => {
    const suite = await committedSuite();
    const base = inputs();
    const accepted = withBaseline(base, { ...base.baseline, performanceBaseline: { ...base.baseline.performanceBaseline!, metrics: { ...base.baseline.performanceBaseline!.metrics, runDurationP95Ms: { status: "complete", value: 1000 } } } });
    const gate = evaluateEvalGate({ policy: accepted.policy, baseline: accepted.baseline, candidate: withMetric(suite, "runDurationP95Ms", { status: "complete", value: 1250 }) });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    expect(gate.decision).toMatchObject({ passed: true, outcome: "WARN", hardFailures: [], warnings: [{ code: "EVAL_GATE_METRIC_REGRESSION", ruleId: "latency-p95", metric: "runDurationP95Ms", baseline: 1000, candidate: 1250, changePercent: 25 }] });
    const rendered = renderGateOutcome({ ok: true, suite, decision: gate.decision, comparison: gate.comparison }, { format: "text" });
    expect(rendered.exitCode).toBe(0);
    expect(rendered.output).toContain("WARN latency-p95 runDurationP95Ms +25%");
    // Within threshold: no warning. Marked required: the same movement hard-fails.
    const within = evaluateEvalGate({ policy: accepted.policy, baseline: accepted.baseline, candidate: withMetric(suite, "runDurationP95Ms", { status: "complete", value: 1100 }) });
    expect(within.ok && within.decision.outcome).toBe("PASS");
    const required = { ...accepted.policy, version: "1.1.0", warnings: accepted.policy.warnings.map((rule) => (rule.id === "latency-p95" ? { ...rule, severity: "required" as const, onMissingEvidence: "fail" as const } : rule)) };
    const strict = evaluateEvalGate({ policy: required, baseline: accepted.baseline, candidate: withMetric(suite, "runDurationP95Ms", { status: "complete", value: 1250 }) });
    expect(strict.ok && strict.decision.hardFailures).toEqual([{ code: "EVAL_GATE_METRIC_REGRESSION", rule: "latency-p95", metric: "runDurationP95Ms" }]);
  });

  it("partial metric — unavailable candidate cost: advisory rule warns, the same rule required with onMissingEvidence fail fails; unknown never passes", async () => {
    const suite = await committedSuite();
    const base = inputs();
    const costRule = (severity: "advisory" | "required", onMissingEvidence: "warn" | "fail") => ({ ...base.policy, version: "9.0.0", warnings: [{ id: "modelled-cost", metric: "estimatedCostNanos" as const, maxRegressionPercent: 15, severity, onMissingEvidence }] });
    const candidate = withMetric(suite, "estimatedCostNanos", { status: "unavailable" });
    const advisory = evaluateEvalGate({ policy: costRule("advisory", "warn"), baseline: base.baseline, candidate });
    expect(advisory.ok && advisory.decision).toMatchObject({ passed: true, outcome: "WARN", warnings: [{ code: "EVAL_GATE_INCOMPLETE_EVIDENCE", ruleId: "modelled-cost", candidate: null, changePercent: null }] });
    const required = evaluateEvalGate({ policy: costRule("required", "fail"), baseline: base.baseline, candidate });
    expect(required.ok && required.decision).toMatchObject({ passed: false, outcome: "FAIL", hardFailures: [{ code: "EVAL_GATE_INCOMPLETE_EVIDENCE", rule: "modelled-cost", metric: "estimatedCostNanos" }] });
    expect(parseEvalGatePolicy(JSON.stringify(costRule("required", "warn")), "json")).toMatchObject({ ok: false, code: "EVAL_GATE_POLICY_INVALID" });
    // The committed baseline's modelled cost is itself partial (a deliberately unpriced fixture): an advisory rule on it can only warn.
    expect(base.baseline.performanceBaseline!.metrics.estimatedCostNanos).toEqual({ status: "partial" });
  });
});

describe("gate policy and baseline integrity", () => {
  const policySource = () => readFileSync(join(evalsRoot, "gates", "foundation-ci.v1.yaml"), "utf8");

  it("the committed policy parses; critical categories cannot be weakened; code, unknown keys, and unbounded input are refused", () => {
    const parsed = parseEvalGatePolicy(policySource(), "yaml");
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const policy = parsed.value;
    expect(policy.hardFail.criticalCategories).toEqual(["approval", "authorization", "safety", "trace_contract"]);
    const reject = (value: unknown) => expect(parseEvalGatePolicy(JSON.stringify(value), "json")).toMatchObject({ ok: false, code: "EVAL_GATE_POLICY_INVALID" });
    for (const category of ["approval", "authorization", "safety", "trace_contract"]) reject({ ...policy, hardFail: { ...policy.hardFail, criticalCategories: policy.hardFail.criticalCategories.filter((entry) => entry !== category) } });
    reject({ ...policy, approvalBypass: "warn" });
    reject({ ...policy, hardFail: { ...policy.hardFail, modulePath: "./gate.js" } });
    reject({ ...policy, warnings: [{ ...policy.warnings[0], shellCommand: "curl evil" }] });
    reject({ ...policy, script: "process.exit(0)" });
    reject({ ...policy, warnings: Array.from({ length: 17 }, (_, index) => ({ id: `rule-${index}`, metric: "toolCalls", maxRegressionPercent: 10, severity: "advisory" })) });
    reject({ ...policy, warnings: [policy.warnings[0], policy.warnings[0]] });
    reject({ ...policy, description: "x".repeat(17 * 1024) });
    expect(parseEvalGatePolicy("schemaVersion: 1\nid: !!js/function 'function () {}'\n", "yaml").ok).toBe(false);
  });

  it("a baseline edited in place (immutable within its version) or a mismatched pin is EVAL_BASELINE_INVALID", async () => {
    const base = inputs();
    const edited = { ...base.baseline, caseExpectations: base.baseline.caseExpectations.map((entry, index) => (index === 0 ? { ...entry, expectation: "MISMATCHED" as const } : entry)) };
    const suite = await runGatePipeline(base);
    if (!suite.ok) throw new Error("pipeline");
    expect(evaluateEvalGate({ policy: base.policy, baseline: edited, candidate: suite.suite })).toMatchObject({ ok: false, error: { code: "EVAL_BASELINE_INVALID" } });
    expect(evaluateEvalGate({ policy: { ...base.policy, baselineRef: { ...base.policy.baselineRef, version: "2.0.0" } }, baseline: base.baseline, candidate: suite.suite })).toMatchObject({ ok: false, error: { code: "EVAL_BASELINE_INVALID" } });
    expect(evaluateEvalGate({ policy: { ...base.policy, hardFail: { ...base.policy.hardFail, criticalCategories: ["approval"] } }, baseline: base.baseline, candidate: suite.suite })).toMatchObject({ ok: false, error: { code: "EVAL_GATE_POLICY_INVALID" } });
  });

  it("the committed baseline is exactly what the current deterministic suite proposes, and proposing writes nothing", async () => {
    const before = hashTree(evalsRoot);
    const proposal = await proposeBaseline({ root: repositoryRoot, id: "runtime-foundation", version: "1.0.0" });
    expect(proposal.exitCode).toBe(0);
    const parsed = JSON.parse(proposal.output) as { kind: string; notice: string; unmatchedCases: string[]; baselineRef: { fingerprint: string }; baseline: EvalBaseline };
    expect(parsed.kind).toBe("aao.eval-baseline-proposal");
    expect(parsed.notice).toMatch(/^PROPOSAL ONLY — nothing was written/);
    expect(parsed.unmatchedCases).toEqual([]);
    expect(parsed.baseline).toEqual(inputs().baseline);
    expect(parsed.baselineRef.fingerprint).toBe(inputs().policy.baselineRef.fingerprint);
    expect(hashTree(evalsRoot)).toBe(before);
    expect((await runCli(["eval", "baseline", "propose", "--", "--id", "x"], { cwd: repositoryRoot })).exitCode).toBe(1);
  });

  it("CI reads the baseline and never writes it: no file under evals/ changes, and the CLI host has no write path", async () => {
    const before = hashTree(evalsRoot);
    expect((await runEvalCi({ root: repositoryRoot })).exitCode).toBe(0);
    expect(hashTree(evalsRoot)).toBe(before);
    const cliDir = join(repositoryRoot, "packages", "framework", "src", "cli");
    const files = readdirSync(cliDir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect(readFileSync(join(cliDir, file), "utf8"), file).not.toMatch(/writeFile|appendFile|renameSync|unlink|mkdirSync|rmSync|createWriteStream|--accept-all|acceptAll/);
  });
});

describe("CLI output, exit semantics, determinism, offline", () => {
  it("text output is compact; JSON output is machine-readable with no ANSI", async () => {
    const text = await runEvalCi({ root: repositoryRoot });
    expect(text.output.split("\n").length).toBeLessThan(20);
    expect(text.output).not.toContain("evr.");
    const json = await runEvalCi({ root: repositoryRoot, format: "json" });
    expect(json.exitCode).toBe(0);
    expect(json.output).not.toContain("\u001b[");
    const parsed = JSON.parse(json.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({ gate: { passed: true, outcome: "PASS" }, dataset: { id: "aao.runtime-foundation", version: "2.0.0" }, baseline: { id: "runtime-foundation", version: "1.0.0" }, cases: { total: 35, matched: 35 }, regressions: 0, criticalFailures: [], warnings: [], hardFailures: [] });
    expect(await runCli(["eval", "ci", "--format", "yaml"], { cwd: repositoryRoot })).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("AAO_CLI_INVALID_OPTION") });
    expect(await runCli(["eval", "ci", "--unknown"], { cwd: repositoryRoot })).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringContaining("AAO_CLI_UNKNOWN_OPTION") });
  });

  it("is deterministic: identical bytes and deep-equal decisions across runs; release metadata never changes the verdict", async () => {
    const [a, b] = [await runEvalCi({ root: repositoryRoot, format: "json" }), await runEvalCi({ root: repositoryRoot, format: "json" })];
    expect(a.output).toBe(b.output);
    const [x, y] = [await runGatePipeline(inputs()), await runGatePipeline(inputs())];
    expect(x).toEqual(y);
    const stamped = await runGatePipeline({ ...inputs(), metadata: { gitSha: "0123abcd", generatedAt: "2026-10-13T12:00:00.000Z" } });
    if (!x.ok || !stamped.ok) throw new Error("pipeline");
    expect(stamped.suite.semanticFingerprint).toBe(x.suite.semanticFingerprint);
    expect({ ...stamped.decision, metadata: undefined }).toEqual({ ...x.decision, metadata: undefined });
  });

  it("needs no network or credentials: the guard records zero connection attempts, and the gate excludes the model judge", async () => {
    const guard = installNetworkGuard();
    try {
      expect((await runEvalCi({ root: repositoryRoot })).exitCode).toBe(0);
      expect(guard.attempts()).toEqual([]);
      await expect(Promise.resolve().then(() => fetch("https://example.invalid"))).rejects.toThrow("AAO_EVAL_NETWORK_FORBIDDEN");
      expect(guard.attempts()).toEqual(["fetch"]);
    } finally {
      guard.uninstall();
    }
    expect(inputs().definitions.some((entry) => entry.graderRef.id === "aao.model-judge")).toBe(false);
    expect(deterministicGraders().some((grader) => grader.id === "aao.model-judge")).toBe(false);
  });
});
