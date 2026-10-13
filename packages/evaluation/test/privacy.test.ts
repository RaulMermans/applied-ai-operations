import { describe, expect, it } from "vitest";
import type { EvalResult } from "@aao/contracts";
import { createEvaluatorRegistry, createModelJudgeGrader, deterministicGraders, evaluate, runEvalDataset } from "../src/index.js";
import { realAuthorizationDenied, realFlagship } from "./support/fixture-builders.js";
import { fixtureResolver, loadDataset, loadDefinitions, loadFixture, registry } from "./support/evals.js";
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
describe("privacy: serialized EvalResults contain no evidence content", () => {
  const definitions = loadDefinitions();
  const evaluator = registry();

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
