import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVAL_ERROR_CODES,
  EVAL_LIMITS,
  EvalAssertionSchema,
  EvalCaseSchema,
  EvalDatasetRunSchema,
  EvalDatasetSchema,
  EvalDefinitionSchema,
  EvalEvidenceRefSchema,
  EvalGraderRefSchema,
  EvalModeSchema,
  EvalRefSchema,
  EvalResultSchema,
  EvalTargetTypeSchema,
  findForbiddenEvalCodeKeys,
} from "../src/evaluation.js";

const definition = {
  schemaVersion: 2,
  id: "tool.lookup-required",
  version: "1.0.0",
  name: "Lookup Tool is invoked",
  categories: ["tool_use"],
  supportedModes: ["OFFLINE", "RUNTIME"],
  targetType: "tool_use",
  graderRef: { id: "aao.tool-usage", version: "1.0.0" },
  config: { requiredTools: [{ id: "local.lookup", version: "1.0.0" }] },
};

const result = {
  schemaVersion: 2,
  resultId: `evr.${"a".repeat(64)}`,
  evalRef: { id: "tool.lookup-required", version: "1.0.0" },
  graderRef: { id: "aao.tool-usage", version: "1.0.0" },
  datasetRef: { id: "aao.runtime-foundation", version: "1.0.0" },
  caseId: "tool.required-lookup-invoked.001",
  mode: "OFFLINE",
  targetType: "tool_use",
  runId: "run.eval.flagship",
  traceId: "b".repeat(32),
  evidenceFingerprint: "c".repeat(64),
  status: "passed",
  assertions: [{ id: "tool.required:local.lookup:1.0.0", status: "passed", evidenceRefs: ["trace://run.eval.flagship/event/12"] }],
  evidenceRefs: ["fixture://flagship-approved", "trace://run.eval.flagship/event/12"],
};

const evalCase = { id: "tool.required-lookup-invoked.001", evalRef: { id: "tool.lookup-required", version: "1.0.0" }, mode: "OFFLINE", evidenceRef: "fixture://flagship-approved", expected: { status: "passed" }, tags: ["tool"] };
const dataset = { schemaVersion: 1, id: "aao.runtime-foundation", version: "1.0.0", name: "Foundation", cases: [evalCase] };

const roundTrip = <T>(schema: { parse(value: unknown): T }, value: unknown) => {
  const parsed = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
};

describe("Eval modes and targets", () => {
  it("keeps the canonical OFFLINE / RUNTIME modes", () => {
    expect(EvalModeSchema.options).toEqual(["OFFLINE", "RUNTIME"]);
    expect(EvalModeSchema.safeParse("BATCH").success).toBe(false);
  });

  it("targets name what is evaluated (one per subject, not one per grader); approval and state were added for their graders", () => {
    expect(EvalTargetTypeSchema.options).toEqual(["run", "node", "tool_use", "artifact", "trajectory", "authorization", "approval", "state"]);
    expect(EvalTargetTypeSchema.safeParse("gpa").success).toBe(false);
  });
});

describe("EvalDefinition schema version 2 (migrated, not duplicated)", () => {
  it("accepts an executable, versioned definition and round-trips through JSON", () => {
    roundTrip(EvalDefinitionSchema, definition);
  });

  it("rejects the Sprint 2 placeholder shape (schema version 1, single mode, no grader)", () => {
    expect(EvalDefinitionSchema.safeParse({ schemaVersion: 1, id: "eval.x", version: "1.0.0", name: "X", mode: "OFFLINE", targetType: "run" }).success).toBe(false);
  });

  it("requires unique modes, a target, an exact grader version, and strict fields", () => {
    expect(EvalDefinitionSchema.safeParse({ ...definition, supportedModes: ["OFFLINE", "OFFLINE"] }).success).toBe(false);
    expect(EvalDefinitionSchema.safeParse({ ...definition, supportedModes: [] }).success).toBe(false);
    const { targetType: _targetType, ...noTarget } = definition;
    expect(EvalDefinitionSchema.safeParse(noTarget).success).toBe(false);
    expect(EvalDefinitionSchema.safeParse({ ...definition, graderRef: { id: "aao.tool-usage", version: "1" } }).success).toBe(false);
    expect(EvalDefinitionSchema.safeParse({ ...definition, graderRef: { id: "aao.tool-usage", version: "^1.0.0" } }).success).toBe(false);
    expect(EvalDefinitionSchema.safeParse({ ...definition, owner: "x" }).success).toBe(false);
    expect(EvalDefinitionSchema.safeParse({ ...definition, graderRef: { ...definition.graderRef, modulePath: "./grader.js" } }).success).toBe(false);
    expect(EvalDefinitionSchema.safeParse({ ...definition, supportedModes: ["OFFLINE"] }).success).toBe(true);
  });

  it("cannot carry code: module paths, JavaScript, function bodies, or shell commands are rejected at any depth", () => {
    for (const key of ["modulePath", "javascript", "functionBody", "shellCommand", "script", "require", "import", "exec"]) {
      expect(EvalDefinitionSchema.safeParse({ ...definition, config: { nested: [{ [key]: "x" }] } }).success, key).toBe(false);
    }
    expect(findForbiddenEvalCodeKeys({ a: { ShellCommand: "rm -rf /" } })).toEqual(["$.a.ShellCommand"]);
  });

  it("bounds the config size and requires JSON-safe config", () => {
    expect(EvalDefinitionSchema.safeParse({ ...definition, config: { blob: "x".repeat(EVAL_LIMITS.maxConfigBytes) } }).success).toBe(false);
    expect(EvalDefinitionSchema.safeParse({ ...definition, config: { fn: () => 1 } }).success).toBe(false);
  });
});

describe("EvalResult schema version 2", () => {
  it("round-trips and keeps passed/failed/error with an optional normalized score", () => {
    roundTrip(EvalResultSchema, result);
    roundTrip(EvalResultSchema, { ...result, score: 0.86 });
    expect(EvalResultSchema.safeParse({ ...result, score: 1.5 }).success).toBe(false);
    expect(EvalResultSchema.safeParse({ ...result, score: -0.1 }).success).toBe(false);
  });

  it("errorCode is present exactly for error results, from the focused taxonomy", () => {
    expect(EvalResultSchema.safeParse({ ...result, status: "error", errorCode: "EVAL_EVIDENCE_MISSING", assertions: [] }).success).toBe(true);
    expect(EvalResultSchema.safeParse({ ...result, status: "error", assertions: [] }).success).toBe(false);
    expect(EvalResultSchema.safeParse({ ...result, errorCode: "EVAL_GRADER_ERROR" }).success).toBe(false);
    expect(EvalResultSchema.safeParse({ ...result, status: "error", errorCode: "NODE_EXECUTION_FAILED", assertions: [] }).success).toBe(false);
    expect(EVAL_ERROR_CODES).toContain("EVAL_REQUIRED_EVIDENCE_INCOMPLETE");
  });

  it("a passed result has passing assertions; a failed result names a failed assertion", () => {
    expect(EvalResultSchema.safeParse({ ...result, assertions: [] }).success).toBe(false);
    expect(EvalResultSchema.safeParse({ ...result, assertions: [{ ...result.assertions[0], status: "failed" }] }).success).toBe(false);
    expect(EvalResultSchema.safeParse({ ...result, status: "failed" }).success).toBe(false);
    expect(EvalResultSchema.safeParse({ ...result, status: "failed", assertions: [{ ...result.assertions[0], status: "failed", reasonCode: "TOOL_NOT_INVOKED" }] }).success).toBe(true);
  });

  it("has no field for raw evidence, prompts, outputs, reasons, or timestamps", () => {
    for (const field of ["reason", "prompt", "output", "toolInput", "toolOutput", "stateValues", "reasoning", "evaluatedAt", "trace"]) expect(EvalResultSchema.safeParse({ ...result, [field]: "x" }).success, field).toBe(false);
    expect(EvalAssertionSchema.safeParse({ ...result.assertions[0], actual: "value" }).success).toBe(false);
    expect(EvalAssertionSchema.safeParse({ ...result.assertions[0], status: "failed", reasonCode: "free text reason" }).success).toBe(false);
  });

  it("bounds assertions and evidence references", () => {
    const refs = Array.from({ length: EVAL_LIMITS.maxEvidenceRefsPerResult + 1 }, (_, index) => `trace://run.x/event/${index}`);
    expect(EvalResultSchema.safeParse({ ...result, evidenceRefs: refs }).success).toBe(false);
    expect(EvalAssertionSchema.safeParse({ ...result.assertions[0], evidenceRefs: refs.slice(0, EVAL_LIMITS.maxEvidenceRefsPerAssertion + 1) }).success).toBe(false);
    expect(EvalEvidenceRefSchema.safeParse(`trace://${"x".repeat(EVAL_LIMITS.maxEvidenceRefLength)}`).success).toBe(false);
    expect(EvalEvidenceRefSchema.safeParse("trace://run with space").success).toBe(false);
    expect(EvalEvidenceRefSchema.safeParse("/etc/passwd").success).toBe(false);
    expect(EvalEvidenceRefSchema.safeParse("execution://run_1/state-revision/2").success).toBe(true);
  });

  it("dataset identity and case identity come together", () => {
    const { datasetRef: _datasetRef, ...noDataset } = result;
    expect(EvalResultSchema.safeParse(noDataset).success).toBe(false);
    const { caseId: _caseId, ...standalone } = noDataset;
    expect(EvalResultSchema.safeParse(standalone).success).toBe(true);
  });
});

describe("EvalDataset (schema version 1) and EvalCase", () => {
  it("round-trips dataset, case, refs, and grader refs", () => {
    roundTrip(EvalDatasetSchema, dataset);
    roundTrip(EvalCaseSchema, evalCase);
    roundTrip(EvalRefSchema, evalCase.evalRef);
    roundTrip(EvalGraderRefSchema, definition.graderRef);
  });

  it("rejects duplicate case ids and duplicate case content", () => {
    expect(EvalDatasetSchema.safeParse({ ...dataset, cases: [evalCase, { ...evalCase, evidenceRef: "fixture://other" }] }).success).toBe(false);
    expect(EvalDatasetSchema.safeParse({ ...dataset, cases: [evalCase, { ...evalCase, id: "tool.copy.001" }] }).success).toBe(false);
  });

  it("is bounded and strict; an expected errorCode requires expected error", () => {
    const many = Array.from({ length: EVAL_LIMITS.maxCasesPerDataset + 1 }, (_, index) => ({ ...evalCase, id: `case.${index}`, evidenceRef: `fixture://f${index}` }));
    expect(EvalDatasetSchema.safeParse({ ...dataset, cases: many }).success).toBe(false);
    expect(EvalDatasetSchema.safeParse({ ...dataset, cases: [] }).success).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...evalCase, javascript: "x" }).success).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...evalCase, expected: { status: "failed", errorCode: "EVAL_EVIDENCE_MISSING" } }).success).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...evalCase, mode: "LIVE" }).success).toBe(false);
    expect(EvalCaseSchema.safeParse({ ...evalCase, evidenceRef: "../fixtures/x.json" }).success).toBe(false);
  });

  it("an EvalDatasetRun carries each result's dataset and case identity", () => {
    roundTrip(EvalDatasetRunSchema, { schemaVersion: 1, datasetRef: result.datasetRef, cases: [{ caseId: result.caseId, matchesExpectation: true, result }] });
    expect(EvalDatasetRunSchema.safeParse({ schemaVersion: 1, datasetRef: result.datasetRef, cases: [{ caseId: "other.001", matchesExpectation: null, result }] }).success).toBe(false);
  });
});

describe("one canonical Eval contract family", () => {
  it("no second EvaluationDefinition / EvaluationResult contract exists anywhere in production source", () => {
    const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? (entry.name === "node_modules" || entry.name === "dist" ? [] : walk(join(dir, entry.name))) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
    const offenders = readdirSync(packagesDir).flatMap((pkg) => { try { return walk(join(packagesDir, pkg, "src")); } catch { return []; } }).filter((file) => /\b(?:EvaluationDefinition|EvaluationResult|EvalDefinitionV2|EvalResultV2)\b/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
    const declarations = readdirSync(packagesDir).flatMap((pkg) => { try { return walk(join(packagesDir, pkg, "src")); } catch { return []; } }).filter((file) => /export const EvalDefinitionSchema\b|export const EvalResultSchema\b/.test(readFileSync(file, "utf8")));
    expect(declarations.map((file) => file.split("/packages/")[1])).toEqual(["contracts/src/evaluation.ts"]);
  });
});
