import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { RuntimeExecutionSnapshotSchema, createNodeRegistry, executeWorkflow, finalOutputExecutor, validateSnapshotAgainstPlan } from "@aao/runtime";
import { createModelPolicyRegistry, createModelRegistry } from "@aao/model-runtime";
import { createVercelAiModelAdapter } from "@aao/model-runtime/vercel-ai";
import { createAgentNodeExecutor } from "../src/agent-node.js";
import { deriveAgentExecutionId } from "../src/execution-id.js";
import { createAgentRegistry } from "../src/registry.js";
import { AgentResultSchema } from "../src/types.js";
import { TEXT_AND_STRUCTURED, buildAgent, buildPolicy } from "./fixtures.js";

/**
 * Real production path, no network, no credentials:
 * YAML → Workflow Compiler → managed Runtime → Agent Node → Agent Runtime →
 * Model Runtime → Vercel AI SDK adapter → `ai/test` MockLanguageModelV3.
 */
const WORKFLOW_YAML = `
schemaVersion: 1
id: examples.bounded-agent
version: "1.0.0"
name: Bounded research agent
entryNodeId: research
nodes:
  - id: research
    kind: agent
    config:
      agentRef:
        id: research.synthesizer
        version: "1.0.0"
      taskStateKey: task
      resultStateKey: research
  - id: final
    kind: final_output
    config: {}
edges:
  - sourceNodeId: research
    targetNodeId: final
`;

const TASK = "Summarize the market for local-first workflow tools.";
const SECRET = "sk-live-SECRET https://api.example.com/v1?key=abc";

function compile() {
  const compiled = compileWorkflowSource(WORKFLOW_YAML, "yaml");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.plan;
}

function jsonResponse(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
    warnings: [],
  };
}

/** A mock whose call *n* returns (or throws) `script[n]`; running past the script throws. */
function scriptedModel(script: Array<{ action: string; output: string } | Error>) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = script[call++];
      if (step === undefined) throw new Error("scriptedModel: unexpected extra call");
      if (step instanceof Error) throw step;
      return jsonResponse(step);
    },
  });
}

function testClock() {
  let calls = 0;
  return { now: () => new Date(Date.UTC(2026, 8, 24, 14, 0, calls++)).toISOString() };
}

/** A primary structured binding plus a compatible lower-priority backup that must never be used. */
function buildWorld(primary: MockLanguageModelV3, options: { maxIterations?: number } = {}) {
  const backup = scriptedModel([{ action: "COMPLETE", output: "backup answer" }]);
  const models = createModelRegistry();
  models.register({ id: "local.agent", priority: 10, capabilities: TEXT_AND_STRUCTURED, adapter: createVercelAiModelAdapter({ model: primary }) });
  models.register({ id: "local.backup", priority: 1, capabilities: TEXT_AND_STRUCTURED, adapter: createVercelAiModelAdapter({ model: backup }) });
  const policies = createModelPolicyRegistry();
  policies.register(buildPolicy({ requiredCapabilities: ["model.structured_output"] }));
  const agents = createAgentRegistry();
  agents.register(buildAgent({ limits: { maxIterations: options.maxIterations ?? 4 } }));
  const registry = createNodeRegistry();
  registry.register(createAgentNodeExecutor({ agents, policies, models }));
  registry.register(finalOutputExecutor);
  return { registry, backup };
}

function run(primary: MockLanguageModelV3, runId: string, options: { maxIterations?: number } = {}) {
  const plan = compile();
  const { registry, backup } = buildWorld(primary, options);
  const initialState = { runId, revision: 0, values: { task: TASK } };
  return { plan, backup, initialState, result: executeWorkflow({ runId, plan, initialState, registry, options: { clock: testClock() } }) };
}

describe("Agent workflow E2E: YAML → compiler → Runtime → Agent Node → Agent Runtime → Model Runtime → AI SDK test model", () => {
  it("one iteration: COMPLETE → state patch → final_output → COMPLETED", async () => {
    const primary = scriptedModel([{ action: "COMPLETE", output: "Local-first tools are growing." }]);
    const { plan, backup, result: pending } = run(primary, "run.agent.one");
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(backup.doGenerateCalls).toHaveLength(0);
    expect(result.execution.run.status).toBe("COMPLETED");
    expect(result.execution.nodeStatusesById).toEqual({ research: "SUCCEEDED", final: "SUCCEEDED" });
    expect(result.execution.step).toBe(2);
    expect(result.execution.state.revision).toBe(1);
    const agentResult = AgentResultSchema.parse(result.execution.state.values.research);
    expect(agentResult).toEqual({
      schemaVersion: 1,
      agentExecutionId: deriveAgentExecutionId("run.agent.one", "research"),
      agentRef: { id: "research.synthesizer", version: "1.0.0" },
      finalOutput: "Local-first tools are growing.",
      iterationsUsed: 1,
      history: [
        {
          iteration: 1,
          action: "COMPLETE",
          output: "Local-first tools are growing.",
          invocationId: `${deriveAgentExecutionId("run.agent.one", "research")}.i1`,
          modelBindingId: "local.agent",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        },
      ],
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });
    expect(result.output).toEqual({ task: TASK, research: agentResult });
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
    expect(RuntimeExecutionSnapshotSchema.parse(JSON.parse(JSON.stringify(result.latestSnapshot)))).toEqual(result.latestSnapshot);
  });

  it("multi-iteration: CONTINUE → CONTINUE → COMPLETE is 3 model calls but ONE workflow step and ONE revision", async () => {
    const primary = scriptedModel([
      { action: "CONTINUE", output: "Draft 1." },
      { action: "CONTINUE", output: "Draft 2." },
      { action: "COMPLETE", output: "Final synthesis." },
    ]);
    const { plan, backup, result: pending } = run(primary, "run.agent.multi");
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(primary.doGenerateCalls).toHaveLength(3);
    expect(backup.doGenerateCalls).toHaveLength(0);
    const agentResult = AgentResultSchema.parse(result.execution.state.values.research);
    expect(agentResult.iterationsUsed).toBe(3);
    expect(agentResult.history.map((record) => record.action)).toEqual(["CONTINUE", "CONTINUE", "COMPLETE"]);
    expect(agentResult.finalOutput).toBe("Final synthesis.");
    expect(agentResult.usage).toEqual({ inputTokens: 60, outputTokens: 15, totalTokens: 75 });

    // Agent iterations ≠ workflow steps.
    expect(result.execution.step).toBe(2);
    expect(result.execution.history.map((record) => [record.nodeId, record.step, record.stateRevisionBefore, record.stateRevisionAfter])).toEqual([
      ["research", 1, 0, 1],
      ["final", 2, 1, 1],
    ]);
    expect(result.execution.state.revision).toBe(1);
    expect(result.execution.run.status).toBe("COMPLETED");
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
  });

  it("max iterations: CONTINUE on every permitted iteration → MAX_AGENT_ITERATIONS_EXCEEDED, no extra call, workflow state unchanged", async () => {
    const primary = scriptedModel([
      { action: "CONTINUE", output: "Draft 1." },
      { action: "CONTINUE", output: "Draft 2." },
      { action: "CONTINUE", output: "Draft 3." },
      { action: "COMPLETE", output: "would be a 4th call" },
    ]);
    const { plan, backup, initialState, result: pending } = run(primary, "run.agent.max", { maxIterations: 3 });
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(primary.doGenerateCalls).toHaveLength(3);
    expect(backup.doGenerateCalls).toHaveLength(0);
    expect(result.failure).toEqual({
      code: "NODE_EXECUTION_FAILED",
      message: 'Node "research" (kind "agent") reported an executor failure.',
      nodeId: "research",
      step: 1,
      executorFailure: { namespace: "agent", code: "MAX_AGENT_ITERATIONS_EXCEEDED" },
      category: "EXECUTION", retryable: false, attempt: 1, maxAttempts: 1,
    });
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ research: "FAILED", final: "PENDING" });
    expect(result.execution?.state).toEqual(initialState);
    expect(result.latestSnapshot?.stateSnapshot.revision).toBe(0);
    expect(result.latestSnapshot?.stateSnapshot.values).toEqual({ task: TASK });
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Draft");
  });

  it("model failure on iteration 2 → agent fails, no iteration 3, no retry/fallback, workflow state unchanged, redacted", async () => {
    const primary = scriptedModel([{ action: "CONTINUE", output: "Draft 1." }, new Error(SECRET), { action: "COMPLETE", output: "retry would land here" }]);
    const { plan, backup, initialState, result: pending } = run(primary, "run.agent.model-fail");
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(primary.doGenerateCalls).toHaveLength(2);
    expect(backup.doGenerateCalls).toHaveLength(0);
    expect(result.failure).toMatchObject({ code: "NODE_EXECUTION_FAILED", nodeId: "research", executorFailure: { namespace: "agent", code: "AGENT_MODEL_EXECUTION_FAILED" } });
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ research: "FAILED", final: "PENDING" });
    expect(result.execution?.state).toEqual(initialState);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SECRET|example\.com|Draft/);
  });
});
