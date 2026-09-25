import { describe, expect, it, vi } from "vitest";
import { identifierSchema } from "@aao/contracts";
import { compileWorkflow } from "@aao/workflow-dsl";
import { createNodeRegistry, executeWorkflow, finalOutputExecutor, validateSnapshotAgainstPlan } from "@aao/runtime";
import { validateModelRequest } from "@aao/model-runtime";
import { createAgentNodeExecutor } from "../src/agent-node.js";
import { buildIterationModelRequest } from "../src/decision.js";
import { deriveAgentExecutionId } from "../src/execution-id.js";
import { AgentExecutionRequestSchema, AgentResultSchema, MAX_AGENT_ITERATIONS_CEILING } from "../src/types.js";
import { AGENT_REF, buildAgent, buildWorld, decision } from "./fixtures.js";

/** A maximum-length (256-character) canonical identifier. */
function maxLengthId(prefix: string): string {
  const id = `${prefix}.${"x".repeat(256 - prefix.length - 1)}`;
  expect(identifierSchema.parse(id)).toHaveLength(256);
  return id;
}

const LONG_RUN_ID = maxLengthId("run");
const LONG_NODE_ID = maxLengthId("node");

describe("deriveAgentExecutionId", () => {
  it("derives a bounded, schema-valid id from maximum-length Run and Node ids", () => {
    const id = deriveAgentExecutionId(LONG_RUN_ID, LONG_NODE_ID);
    expect(id).toMatch(/^agent\.[0-9a-f]{64}$/);
    expect(id).toHaveLength(70);
    expect(AgentExecutionRequestSchema.safeParse({ schemaVersion: 1, agentExecutionId: id, agentRef: { ...AGENT_REF }, task: "Task." }).success).toBe(true);
  });

  it.each([1, MAX_AGENT_ITERATIONS_CEILING])("iteration %i invocation id passes ModelRequest validation", (iteration) => {
    const state = { agentExecutionId: deriveAgentExecutionId(LONG_RUN_ID, LONG_NODE_ID), agentRef: { ...AGENT_REF }, task: "Task.", iteration, history: [] };
    const request = buildIterationModelRequest(buildAgent({ limits: { maxIterations: MAX_AGENT_ITERATIONS_CEILING } }), state);
    expect(request.invocationId).toBe(`${state.agentExecutionId}.i${iteration}`);
    expect(validateModelRequest(request).ok).toBe(true);
  });

  it("same Run + Node → identical id; different Run or Node → different id", () => {
    expect(deriveAgentExecutionId("run.a", "research")).toBe(deriveAgentExecutionId("run.a", "research"));
    expect(deriveAgentExecutionId("run.a", "research")).not.toBe(deriveAgentExecutionId("run.b", "research"));
    expect(deriveAgentExecutionId("run.a", "research")).not.toBe(deriveAgentExecutionId("run.a", "summarize"));
  });

  it("is unambiguous where plain concatenation would collide", () => {
    // `${runId}.${nodeId}` would be "a.b.c" for both pairs.
    expect(deriveAgentExecutionId("a.b", "c")).not.toBe(deriveAgentExecutionId("a", "b.c"));
  });

  it("has no random or time dependency", () => {
    const before = deriveAgentExecutionId("run.a", "research");
    const random = vi.spyOn(Math, "random").mockReturnValue(0.123);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      expect(deriveAgentExecutionId("run.a", "research")).toBe(before);
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
    // A pinned value guards against accidental changes to the derivation itself.
    expect(before).toBe("agent.b14c152401747364db7dddf0d4b23a894da11b12131bff4895365572da6f98f8");
  });

  it("rejects non-canonical inputs as a programming error", () => {
    expect(() => deriveAgentExecutionId("", "research")).toThrow();
    expect(() => deriveAgentExecutionId("run.a", "has space")).toThrow();
  });
});

describe("agent node with maximum-length Run and Node ids", () => {
  it("executes end to end: the workflow that passes preflight also passes Agent request validation", async () => {
    const compiled = compileWorkflow({
      schemaVersion: 1,
      id: "test.agent-long-ids",
      version: "1.0.0",
      name: "Agent long ids",
      entryNodeId: LONG_NODE_ID,
      nodes: [
        { id: LONG_NODE_ID, kind: "agent", config: { agentRef: { ...AGENT_REF }, taskStateKey: "task", resultStateKey: "research" } },
        { id: "final", kind: "final_output", config: {} },
      ],
      edges: [{ sourceNodeId: LONG_NODE_ID, targetNodeId: "final" }],
    });
    if (!compiled.ok) throw new Error("fixture failed to compile");
    const world = buildWorld([decision("COMPLETE", "Done.")]);
    const registry = createNodeRegistry();
    registry.register(createAgentNodeExecutor(world));
    registry.register(finalOutputExecutor);
    let tick = 0;
    const clock = { now: () => new Date(Date.UTC(2026, 8, 25, 12, 0, tick++)).toISOString() };

    const result = await executeWorkflow({ runId: LONG_RUN_ID, plan: compiled.plan, initialState: { runId: LONG_RUN_ID, revision: 0, values: { task: "Task." } }, registry, options: { clock } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.run.status).toBe("COMPLETED");
    const agentResult = AgentResultSchema.parse(result.execution.state.values.research);
    expect(agentResult.agentExecutionId).toBe(deriveAgentExecutionId(LONG_RUN_ID, LONG_NODE_ID));
    expect(world.primary.calls).toHaveLength(1);
    expect(agentResult.history[0]?.invocationId).toBe(`${agentResult.agentExecutionId}.i1`);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, compiled.plan)).toBeUndefined();
  });
});
