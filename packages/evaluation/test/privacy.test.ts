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

describe("privacy: serialized EvalResults contain no evidence content", () => {
  it("every definition × every fixture, live Runs, the full dataset, and a model judge", async () => {
    const results: EvalResult[] = [];
    const fixtureNames = ["flagship-approved", "approval-rejected", "approval-pending", "authorization-denied", "durable-replay", "execution-only", "negative-state-unexpected-write", "metrics-budget", "negative-tool-after-rejection"];
    for (const candidate of loadDefinitions()) for (const name of fixtureNames) results.push(await evaluate({ definition: candidate, mode: "OFFLINE", evidence: loadFixture(name), registry: registry() }));
    for (const run of [await realFlagship("approve", "live_run", "run.privacy.a"), await realFlagship("reject", "live_run", "run.privacy.r"), await realAuthorizationDenied("live_run")]) {
      for (const candidate of loadDefinitions()) results.push(await evaluate({ definition: candidate, mode: "RUNTIME", evidence: run.bundle, registry: registry() }));
      results.push(await evaluate({ definition: def("aao.state-assertion", "state", { checks: [{ id: "leak-probe", op: "path_equals", path: "/internal/credential", value: "guess" }] }), mode: "RUNTIME", evidence: run.bundle, registry: registry() }));
    }
    const dataset = await runEvalDataset({ dataset: loadDataset(), definitions: loadDefinitions(), registry: registry(), evidenceResolver: fixtureResolver() });
    if (dataset.ok) results.push(...dataset.run.cases.map((entry) => entry.result));

    const judgeRegistry = createEvaluatorRegistry([...deterministicGraders(), createModelJudgeGrader({ judge: { judge: async () => ({ passed: true, score: 0.9, defects: [{ code: "SECRET_DO_NOT_PERSIST" }] }) } })]);
    results.push(await evaluate({ definition: def("aao.model-judge", "artifact", { rubric: { criteria: "Is the prompt answered without exposing the password?" }, passThreshold: 0.5 }), mode: "OFFLINE", evidence: { origin: "recorded", runId: "run.privacy.judge", subject: { id: "subject.1", content: "model output text with password hunter2 and SECRET_DO_NOT_PERSIST", context: { prompt: "Let me think step by step about the api_key" } } }, registry: judgeRegistry }));

    expect(results.length).toBeGreaterThan(150);
    const serialized = JSON.stringify(results);
    for (const forbidden of FORBIDDEN_IN_RESULTS) expect(serialized.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    // Results contain only identifiers, codes, statuses, scores, fingerprints, and opaque references.
    for (const result of results) for (const ref of result.evidenceRefs) expect(ref).toMatch(/^(trace|audit|execution|metrics|subject|fixture):\/\//);
  });
});
