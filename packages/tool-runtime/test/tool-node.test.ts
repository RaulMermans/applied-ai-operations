import { describe, expect, it } from "vitest";
import type { NodeDefinition, PermissionClass } from "@aao/contracts";
import { compileWorkflow } from "@aao/workflow-dsl";
import { createNodeRegistry, createRuntimeV1Registry, executeWorkflow, finalOutputExecutor, validateSnapshotAgainstPlan, type NodeExecutor } from "@aao/runtime";
import { deriveToolExecutionId } from "../src/execution-id.js";
import { createToolNodeExecutor } from "../src/tool-node.js";
import { LOOKUP_REF, lookupWorld, maxLengthId } from "./fixtures.js";

function clock() {
  let calls = 0;
  return { now: () => new Date(Date.UTC(2026, 8, 25, 12, 0, calls++)).toISOString() };
}

/** prepare (deterministic spy) → lookup (tool) → final */
function planWith(toolConfig: NodeDefinition["config"], toolNodeId = "lookup") {
  const result = compileWorkflow({
    schemaVersion: 1,
    id: "test.tool-node",
    version: "1.0.0",
    name: "Tool node test",
    entryNodeId: "prepare",
    nodes: [
      { id: "prepare", kind: "deterministic", config: {} },
      { id: toolNodeId, kind: "tool", config: toolConfig },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [
      { sourceNodeId: "prepare", targetNodeId: toolNodeId },
      { sourceNodeId: toolNodeId, targetNodeId: "final" },
    ],
  });
  if (!result.ok) throw new Error("fixture failed to compile");
  return result.plan;
}

const GOOD_CONFIG = { toolRef: { ...LOOKUP_REF }, inputStateKey: "lookupInput", resultStateKey: "lookupResult" };

function setup(options: Parameters<typeof lookupWorld>[0] = {}) {
  const world = lookupWorld(options);
  const prepareCalls: string[] = [];
  const prepare: NodeExecutor = {
    kind: "deterministic",
    async execute(context) {
      prepareCalls.push(context.node.id);
      return { ok: true };
    },
  };
  const registry = createNodeRegistry();
  registry.register(prepare);
  registry.register(createToolNodeExecutor({ tools: world.tools }));
  registry.register(finalOutputExecutor);
  return { ...world, registry, prepareCalls };
}

const initialState = { runId: "run.tool", revision: 0, values: { lookupInput: { query: "alpha" } } };

describe("tool node — preflight", () => {
  it.each<[string, NodeDefinition["config"], Parameters<typeof lookupWorld>[0]?]>([
    ["missing toolRef", { inputStateKey: "lookupInput", resultStateKey: "lookupResult" }],
    ["toolRef without version", { ...GOOD_CONFIG, toolRef: { id: LOOKUP_REF.id } }],
    ["missing inputStateKey", { toolRef: GOOD_CONFIG.toolRef, resultStateKey: "lookupResult" }],
    ["same input and result key", { ...GOOD_CONFIG, resultStateKey: "lookupInput" }],
    ["JSONPath as state key", { ...GOOD_CONFIG, inputStateKey: "$.input.query" }],
    ["template as state key", { ...GOOD_CONFIG, resultStateKey: "{{result}}" }],
    ["unknown field (inline handler)", { ...GOOD_CONFIG, handler: "import('./evil.js')" }],
    ["unknown field (permission override)", { ...GOOD_CONFIG, permissionClasses: ["read_only"] }],
    ["unregistered tool", { ...GOOD_CONFIG, toolRef: { id: "local.missing", version: "1.0.0" } }],
    ["unregistered tool version", { ...GOOD_CONFIG, toolRef: { id: LOOKUP_REF.id, version: "2.0.0" } }],
    ["external_side_effect tool", GOOD_CONFIG, { spec: { permissionClasses: ["external_side_effect"] } }],
    ["destructive tool", GOOD_CONFIG, { spec: { permissionClasses: ["destructive"] } }],
    ["sensitive_data tool", GOOD_CONFIG, { spec: { permissionClasses: ["sensitive_data"] } }],
    ["read_only + sensitive_data tool", GOOD_CONFIG, { spec: { permissionClasses: ["read_only", "sensitive_data"] } }],
  ])("%s → RUNTIME_PREFLIGHT_FAILED; zero workflow nodes execute; zero handler calls", async (_label, config, worldOptions) => {
    const { registry, handler, prepareCalls } = setup(worldOptions);
    const result = await executeWorkflow({ runId: "run.tool", plan: planWith(config), initialState, registry, options: { clock: clock() } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: "RUNTIME_PREFLIGHT_FAILED", nodeId: "lookup" });
    expect(prepareCalls).toEqual([]);
    expect(handler.calls).toEqual([]);
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ prepare: "PENDING", lookup: "PENDING", final: "PENDING" });
    expect(result.execution?.state).toEqual(initialState);
  });

  it.each<[PermissionClass[], string]>([
    [["external_side_effect"], "external_side_effect"],
    [["read_only", "sensitive_data"], "sensitive_data"],
  ])("names the unsupported permission classes %j in the preflight issues", async (permissionClasses, named) => {
    const { registry } = setup({ spec: { permissionClasses } });
    const result = await executeWorkflow({ runId: "run.tool", plan: planWith(GOOD_CONFIG), initialState, registry, options: { clock: clock() } });
    expect(!result.ok && result.failure.details).toEqual({
      issues: [`toolRef: TOOL_PERMISSION_UNSUPPORTED: tool "local.lookup" version "1.0.0" requires unsupported permission classes: ${named}`],
    });
  });

  it("preflight does not inspect runtime state: invalid input still passes preflight and fails at execution", async () => {
    const { registry, prepareCalls } = setup();
    const badState = { runId: "run.tool", revision: 0, values: { lookupInput: { wrong: 1 } } };
    const result = await executeWorkflow({ runId: "run.tool", plan: planWith(GOOD_CONFIG), initialState: badState, registry, options: { clock: clock() } });
    expect(!result.ok && result.failure.code).toBe("NODE_EXECUTION_FAILED");
    expect(prepareCalls).toEqual(["prepare"]);
  });
});

describe("tool node — execution", () => {
  it("reads input, runs the Tool once, and proposes exactly one Runtime-applied patch", async () => {
    const { registry, handler } = setup();
    const plan = planWith(GOOD_CONFIG);
    const result = await executeWorkflow({ runId: "run.tool", plan, initialState, registry, options: { clock: clock() } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(handler.calls).toEqual([{ toolExecutionId: deriveToolExecutionId("run.tool", "lookup"), tool: { ...LOOKUP_REF }, input: { query: "alpha" } }]);
    expect(result.execution.state.revision).toBe(1);
    expect(result.execution.state.values.lookupResult).toEqual({
      schemaVersion: 1,
      toolExecutionId: deriveToolExecutionId("run.tool", "lookup"),
      toolRef: { ...LOOKUP_REF },
      output: { items: ["alpha-result"] },
    });
    expect(result.execution.history.find((record) => record.nodeId === "lookup")).toMatchObject({ status: "SUCCEEDED", stateRevisionBefore: 0, stateRevisionAfter: 1 });
    expect(initialState.values).not.toHaveProperty("lookupResult");
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
  });

  it("maximum-length Run and Node ids derive a valid Tool execution id and succeed", async () => {
    const { registry, handler } = setup();
    const runId = maxLengthId("run");
    const nodeId = maxLengthId("node");
    const plan = planWith(GOOD_CONFIG, nodeId);
    const result = await executeWorkflow({ runId, plan, initialState: { ...initialState, runId }, registry, options: { clock: clock() } });
    expect(result.ok).toBe(true);
    expect(handler.calls[0]?.toolExecutionId).toBe(deriveToolExecutionId(runId, nodeId));
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["missing input", {}, "INVALID_TOOL_REQUEST"],
    ["schema-violating input", { lookupInput: { query: 42 } }, "TOOL_INPUT_SCHEMA_MISMATCH"],
  ])("%s → node FAILED with executorFailure { tool, %s }; handler not called; state untouched", async (_label, values, code) => {
    const { registry, handler } = setup();
    const badState = { runId: "run.tool", revision: 0, values } as typeof initialState;
    const result = await executeWorkflow({ runId: "run.tool", plan: planWith(GOOD_CONFIG), initialState: badState, registry, options: { clock: clock() } });
    expect(!result.ok && result.failure).toEqual({
      code: "NODE_EXECUTION_FAILED",
      message: 'Node "lookup" (kind "tool") reported an executor failure.',
      nodeId: "lookup",
      step: 2,
      executorFailure: { namespace: "tool", code },
    });
    expect(handler.calls).toEqual([]);
    expect(result.execution?.state).toEqual(badState);
    expect(result.execution?.nodeStatusesById).toEqual({ prepare: "SUCCEEDED", lookup: "FAILED", final: "PENDING" });
  });
});

describe("generic Runtime stays tool-agnostic", () => {
  it("without an explicitly registered tool executor, a tool node yields NODE_EXECUTOR_NOT_FOUND", async () => {
    const registry = createRuntimeV1Registry();
    registry.register({ kind: "deterministic", execute: async () => ({ ok: true }) });
    const result = await executeWorkflow({ runId: "run.tool", plan: planWith(GOOD_CONFIG), initialState, registry, options: { clock: clock() } });
    expect(!result.ok && result.failure).toMatchObject({ code: "NODE_EXECUTOR_NOT_FOUND", nodeId: "lookup" });
    expect(result.execution?.nodeStatusesById).toEqual({ prepare: "PENDING", lookup: "PENDING", final: "PENDING" });
  });
});
