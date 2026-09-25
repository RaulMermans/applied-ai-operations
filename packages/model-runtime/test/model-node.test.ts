import { describe, expect, it } from "vitest";
import type { NodeDefinition } from "@aao/contracts";
import { compileWorkflow } from "@aao/workflow-dsl";
import { createNodeRegistry, createRuntimeV1Registry, executeWorkflow, finalOutputExecutor, validateSnapshotAgainstPlan, type NodeExecutor } from "@aao/runtime";
import { createModelNodeExecutor } from "../src/model-node.js";
import { TEXT_ONLY, buildPolicy, buildRegistries, buildTextRequest, spyAdapter, succeeded } from "./fixtures.js";

function clock() {
  let calls = 0;
  return { now: () => new Date(Date.UTC(2026, 8, 24, 10, 0, calls++)).toISOString() };
}

/** deterministic spy -> model -> final */
function planWith(modelConfig: NodeDefinition["config"]) {
  const result = compileWorkflow({
    schemaVersion: 1,
    id: "test.model-node",
    version: "1.0.0",
    name: "Model node test",
    entryNodeId: "prepare",
    nodes: [
      { id: "prepare", kind: "deterministic", config: {} },
      { id: "classify", kind: "model", config: modelConfig },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [
      { sourceNodeId: "prepare", targetNodeId: "classify" },
      { sourceNodeId: "classify", targetNodeId: "final" },
    ],
  });
  if (!result.ok) throw new Error("fixture failed to compile");
  return result.plan;
}

const GOOD_CONFIG = { modelPolicyRef: "policy.default", requestStateKey: "modelRequest", resultStateKey: "modelResult" };

function setup(options: { policies?: Parameters<typeof buildRegistries>[1] } = {}) {
  const adapter = spyAdapter(succeeded("Hello!", { finishReason: "stop" }));
  const deps = buildRegistries([{ id: "local.fast", priority: 1, capabilities: TEXT_ONLY, adapter }], options.policies);
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
  registry.register(createModelNodeExecutor(deps));
  registry.register(finalOutputExecutor);
  return { adapter, registry, prepareCalls };
}

const initialState = { runId: "run.model", revision: 0, values: { modelRequest: buildTextRequest() } };

describe("model node — preflight static config validation", () => {
  it.each([
    ["missing modelPolicyRef", { requestStateKey: "modelRequest", resultStateKey: "modelResult" }],
    ["missing requestStateKey", { modelPolicyRef: "policy.default", resultStateKey: "modelResult" }],
    ["path expression as state key", { ...GOOD_CONFIG, requestStateKey: "$.input.request" }],
    ["same request and result key", { ...GOOD_CONFIG, resultStateKey: "modelRequest" }],
    ["unknown field (prompt template)", { ...GOOD_CONFIG, promptTemplate: "Hello {{name}}" }],
    ["unregistered policy", { ...GOOD_CONFIG, modelPolicyRef: "policy.missing" }],
  ])("%s → RUNTIME_PREFLIGHT_FAILED with zero nodes executed", async (_label, config) => {
    const { adapter, registry, prepareCalls } = setup();
    const result = await executeWorkflow({ runId: "run.model", plan: planWith(config), initialState, registry, options: { clock: clock() } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: "RUNTIME_PREFLIGHT_FAILED", nodeId: "classify" });
    expect(prepareCalls).toEqual([]);
    expect(adapter.calls).toEqual([]);
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ prepare: "PENDING", classify: "PENDING", final: "PENDING" });
  });

  it("a policy with unsupported constraints fails preflight (fail closed)", async () => {
    const { registry, prepareCalls } = setup({ policies: [buildPolicy({ constraints: { tier: "gold" } })] });
    const result = await executeWorkflow({ runId: "run.model", plan: planWith(GOOD_CONFIG), initialState, registry, options: { clock: clock() } });
    expect(!result.ok && result.failure.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(prepareCalls).toEqual([]);
  });
});

describe("model node — execution", () => {
  it("succeeds via a Runtime-applied state patch, advancing revision by one", async () => {
    const { adapter, registry } = setup();
    const result = await executeWorkflow({ runId: "run.model", plan: planWith(GOOD_CONFIG), initialState, registry, options: { clock: clock() } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(adapter.calls).toHaveLength(1);
    expect(result.execution.state.revision).toBe(1);
    expect(result.execution.state.values.modelRequest).toEqual(buildTextRequest());
    expect(result.execution.state.values.modelResult).toEqual({
      schemaVersion: 1,
      invocationId: "inv.text.1",
      modelBindingId: "local.fast",
      outputKind: "text",
      output: "Hello!",
      finishReason: "stop",
    });
    expect(result.execution.history.find((record) => record.nodeId === "classify")).toMatchObject({ status: "SUCCEEDED", stateRevisionBefore: 0, stateRevisionAfter: 1 });
    // The caller's initial state object is never mutated.
    expect(initialState.values).not.toHaveProperty("modelResult");
  });

  it("an invalid request in state fails the node, leaving state untouched and invoking no model", async () => {
    const { adapter, registry } = setup();
    const badState = { runId: "run.model", revision: 0, values: { modelRequest: { schemaVersion: 1, messages: [] } } };
    const result = await executeWorkflow({ runId: "run.model", plan: planWith(GOOD_CONFIG), initialState: badState, registry, options: { clock: clock() } });
    expect(!result.ok && result.failure).toEqual({
      code: "NODE_EXECUTION_FAILED",
      message: 'Node "classify" (kind "model") reported an executor failure.',
      nodeId: "classify",
      step: 2,
      executorFailure: { namespace: "model", code: "INVALID_MODEL_REQUEST" },
    });
    expect(adapter.calls).toEqual([]);
    expect(result.execution?.state).toEqual(badState);
    expect(result.execution?.nodeStatusesById).toEqual({ prepare: "SUCCEEDED", classify: "FAILED", final: "PENDING" });
  });

  it("a missing request key fails the node the same way", async () => {
    const { registry } = setup();
    const result = await executeWorkflow({ runId: "run.model", plan: planWith(GOOD_CONFIG), initialState: { runId: "run.model", revision: 0, values: {} }, registry, options: { clock: clock() } });
    expect(!result.ok && result.failure.code).toBe("NODE_EXECUTION_FAILED");
    expect(!result.ok && result.failure.executorFailure).toEqual({ namespace: "model", code: "INVALID_MODEL_REQUEST" });
  });

  it("MODEL_ROUTE_NOT_FOUND surfaces as NODE_EXECUTION_FAILED + executorFailure { model, MODEL_ROUTE_NOT_FOUND }; state untouched; snapshot valid", async () => {
    // Only a text binding is registered, but the policy requires structured output.
    const { adapter, registry } = setup({ policies: [buildPolicy({ requiredCapabilities: ["model.structured_output"] })] });
    const plan = planWith(GOOD_CONFIG);
    const result = await executeWorkflow({ runId: "run.model", plan, initialState, registry, options: { clock: clock() } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      code: "NODE_EXECUTION_FAILED",
      message: 'Node "classify" (kind "model") reported an executor failure.',
      nodeId: "classify",
      step: 2,
      executorFailure: { namespace: "model", code: "MODEL_ROUTE_NOT_FOUND" },
    });
    expect(adapter.calls).toEqual([]);
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ prepare: "SUCCEEDED", classify: "FAILED", final: "PENDING" });
    expect(result.execution?.state).toEqual(initialState);
    expect(result.latestSnapshot?.stateSnapshot.revision).toBe(0);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
    // Only the safe code crosses into the Runtime: no Model Runtime message or details.
    const serialized = JSON.stringify(result.failure);
    expect(serialized).not.toMatch(/requiredCapabilities|binding satisfies/);
    expect(JSON.parse(serialized)).toEqual(result.failure);
  });
});

describe("generic Runtime stays model-agnostic", () => {
  it("without an explicitly registered model executor, a model node yields NODE_EXECUTOR_NOT_FOUND", async () => {
    const result = await executeWorkflow({ runId: "run.model", plan: planWith(GOOD_CONFIG), initialState, registry: createRuntimeV1Registry(), options: { clock: clock() } });
    expect(!result.ok && result.failure.code).toBe("NODE_EXECUTOR_NOT_FOUND");
  });
});
