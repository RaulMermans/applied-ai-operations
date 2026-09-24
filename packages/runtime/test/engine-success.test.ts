import { describe, expect, it } from "vitest";
import { executeWorkflow } from "../src/engine.js";
import { finalOutputExecutor } from "../src/default-registry.js";
import { buildRequest, buildRunState, buildWorkflow, compileOrThrow, createTestRegistry, literalPatchExecutor, minimalPlan } from "./fixtures.js";

describe("executeWorkflow — successful execution", () => {
  it("executes a single deterministic node routing directly to final_output", async () => {
    const result = await executeWorkflow(buildRequest({ runId: "run.single", plan: minimalPlan }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.run.status).toBe("COMPLETED");
  });

  it("routes deterministic -> deterministic -> final_output, applying each state patch in order", async () => {
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "a",
        nodes: [
          { id: "a", kind: "deterministic", config: { statePatch: { value: 4 } } },
          { id: "b", kind: "deterministic", config: { statePatch: { result: 8 } } },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [
          { sourceNodeId: "a", targetNodeId: "b" },
          { sourceNodeId: "b", targetNodeId: "final" },
        ],
      }),
    );
    const request = buildRequest({ runId: "run.multi", plan, initialState: buildRunState("run.multi", { value: 2 }) });
    const result = await executeWorkflow(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toEqual({ value: 4, result: 8 });
    expect(result.execution.state.values).toEqual({ value: 4, result: 8 });
  });

  it("returns final_output's output as RunState.values by default", async () => {
    const request = buildRequest({ runId: "run.output", initialState: buildRunState("run.output", { a: 1 }) });
    const result = await executeWorkflow(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toEqual({ a: 1 });
  });

  it("executes nodes in deterministic order matching the compiled routing", async () => {
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "a",
        nodes: [
          { id: "a", kind: "deterministic", config: {} },
          { id: "b", kind: "deterministic", config: {} },
          { id: "c", kind: "deterministic", config: {} },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [
          { sourceNodeId: "a", targetNodeId: "b" },
          { sourceNodeId: "b", targetNodeId: "c" },
          { sourceNodeId: "c", targetNodeId: "final" },
        ],
      }),
    );
    const result = await executeWorkflow(buildRequest({ runId: "run.order", plan }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.history.map((record) => record.nodeId)).toEqual(["a", "b", "c", "final"]);
    expect(result.execution.history.map((record) => record.step)).toEqual([1, 2, 3, 4]);
    expect(result.execution.history.every((record) => record.status === "SUCCEEDED")).toBe(true);
  });

  it("supports a single-node plan whose entry node is itself final_output", async () => {
    const plan = compileOrThrow(buildWorkflow({ entryNodeId: "final", nodes: [{ id: "final", kind: "final_output", config: {} }], edges: [] }));
    const registry = createTestRegistry(finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.solo", plan, registry }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.history).toHaveLength(1);
  });

  it("marks the run COMPLETED and returns the caller-provided runId unchanged", async () => {
    const result = await executeWorkflow(buildRequest({ runId: "run.identity" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.run.runId).toBe("run.identity");
    expect(result.execution.run.status).toBe("COMPLETED");
  });

  it("executes the literalPatchExecutor fixture only for nodes with a statePatch, matching the general deterministic-executor pattern", async () => {
    const registry = createTestRegistry(literalPatchExecutor, finalOutputExecutor);
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "no-op",
        nodes: [
          { id: "no-op", kind: "deterministic", config: {} },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [{ sourceNodeId: "no-op", targetNodeId: "final" }],
      }),
    );
    const request = buildRequest({ runId: "run.noop", plan, registry, initialState: buildRunState("run.noop", { a: 1 }) });
    const result = await executeWorkflow(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No patch from "no-op" -> revision stays at 0 through that node.
    expect(result.execution.history[0]?.stateRevisionBefore).toBe(0);
    expect(result.execution.history[0]?.stateRevisionAfter).toBe(0);
    expect(result.execution.state.values).toEqual({ a: 1 });
  });
});
