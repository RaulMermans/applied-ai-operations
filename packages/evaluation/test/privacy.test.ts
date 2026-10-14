import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EvalResult } from "@aao/contracts";
import { buildEvalSuiteReport, createEvaluatorRegistry, createModelJudgeGrader, createStaticEvidenceResolver, deterministicGraders, evaluate, proposeEvalBaseline, runEvalDataset } from "../src/index.js";
import { loadFoundationInputs, runGatePipeline } from "../../framework/src/cli/eval/host.js";
import { realAuthorizationDenied, realFlagship } from "./support/fixture-builders.js";
import { evalsRoot, fixtureResolver, loadDataset, loadDefinitions, loadFixture, registry, repositoryRoot } from "./support/evals.js";
import { def } from "./support/inline.js";
import { APPROVAL_SUBJECT_SECRET, STATE_SECRET, TOOL_OUTPUT_SECRET } from "./support/world.js";

/**
 * EvalResults reference evidence; they never copy it. Every definition is
 * evaluated against every fixture and against live Runs whose state, Tool
 * output, and Approval subject carry sensitive fixture strings, plus a
 * model judge whose subject, context, and output carry more. Nothing
 * sensitive may appear in any serialized EvalResult.
 */
const FORBIDDEN_IN_RESULTS = [
  STATE_SECRET,
  TOOL_OUTPUT_SECRET,
  APPROVAL_SUBJECT_SECRET,
  "SECRET_DO_NOT_PERSIST",
  "hunter2",
  "password",
  "api_key",
  "apiKeyEcho",
  "credential",
  "account-a",
  "prompt",
  "reasoning",
  "chain-of-thought",
  "Let me think",
  "model output text",
];

/** Results contain only identifiers, codes, statuses, scores, fingerprints, and opaque references. */
function expectNoEvidenceContent(results: readonly EvalResult[]) {
  const serialized = JSON.stringify(results).toLowerCase();
  for (const forbidden of FORBIDDEN_IN_RESULTS) expect(serialized, forbidden).not.toContain(forbidden.toLowerCase());
  for (const result of results) for (const ref of result.evidenceRefs) expect(ref).toMatch(/^(trace|audit|execution|metrics|subject|fixture):\/\//);
}

// Each source is its own bounded test: under full-suite CPU contention a single
// test evaluating every source at once (≈250 evaluations) crossed the default
// timeout while taking ≈0.6 s in isolation. Inputs are loaded once.
const definitions = loadDefinitions();
const evaluator = registry();

describe("privacy: serialized EvalResults contain no evidence content", () => {

  it("every definition × every fixture", async () => {
    const fixtureNames = ["flagship-approved", "approval-rejected", "approval-pending", "authorization-denied", "durable-replay", "execution-only", "negative-state-unexpected-write", "metrics-budget", "negative-tool-after-rejection"];
    const results: EvalResult[] = [];
    for (const name of fixtureNames) {
      const evidence = loadFixture(name);
      for (const candidate of definitions) results.push(await evaluate({ definition: candidate, mode: "OFFLINE", evidence, registry: evaluator }));
    }
    expect(results.length).toBeGreaterThan(150);
    expectNoEvidenceContent(results);
  });

  it("live Runs whose state, Tool output, and Approval subject carry sensitive strings", async () => {
    const results: EvalResult[] = [];
    for (const run of [await realFlagship("approve", "live_run", "run.privacy.a"), await realFlagship("reject", "live_run", "run.privacy.r"), await realAuthorizationDenied("live_run")]) {
      for (const candidate of definitions) results.push(await evaluate({ definition: candidate, mode: "RUNTIME", evidence: run.bundle, registry: evaluator }));
      results.push(await evaluate({ definition: def("aao.state-assertion", "state", { checks: [{ id: "leak-probe", op: "path_equals", path: "/internal/credential", value: "guess" }] }), mode: "RUNTIME", evidence: run.bundle, registry: evaluator }));
    }
    expectNoEvidenceContent(results);
  });

  it("the full dataset", async () => {
    const dataset = await runEvalDataset({ dataset: loadDataset(), definitions, registry: evaluator, evidenceResolver: fixtureResolver() });
    if (!dataset.ok) throw new Error(JSON.stringify(dataset.issues));
    expectNoEvidenceContent(dataset.run.cases.map((entry) => entry.result));
  });

  it("a model judge whose subject, context, and output carry sensitive strings", async () => {
    const judgeRegistry = createEvaluatorRegistry([...deterministicGraders(), createModelJudgeGrader({ judge: { judge: async () => ({ passed: true, score: 0.9, defects: [{ code: "SECRET_DO_NOT_PERSIST" }] }) } })]);
    const result = await evaluate({ definition: def("aao.model-judge", "artifact", { rubric: { criteria: "Is the prompt answered without exposing the password?" }, passThreshold: 0.5 }), mode: "OFFLINE", evidence: { origin: "recorded", runId: "run.privacy.judge", subject: { id: "subject.1", content: "model output text with password hunter2 and SECRET_DO_NOT_PERSIST", context: { prompt: "Let me think step by step about the api_key" } } }, registry: judgeRegistry });
    expect(result.status).toBe("passed");
    expectNoEvidenceContent([result]);
  });
});

describe("privacy: Sprint 18 reports, baselines, and gate decisions add no evidence content", () => {
  it("SuiteReport, ComparisonReport, GateDecision, the committed Baseline, and a live-Run suite contain only identifiers, codes, counts, scores, and fingerprints", async () => {
    const inputs = loadFoundationInputs(repositoryRoot);
    const outcome = await runGatePipeline(inputs);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    // Live Runs whose state, Tool output, and Approval subject carry seeded secrets.
    const live = await Promise.all([realFlagship("approve", "live_run", "run.privacy.s18a"), realFlagship("reject", "live_run", "run.privacy.s18r"), realAuthorizationDenied("live_run")]);
    const cases = live.flatMap((run, index) => definitions.filter((entry) => entry.supportedModes.includes("RUNTIME")).slice(0, 8).map((entry) => ({ id: `privacy.${index}.${entry.id}`, evalRef: { id: entry.id, version: entry.version }, mode: "RUNTIME" as const, evidenceRef: `live://privacy-${index}`, expected: { status: "passed" as const } })));
    const dataset = { schemaVersion: 2 as const, id: "test.privacy-live", version: "1.0.0", name: "Privacy live", cases };
    const run = await runEvalDataset({ dataset, definitions, registry: evaluator, evidenceResolver: createStaticEvidenceResolver(live.map((entry, index) => [`live://privacy-${index}`, entry.bundle] as const)) });
    if (!run.ok) throw new Error(JSON.stringify(run.issues));
    const liveSuite = buildEvalSuiteReport({ dataset, definitions, run: run.run });
    const baselineFile = readFileSync(join(evalsRoot, "baselines", "runtime-foundation.v1.json"), "utf8");
    const artifacts = [outcome.suite, outcome.comparison, outcome.decision, liveSuite, proposeEvalBaseline({ suite: liveSuite, id: "privacy-baseline", version: "1.0.0" })];
    const serialized = `${JSON.stringify(artifacts)}\n${baselineFile}`.toLowerCase();
    for (const forbidden of [...FORBIDDEN_IN_RESULTS, "FIXTURE_TOOL_OUTPUT", "FIXTURE_APPROVAL_SUBJECT", "\"target\"", "\"note\"", "\"output\"", "\"input\"", "\"values\"", "lookupresult"]) expect(serialized, forbidden).not.toContain(forbidden.toLowerCase());
    // No evidence references or Run identity either: reports compare logical identities only.
    expect(serialized).not.toMatch(/trace:\/\/|audit:\/\/|execution:\/\/|run\.privacy|run\.eval\.|evr\./);
  });
});
