import { describe, expect, it } from "vitest";
import { createAgentNodeExecutor, createAgentRegistry } from "@aao/agent-runtime";
import { createModelNodeExecutor, createModelPolicyRegistry, createModelRegistry, type ModelAdapter, type ModelAdapterResult } from "@aao/model-runtime";
import { createNodeRegistry, executeWorkflow, finalOutputExecutor } from "@aao/runtime";
import { createInMemoryTraceStore, createTraceRecorder, findForbiddenTraceKeys, validateTrace, compareTraceWithExecution } from "../src/index.js";
import { SECRET, clockAt, compile, ofType, trajectory } from "./fixtures.js";

const PROMPT = "Summarize the confidential pipeline for ACME";
const HIDDEN = "INTERNAL-DRAFT-OUTPUT-should-never-be-traced";

function scripted(responses: Array<ModelAdapterResult | Error>): ModelAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    async invoke() {
      const response = responses[adapter.calls++];
      if (response === undefined || response instanceof Error) throw response ?? new Error("unexpected call");
      return response;
    },
  };
  return adapter;
}

function setup(responses: Array<ModelAdapterResult | Error>, identity = true) {
  const models = createModelRegistry();
  const adapter = scripted(responses);
  models.register({ id: "local.fast", priority: 1, capabilities: ["model.text_generation", "model.structured_output"], adapter, ...(identity ? { identity: { provider: "local", model: "scripted-model", revision: "2026-10" } } : {}) });
  const policies = createModelPolicyRegistry();
  policies.register({ schemaVersion: 1, id: "policy.agent", version: "1.0.0", name: "Agent policy" });
  const store = createInMemoryTraceStore();
  const recorder = createTraceRecorder({ store, clock: clockAt(0) });
  return { models, policies, adapter, store, recorder };
}

const modelYaml = `
schemaVersion: 1
id: trace.model
version: "1.0.0"
name: Trace model
entryNodeId: summarize
nodes:
  - id: summarize
    kind: model
    config: { modelPolicyRef: policy.agent, requestStateKey: request, resultStateKey: summary }
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: summarize, targetNodeId: final }
`;

async function runModel(responses: Array<ModelAdapterResult | Error>, identity = true) {
  const world = setup(responses, identity);
  const registry = createNodeRegistry();
  registry.register(createModelNodeExecutor({ models: world.models, policies: world.policies }));
  registry.register(finalOutputExecutor);
  const runId = "run.trace.model";
  const request = { schemaVersion: 1, invocationId: "inv.summary", messages: [{ role: "system", content: SECRET }, { role: "user", content: PROMPT }], output: { kind: "text" } };
  const result = await executeWorkflow({ runId, plan: compile(modelYaml), registry, initialState: { runId, revision: 0, values: { request } }, options: { clock: clockAt(0), trace: world.recorder } });
  return { ...world, result, events: await world.store.getRunTrace(runId) };
}

describe("model trace", () => {
  it("records invocation identity, binding, registered provider identity, finish reason, and usage — never messages or output", async () => {
    const { events, result } = await runModel([{ status: "succeeded", output: HIDDEN, finishReason: "stop", usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } }]);
    expect(result.ok).toBe(true);
    expect(trajectory(events)).toEqual(["run.started", "node.started@summarize", "model.call.started@summarize", "model.call.completed@summarize", "state.updated@summarize", "node.completed@summarize", "route.selected", "node.started@final", "node.completed@final", "run.completed"]);
    expect(ofType(events, "model.call.started")[0]!.payload).toEqual({ invocationId: "inv.summary", attempt: 1, modelPolicyRef: "policy.agent", modelBindingId: "local.fast", outputKind: "text", requiredCapabilityIds: ["model.text_generation"], modelIdentity: { provider: "local", model: "scripted-model", revision: "2026-10" }, recoveryReplay: false });
    expect(ofType(events, "model.call.completed")[0]!.payload).toEqual({ invocationId: "inv.summary", attempt: 1, modelBindingId: "local.fast", outputKind: "text", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 }, modelIdentity: { provider: "local", model: "scripted-model", revision: "2026-10" } });
    const serialized = JSON.stringify(events);
    for (const content of [SECRET, PROMPT, HIDDEN]) expect(serialized).not.toContain(content);
    for (const event of events) expect(findForbiddenTraceKeys(event.payload)).toEqual([]);
    expect(validateTrace(events, { runStatus: "COMPLETED" }).valid).toBe(true);
    expect(compareTraceWithExecution(events, result.execution!).valid).toBe(true);
  });

  it("reports provider identity only when registered — never parsed from the binding id", async () => {
    const { events } = await runModel([{ status: "succeeded", output: "ok" }], false);
    expect(ofType(events, "model.call.started")[0]!.payload).not.toHaveProperty("modelIdentity");
    expect(ofType(events, "model.call.completed")[0]!.payload).not.toHaveProperty("modelIdentity");
  });

  it("a provider failure is model.call.failed with the safe code; no provider error text", async () => {
    const { events, adapter } = await runModel([new Error(`HTTP 500 from https://api.example.com Authorization: Bearer ${SECRET}`)]);
    expect(adapter.calls).toBe(1);
    expect(ofType(events, "model.call.failed")[0]!.payload).toEqual({ invocationId: "inv.summary", attempt: 1, modelBindingId: "local.fast", code: "MODEL_INVOCATION_FAILED", adapterReason: "provider_error" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("api.example.com");
    expect(trajectory(events).slice(-3)).toEqual(["node.failed@summarize", "failure.detected@summarize", "run.failed"]);
  });
});

const agentYaml = `
schemaVersion: 1
id: trace.agent
version: "1.0.0"
name: Trace agent
entryNodeId: research
nodes:
  - id: research
    kind: agent
    config: { agentRef: { id: research.synthesizer, version: "1.0.0" }, taskStateKey: task, resultStateKey: research }
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: research, targetNodeId: final }
`;

async function runAgent(responses: Array<ModelAdapterResult | Error>, maxIterations = 4) {
  const world = setup(responses);
  const agents = createAgentRegistry();
  agents.register({ spec: { schemaVersion: 1, id: "research.synthesizer", version: "1.0.0", name: "Research", modelPolicyRef: "policy.agent", skillRefs: [], toolRefs: [], permissionClasses: ["read_only"] }, instructions: "Secret system instructions: " + SECRET, limits: { maxIterations, maxOutputTokensPerIteration: 256 } });
  const registry = createNodeRegistry();
  registry.register(createAgentNodeExecutor({ agents, models: world.models, policies: world.policies }));
  registry.register(finalOutputExecutor);
  const runId = "run.trace.agent";
  const result = await executeWorkflow({ runId, plan: compile(agentYaml), registry, initialState: { runId, revision: 0, values: { task: PROMPT } }, options: { clock: clockAt(0), trace: world.recorder } });
  return { ...world, result, events: await world.store.getRunTrace(runId) };
}

const decision = (action: string, output: string, tokens = 5): ModelAdapterResult => ({ status: "succeeded", output: { action, output }, finishReason: "stop", usage: { inputTokens: tokens, outputTokens: tokens, totalTokens: 2 * tokens } });

describe("agent trace", () => {
  it("reconstructs the iteration trajectory (CONTINUE → COMPLETE) with model calls nested under the Agent span", async () => {
    const { events, result, adapter } = await runAgent([decision("CONTINUE", `${HIDDEN}-1`), decision("COMPLETE", `${HIDDEN}-2`, 7)]);
    expect(result.ok).toBe(true);
    expect(adapter.calls).toBe(2);
    expect(trajectory(events).filter((label) => label.includes("@research"))).toEqual([
      "node.started@research",
      "agent.started@research",
      "model.call.started@research",
      "model.call.completed@research",
      "agent.iteration.completed@research",
      "model.call.started@research",
      "model.call.completed@research",
      "agent.iteration.completed@research",
      "agent.completed@research",
      "state.updated@research",
      "node.completed@research",
    ]);
    const iterations = ofType(events, "agent.iteration.completed").map((event) => event.payload);
    expect(iterations.map((payload) => [payload.iteration, payload.action, payload.modelBindingId])).toEqual([[1, "CONTINUE", "local.fast"], [2, "COMPLETE", "local.fast"]]);
    expect(iterations[1]).toMatchObject({ usage: { inputTokens: 7, outputTokens: 7, totalTokens: 14 } });
    expect(ofType(events, "agent.started")[0]!.payload).toMatchObject({ agentRef: { id: "research.synthesizer", version: "1.0.0" }, modelPolicyRef: "policy.agent", maxIterations: 4 });
    expect(ofType(events, "agent.completed")[0]!.payload).toMatchObject({ iterationsUsed: 2, usage: { totalTokens: 24 } });
    // Each iteration's invocation is the one its model call span names.
    expect(ofType(events, "model.call.started").map((event) => event.payload.invocationId)).toEqual(iterations.map((payload) => payload.invocationId));
    const agentSpan = ofType(events, "agent.started")[0]!.spanId;
    for (const call of ofType(events, "model.call.started")) expect(call.parentSpanId).toBe(agentSpan);
    expect(validateTrace(events, { runStatus: "COMPLETED" }).valid).toBe(true);
  });

  it("never traces working output, task, instructions, rationale, or reasoning", async () => {
    const { events } = await runAgent([decision("CONTINUE", `${HIDDEN}-1`), decision("COMPLETE", `${HIDDEN}-2`)]);
    const serialized = JSON.stringify(events);
    for (const content of [HIDDEN, PROMPT, SECRET, "Secret system instructions"]) expect(serialized).not.toContain(content);
    for (const event of events) expect(findForbiddenTraceKeys(event.payload)).toEqual([]);
  });

  it("a CONTINUE on the final iteration is agent.failed with the Agent code", async () => {
    const { events, result } = await runAgent([decision("CONTINUE", "a"), decision("CONTINUE", "b")], 2);
    expect(result.ok).toBe(false);
    expect(ofType(events, "agent.iteration.completed")).toHaveLength(2);
    expect(ofType(events, "agent.failed")[0]!.payload).toMatchObject({ code: "MAX_AGENT_ITERATIONS_EXCEEDED" });
    expect(validateTrace(events, { runStatus: "FAILED" }).valid).toBe(true);
  });
});
