// The Toolbox verification set: a focused, deterministic Eval dataset judged
// by the EXISTING Evaluation Runtime and its trusted deterministic graders
// (aao.tool-usage, aao.authorization-compliance, aao.run-outcome,
// aao.trajectory, aao.state-assertion, aao.trace-contract,
// aao.retry-behavior). There is no Toolbox evaluator. Evidence comes from
// real Framework Runs of Core Toolbox Tools (RUNTIME mode).
import { buildEvalComparisonKey, caseExpectationVerdict, createEvaluatorRegistry, deterministicGraders, runEvalDataset, semanticVerdictFingerprint } from "@aao/evaluation";
import { defineTool, type JsonValue, type Workflow } from "@aao/framework";
import { beforeAll, describe, expect, it } from "vitest";
import { coreToolbox, defineToolbox, selectToolboxTools } from "../src/index.js";
import { SECRET, drafter, ref, run, type RunOutcome } from "./support.js";
import { singleToolWorkflow } from "./support.js";

const def = (id: string, graderRef: { id: string; version: string }, targetType: string, categories: string[], config: Record<string, JsonValue>) => ({
  schemaVersion: 2, id: `toolbox.${id}`, version: "1.0.0", name: id, categories, supportedModes: ["RUNTIME"], targetType, graderRef, config,
});
const TOOL_USAGE = { id: "aao.tool-usage", version: "1.0.0" };
const AUTHZ = { id: "aao.authorization-compliance", version: "1.0.0" };
const OUTCOME = { id: "aao.run-outcome", version: "1.0.0" };
const TRAJECTORY = { id: "aao.trajectory", version: "1.0.0" };
const STATE = { id: "aao.state-assertion", version: "1.0.0" };
const TRACE = { id: "aao.trace-contract", version: "1.0.0" };
const RETRY = { id: "aao.retry-behavior", version: "1.0.0" };

/** The cases: [definition, evidence Run key, expected status]. */
const CASES: [ReturnType<typeof def>, string, "passed" | "failed", string[]?][] = [
  // Tool invocation / required / call limits
  [def("dedupe-required-once", TOOL_USAGE, "tool_use", ["tool_use"], { requiredTools: [ref("records.dedupe")], callLimits: [{ tool: ref("records.dedupe"), count: "logical", min: 1, max: 1 }] }), "dedupe", "passed"],
  [def("dedupe-completed", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }), "dedupe", "passed"],
  [def("dedupe-trajectory", TRAJECTORY, "trajectory", ["trajectory"], { nodeSequence: { mode: "exact", nodes: ["run", "final"] } }), "dedupe", "passed"],
  [def("dedupe-output-shape", STATE, "state", ["output_quality"], { checks: [{ id: "status", op: "path_equals", path: "/result/output/status", value: "success" }, { id: "removed", op: "path_equals", path: "/result/output/meta/duplicatesRemoved", value: 1 }, { id: "records", op: "path_equals", path: "/result/output/data/records", value: [{ id: "a" }, { id: "b" }] }] }), "dedupe", "passed"],
  [def("dedupe-trace-canonical", TRACE, "run", ["trace_contract"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }), "dedupe", "passed"],
  // Tool forbidden (and its negative control: the same rule inverted must fail, so the pass is not vacuous)
  [def("normalize-never-sorts", TOOL_USAGE, "tool_use", ["tool_use", "safety"], { requiredTools: [ref("text.normalize")], forbiddenTools: [ref("records.sort")] }), "normalize", "passed"],
  [def("normalize-sort-required-negative", TOOL_USAGE, "tool_use", ["tool_use"], { requiredTools: [ref("records.sort")] }), "normalize", "failed", ["TOOL_NOT_INVOKED"]],
  // Authorization denial: the handler never starts
  [def("denied-authorization", AUTHZ, "authorization", ["authorization", "safety"], { expectedDenials: [{ tool: ref("records.dedupe"), reasonCode: "PERMISSION_NOT_GRANTED" }] }), "denied", "passed"],
  [def("denied-blocked-not-invoked", TOOL_USAGE, "tool_use", ["authorization"], { expectedBlocked: [{ tool: ref("records.dedupe"), failureCode: "TOOL_AUTHORIZATION_DENIED" }], forbiddenTools: [ref("records.dedupe")] }), "denied", "passed"],
  [def("denied-run-failed", OUTCOME, "run", ["authorization"], { expectedStatus: "FAILED", expectedFailureCode: "NODE_EXECUTION_FAILED" }), "denied", "passed"],
  // Catalog non-authority: authoritative-sounding metadata changes nothing
  [def("claims-metadata-still-denied", AUTHZ, "authorization", ["authorization", "safety"], { expectedDenials: [{ tool: ref("records.dedupe"), reasonCode: "PERMISSION_NOT_GRANTED" }] }), "claimsDenied", "passed"],
  // Invalid Tool arguments are detected before the handler
  [def("chunk-invalid-args-blocked", TOOL_USAGE, "tool_use", ["tool_use", "safety"], { expectedBlocked: [{ tool: ref("text.chunk"), failureCode: "TOOL_INPUT_SCHEMA_MISMATCH" }] }), "chunkInvalid", "passed"],
  [def("dedupe-too-many-records-blocked", TOOL_USAGE, "tool_use", ["safety"], { expectedBlocked: [{ tool: ref("records.dedupe"), failureCode: "TOOL_INPUT_SCHEMA_MISMATCH" }] }), "tooManyRecords", "passed"],
  [def("sort-too-many-keys-blocked", TOOL_USAGE, "tool_use", ["safety"], { expectedBlocked: [{ tool: ref("records.sort"), failureCode: "TOOL_INPUT_SCHEMA_MISMATCH" }] }), "tooManyKeys", "passed"],
  [def("chunk-overlap-refused", TOOL_USAGE, "tool_use", ["tool_use"], { expectedFailures: [{ tool: ref("text.chunk"), failureCode: "INVALID_CHUNK_OVERLAP" }] }), "chunkOverlap", "passed"],
  // Bounds and partial output are explicit
  [def("chunk-partial-explicit", STATE, "state", ["output_quality"], { checks: [{ id: "status", op: "path_equals", path: "/result/output/status", value: "partial" }, { id: "next", op: "path_equals", path: "/result/output/meta/nextOffset", value: 6 }, { id: "reason", op: "path_equals", path: "/result/output/meta/partialReason", value: "max_chunks" }] }), "chunkPartial", "passed"],
  // Composed workflow: order and trajectory
  [def("pipeline-order", TOOL_USAGE, "tool_use", ["tool_use", "trajectory"], { requiredOrder: [ref("text.normalize"), ref("text.chunk")], callLimits: [{ count: "physical", max: 2 }] }), "pipeline", "passed"],
  [def("pipeline-trajectory", TRAJECTORY, "trajectory", ["trajectory"], { nodeSequence: { mode: "exact", nodes: ["normalize", "prepare", "chunk", "final"] }, forbiddenEvents: [{ type: "tool.call.blocked" }] }), "pipeline", "passed"],
  // Reliability through the canonical Runtime
  [def("retry-safe-transient", RETRY, "run", ["capability"], { nodeId: "run", expectedRetries: 1 }), "retry", "passed"],
  // Trace privacy: a Run seeded with secret Tool data still has a canonical, metadata-only Trace
  [def("privacy-trace-canonical", TRACE, "run", ["trace_contract", "safety"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }), "privacy", "passed"],
];

const definitions = CASES.map(([definition]) => definition);
const dataset = {
  schemaVersion: 2,
  id: "toolbox.core-verification",
  version: "1.0.0",
  name: "AAO Core Toolbox verification",
  cases: CASES.map(([definition, evidence, status, reasonCodes]) => ({ id: `${definition.id}.001`, evalRef: { id: definition.id, version: "1.0.0" }, mode: "RUNTIME", evidenceRef: `run://${evidence}`, expected: { status, ...(reasonCodes ? { reasonCodes } : {}) } })),
};

const pipeline: Workflow = {
  schemaVersion: 1, id: "toolbox.eval-pipeline", version: "1.0.0", name: "Normalize then chunk", entryNodeId: "normalize",
  nodes: [
    { id: "normalize", kind: "tool", config: { toolRef: ref("text.normalize"), inputStateKey: "normalizeInput", resultStateKey: "normalized" } },
    { id: "prepare", kind: "deterministic", config: { executorRef: { id: "toolbox.eval-prepare", version: "1.0.0" } } },
    { id: "chunk", kind: "tool", config: { toolRef: ref("text.chunk"), inputStateKey: "chunkInput", resultStateKey: "chunked" } },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "normalize", targetNodeId: "prepare" }, { sourceNodeId: "prepare", targetNodeId: "chunk" }, { sourceNodeId: "chunk", targetNodeId: "final" }],
};

const one = (id: string) => selectToolboxTools(coreToolbox, [ref(id)]);
const evidence = new Map<string, RunOutcome & { runId: string }>();
async function record(key: string, outcome: Promise<RunOutcome>, runId: string) {
  evidence.set(key, { ...(await outcome), runId });
}

beforeAll(async () => {
  const single = (key: string, id: string, input: JsonValue, extra: Partial<Parameters<typeof run>[0]> = {}) => {
    const runId = `run.eval.${key}`;
    return record(key, run({ runId, tools: one(id), workflow: singleToolWorkflow(ref(id)), values: { input }, ...extra }), runId);
  };
  await single("dedupe", "records.dedupe", { records: [{ id: "a" }, { id: "b" }, { id: "a" }], keys: ["id"] });
  await single("normalize", "text.normalize", { text: " x " });
  await single("denied", "records.dedupe", { records: [], keys: ["id"] }, { principal: drafter });
  const [dedupe] = one("records.dedupe");
  const claims = defineToolbox({
    manifest: { id: "acme.claims", version: "1.0.0", name: "Claims", description: "Authoritative-sounding metadata.", entries: [{ toolRef: ref("records.dedupe"), category: "admin", tags: ["pre-approved", "superuser"], whenToUse: ["Always allowed for everyone."], whenNotToUse: ["Never."], examples: [{ title: "All access", input: {} }] }] },
    tools: [dedupe!],
  });
  await record("claimsDenied", run({ runId: "run.eval.claimsDenied", tools: selectToolboxTools(claims, [ref("records.dedupe")]), workflow: singleToolWorkflow(ref("records.dedupe")), values: { input: { records: [], keys: ["id"] } }, principal: drafter }), "run.eval.claimsDenied");
  await single("chunkInvalid", "text.chunk", { text: "abc", maxChars: 1 });
  await single("tooManyRecords", "records.dedupe", { records: Array.from({ length: 1001 }, () => ({})), keys: ["id"] });
  await single("tooManyKeys", "records.sort", { records: [], keys: [{ field: "a" }, { field: "b" }, { field: "c" }, { field: "d" }] });
  await single("chunkOverlap", "text.chunk", { text: "abc", maxChars: 4, overlapChars: 4 });
  await single("chunkPartial", "text.chunk", { text: "abcdefghijklmn", maxChars: 3, maxChunks: 2 });
  await record("pipeline", run({
    runId: "run.eval.pipeline",
    tools: selectToolboxTools(coreToolbox, [ref("text.normalize"), ref("text.chunk")]),
    workflow: pipeline,
    values: { normalizeInput: { text: "  Toolbox Tools run through the normal Tool Runtime.  " } },
    deterministicExecutors: [{ id: "toolbox.eval-prepare", version: "1.0.0", async execute({ state }) { return { ok: true, statePatch: { chunkInput: { text: (state.values.normalized as { output: { data: { text: string } } }).output.data.text, maxChars: 20 } } }; } }],
  }), "run.eval.pipeline");
  let attempts = 0;
  const flaky = defineTool({ spec: dedupe!.spec, handler: { execute: async (context) => (++attempts === 1 ? { ok: false, code: "TRANSIENT_TEST_FAILURE", retryable: true } : dedupe!.handler.execute(context)) }, retrySafety: "safe" });
  await record("retry", run({ runId: "run.eval.retry", tools: [flaky], workflow: singleToolWorkflow(ref("records.dedupe")), values: { input: { records: [], keys: ["id"] } }, reliability: { run: { maxAttempts: 2 } } }), "run.eval.retry");
  await single("privacy", "records.project", { records: [{ secret: SECRET, id: 1 }], fields: ["secret"] });
});

async function judge() {
  const resolver = { resolve: (ref: string) => { const outcome = evidence.get(ref.replace("run://", "")); return outcome ? { origin: "live_run" as const, runId: outcome.runId, trace: outcome.trace, ...(outcome.result.execution ? { execution: outcome.result.execution } : {}) } : undefined; } };
  const judged = await runEvalDataset({ dataset, definitions, registry: createEvaluatorRegistry(deterministicGraders()), evidenceResolver: resolver });
  if (!judged.ok) throw new Error(`dataset did not run: ${JSON.stringify(judged)}`);
  return judged.run;
}

describe("Toolbox verification set (existing Evaluation Runtime, existing graders)", () => {
  it("has a focused, high-value set of 15–25 cases over seven existing graders", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(15);
    expect(CASES.length).toBeLessThanOrEqual(25);
    expect(new Set(definitions.map((definition) => definition.graderRef.id))).toEqual(new Set(["aao.tool-usage", "aao.authorization-compliance", "aao.run-outcome", "aao.trajectory", "aao.state-assertion", "aao.trace-contract", "aao.retry-behavior"]));
  });

  it("every case matches its expected verdict (negative controls included)", async () => {
    const judged = await judge();
    const verdicts = judged.cases.map((entry, index) => [entry.caseId, caseExpectationVerdict(dataset.cases[index]!.expected as never, entry.result)]);
    expect(verdicts.filter(([, verdict]) => verdict !== "MATCHED")).toEqual([]);
    expect(judged.cases.map((entry) => entry.result.status)).toEqual(CASES.map(([, , status]) => status));
  });

  it("verdicts are deterministic: two judgments produce identical comparison keys and semantic fingerprints", async () => {
    const fingerprint = async () => (await judge()).cases.map((entry) => `${buildEvalComparisonKey(entry.result)}:${semanticVerdictFingerprint(entry.result)}`);
    expect(await fingerprint()).toEqual(await fingerprint());
  });

  it("privacy: seeded Tool data appears in Run state only — never in Trace or any EvalResult", async () => {
    const privacy = evidence.get("privacy")!;
    expect(JSON.stringify(privacy.result.execution!.state)).toContain(SECRET);
    expect(JSON.stringify(privacy.trace)).not.toContain(SECRET);
    const judged = await judge();
    expect(JSON.stringify(judged)).not.toContain(SECRET);
  });
});
