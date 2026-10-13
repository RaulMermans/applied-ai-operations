import { describe, expect, it } from "vitest";
import { EvalDatasetRunSchema } from "@aao/contracts";
import { runEvalDataset } from "../src/index.js";
import { fixtureResolver, loadDataset, loadDefinitions, registry } from "./support/evals.js";

describe("offline dataset E2E: runtime-foundation", () => {
  it("every case produces exactly one EvalResult matching its stated expectation, in dataset order", async () => {
    const dataset = loadDataset();
    const outcome = await runEvalDataset({ dataset, definitions: loadDefinitions(), registry: registry(), evidenceResolver: fixtureResolver() });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.issues));
    const run = outcome.run;
    expect(EvalDatasetRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
    expect(run.cases.map((entry) => entry.caseId)).toEqual(dataset.cases.map((evalCase) => evalCase.id));
    const mismatches = run.cases.filter((entry) => entry.matchesExpectation !== true).map((entry) => ({ caseId: entry.caseId, status: entry.result.status, errorCode: entry.result.errorCode, assertions: entry.result.assertions }));
    expect(mismatches).toEqual([]);
    // Errors occur only in cases explicitly designed as evaluator-error fixtures.
    const errorCases = run.cases.filter((entry) => entry.result.status === "error").map((entry) => entry.caseId);
    expect(errorCases.sort()).toEqual(dataset.cases.filter((evalCase) => evalCase.expected?.status === "error").map((evalCase) => evalCase.id).sort());
    for (const entry of run.cases) expect(entry.result).toMatchObject({ datasetRef: { id: "aao.runtime-foundation", version: "1.1.0" }, caseId: entry.caseId, mode: "OFFLINE" });
  });
});
