import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_LIMITS } from "@aao/contracts";
import { MAX_EVAL_SOURCE_BYTES, createEvaluatorRegistry, createStaticEvidenceResolver, deterministicGraders, parseEvalDataset, parseEvalDefinitions, runEvalDataset, validateEvalDataset, zodConfig, type EvalGrader } from "../src/index.js";
import { z } from "zod";
import { evalsRoot, fixtureResolver, loadDataset, loadDefinitions, loadFixture, registry } from "./support/evals.js";

const datasetYaml = () => readFileSync(join(evalsRoot, "datasets", "runtime-foundation.v1.yaml"), "utf8");
const smallDataset = (cases: object[]) => ({ schemaVersion: 1, id: "test.dataset", version: "1.0.0", name: "Test", cases });
const okCase = (id: string, evidenceRef = "fixture://flagship-approved") => ({ id, evalRef: { id: "tool.lookup-required", version: "1.0.0" }, mode: "OFFLINE", evidenceRef, expected: { status: "passed" } });

describe("dataset loading", () => {
  it("loads the committed YAML dataset and definitions; JSON is equivalent", () => {
    const yaml = parseEvalDataset(datasetYaml(), "yaml");
    expect(yaml.ok && yaml.value.cases.length).toBe(35);
    const json = parseEvalDataset(JSON.stringify(loadDataset()), "json");
    expect(json).toEqual(yaml);
    expect(loadDefinitions().length).toBeGreaterThanOrEqual(15);
  });

  it("rejects invalid sources, code-bearing fields, YAML custom tags, and oversized files before evaluation", () => {
    expect(parseEvalDataset("cases: [", "yaml")).toMatchObject({ ok: false, code: "EVAL_DATASET_INVALID" });
    expect(parseEvalDataset("{", "json")).toMatchObject({ ok: false, code: "EVAL_DATASET_INVALID" });
    const withCode = datasetYaml().replace("tags: [trace]", "tags: [trace]\n    modulePath: ./evil.js");
    expect(parseEvalDataset(withCode, "yaml")).toMatchObject({ ok: false, issues: [{ path: "$.cases[0].modulePath" }] });
    expect(parseEvalDataset("schemaVersion: 1\nid: !!js/function 'function () {}'\n", "yaml").ok).toBe(false);
    expect(parseEvalDataset(" ".repeat(MAX_EVAL_SOURCE_BYTES + 1), "yaml")).toMatchObject({ ok: false, issues: [{ path: "$" }] });
    expect(parseEvalDefinitions("definitions:\n  - schemaVersion: 2\n    id: x\n    javascript: 'alert(1)'\n", "yaml").ok).toBe(false);
  });

  it("rejects duplicate cases, duplicate definitions, and unbounded datasets", () => {
    expect(parseEvalDataset(JSON.stringify(smallDataset([okCase("a.001"), okCase("a.001", "fixture://other")])), "json").ok).toBe(false);
    expect(parseEvalDataset(JSON.stringify(smallDataset(Array.from({ length: EVAL_LIMITS.maxCasesPerDataset + 1 }, (_, index) => okCase(`case.${index}`, `fixture://f${index}`)))), "json").ok).toBe(false);
    const [first] = loadDefinitions();
    expect(parseEvalDefinitions(JSON.stringify({ definitions: [first, first] }), "json").ok).toBe(false);
  });
});

describe("dataset validation against definitions", () => {
  it("unknown Eval ref, wrong definition version, unsupported mode, invalid evidence ref → invalid before any evaluation", () => {
    const definitions = loadDefinitions();
    expect(validateEvalDataset({ dataset: smallDataset([{ ...okCase("a.001"), evalRef: { id: "tool.unknown", version: "1.0.0" } }]), definitions })).toMatchObject({ ok: false, issues: [{ path: "$.cases.0.evalRef" }] });
    expect(validateEvalDataset({ dataset: smallDataset([{ ...okCase("a.001"), evalRef: { id: "tool.lookup-required", version: "2.0.0" } }]), definitions })).toMatchObject({ ok: false });
    const offlineOnly = definitions.map((definition) => (definition.id === "tool.lookup-required" ? { ...definition, supportedModes: ["OFFLINE" as const] } : definition));
    expect(validateEvalDataset({ dataset: smallDataset([{ ...okCase("a.001"), mode: "RUNTIME" }]), definitions: offlineOnly })).toMatchObject({ ok: false, issues: [{ path: "$.cases.0.mode" }] });
    expect(validateEvalDataset({ dataset: smallDataset([okCase("a.001", "file:///etc/passwd x")]), definitions })).toMatchObject({ ok: false });
  });

  it("runEvalDataset refuses an invalid dataset without running any grader", async () => {
    let calls = 0;
    const counting: EvalGrader = { id: "aao.tool-usage", version: "1.0.0", supportedModes: ["OFFLINE"], supportedTargetTypes: ["tool_use"], validateConfig: zodConfig(z.object({}).passthrough()), evaluate: () => { calls += 1; return { kind: "judged", assertions: [{ id: "x", status: "passed", evidenceRefs: [] }] }; } };
    const outcome = await runEvalDataset({ dataset: smallDataset([okCase("a.001"), { ...okCase("a.002"), evalRef: { id: "nope", version: "1.0.0" } }]), definitions: loadDefinitions(), registry: createEvaluatorRegistry([counting]), evidenceResolver: fixtureResolver() });
    expect(outcome.ok).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("dataset execution", () => {
  it("is sequential, in dataset case order, and repeatable (deep-equal runs)", async () => {
    const params = { dataset: loadDataset(), definitions: loadDefinitions(), registry: registry(), evidenceResolver: fixtureResolver() };
    const first = await runEvalDataset(params);
    const second = await runEvalDataset(params);
    expect(first).toEqual(second);
    const reversed = { ...params.dataset, cases: [...params.dataset.cases].reverse() };
    const third = await runEvalDataset({ ...params, dataset: reversed });
    expect(third.ok && third.run.cases.map((entry) => entry.caseId)).toEqual(reversed.cases.map((evalCase) => evalCase.id));
  });

  it("isolates cases: missing evidence, a throwing resolver, and a throwing grader each yield one error result; other cases still run", async () => {
    const throwing: EvalGrader = { id: "test.explode", version: "1.0.0", supportedModes: ["OFFLINE"], supportedTargetTypes: ["run"], validateConfig: zodConfig(z.object({}).strict()), evaluate: () => { throw new Error("boom"); } };
    const definitions = [...loadDefinitions(), { schemaVersion: 2 as const, id: "test.explode", version: "1.0.0", name: "Explodes", supportedModes: ["OFFLINE" as const], targetType: "run" as const, graderRef: { id: "test.explode", version: "1.0.0" }, config: {} }];
    const dataset = smallDataset([
      okCase("isolation.missing.001", "fixture://does-not-exist"),
      okCase("isolation.resolver-throws.001", "fixture://throws"),
      { ...okCase("isolation.grader-throws.001"), evalRef: { id: "test.explode", version: "1.0.0" } },
      okCase("isolation.healthy.001"),
    ]);
    const base = fixtureResolver();
    const resolver = { resolve: (ref: string) => { if (ref === "fixture://throws") throw new Error("disk on fire"); return base.resolve(ref); } };
    const outcome = await runEvalDataset({ dataset, definitions, registry: createEvaluatorRegistry([...deterministicGraders(), throwing]), evidenceResolver: resolver });
    if (!outcome.ok) throw new Error("dataset invalid");
    expect(outcome.run.cases.map((entry) => [entry.caseId, entry.result.status, entry.result.errorCode ?? null])).toEqual([
      ["isolation.missing.001", "error", "EVAL_EVIDENCE_MISSING"],
      ["isolation.resolver-throws.001", "error", "EVAL_CASE_ERROR"],
      ["isolation.grader-throws.001", "error", "EVAL_GRADER_ERROR"],
      ["isolation.healthy.001", "passed", null],
    ]);
    expect(outcome.run.cases[0]!.result.evidenceRefs).toEqual(["fixture://does-not-exist"]);
    expect(JSON.stringify(outcome.run)).not.toMatch(/boom|disk on fire/);
  });

  it("results carry dataset and case identity for reproducible comparison later", async () => {
    const outcome = await runEvalDataset({ dataset: smallDataset([okCase("identity.001")]), definitions: loadDefinitions(), registry: registry(), evidenceResolver: createStaticEvidenceResolver([["fixture://flagship-approved", loadFixture("flagship-approved")]]) });
    expect(outcome.ok && outcome.run.cases[0]!.result).toMatchObject({ datasetRef: { id: "test.dataset", version: "1.0.0" }, caseId: "identity.001", evalRef: { id: "tool.lookup-required", version: "1.0.0" }, graderRef: { id: "aao.tool-usage", version: "1.0.0" } });
  });

  it("the static resolver accepts only opaque evidence references and never touches the filesystem", () => {
    expect(() => createStaticEvidenceResolver([["../../etc/passwd", { origin: "recorded" }]])).toThrow();
    expect(createStaticEvidenceResolver([]).resolve("fixture://flagship-approved")).toBeUndefined();
  });
});
