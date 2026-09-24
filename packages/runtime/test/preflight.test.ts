import { describe, expect, it } from "vitest";
import { runPreflight } from "../src/preflight.js";
import { finalOutputExecutor } from "../src/default-registry.js";
import { createTestRegistry, buildWorkflow, compileOrThrow, literalPatchExecutor, minimalPlan } from "./fixtures.js";

describe("runPreflight", () => {
  it("passes for a plan whose every node kind is registered and has no conditional routing", () => {
    const registry = createTestRegistry(literalPatchExecutor, finalOutputExecutor);
    expect(runPreflight(minimalPlan, registry)).toBeUndefined();
  });

  it("rejects a plan with a missing executor (NODE_EXECUTOR_NOT_FOUND)", () => {
    const registry = createTestRegistry(finalOutputExecutor); // no "deterministic" executor
    const failure = runPreflight(minimalPlan, registry);
    expect(failure?.code).toBe("NODE_EXECUTOR_NOT_FOUND");
    expect(failure?.nodeId).toBe("intake");
  });

  it("rejects every unsupported node kind (model, agent, tool, approval, evaluator) the same way", () => {
    for (const kind of ["model", "agent", "tool", "approval", "evaluator"] as const) {
      const plan = compileOrThrow(
        buildWorkflow({
          entryNodeId: "unsupported",
          nodes: [
            { id: "unsupported", kind, config: {} },
            { id: "final", kind: "final_output", config: {} },
          ],
          edges: [{ sourceNodeId: "unsupported", targetNodeId: "final" }],
        }),
      );
      const registry = createTestRegistry(finalOutputExecutor);
      const failure = runPreflight(plan, registry);
      expect(failure?.code).toBe("NODE_EXECUTOR_NOT_FOUND");
      expect(failure?.nodeId).toBe("unsupported");
    }
  });

  it("rejects a plan containing a conditional edge (CONDITIONAL_ROUTING_UNSUPPORTED)", () => {
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "intake",
        nodes: [
          { id: "intake", kind: "deterministic", config: {} },
          { id: "branch-a", kind: "deterministic", config: {} },
          { id: "branch-b", kind: "deterministic", config: {} },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [
          { sourceNodeId: "intake", targetNodeId: "branch-a", condition: { when: "x" } },
          { sourceNodeId: "intake", targetNodeId: "branch-b" },
          { sourceNodeId: "branch-a", targetNodeId: "final" },
          { sourceNodeId: "branch-b", targetNodeId: "final" },
        ],
      }),
    );
    // Every kind present has an executor: this isolates the conditional-routing failure specifically.
    const registry = createTestRegistry(literalPatchExecutor, finalOutputExecutor);
    const failure = runPreflight(plan, registry);
    expect(failure?.code).toBe("CONDITIONAL_ROUTING_UNSUPPORTED");
    expect(failure?.nodeId).toBe("intake");
  });

  it("rejects a plan whose entryNodeId does not resolve in nodesById (corrupted plan defense)", () => {
    const corrupted = { ...minimalPlan, entryNodeId: "does-not-exist" };
    const registry = createTestRegistry(literalPatchExecutor, finalOutputExecutor);
    const failure = runPreflight(corrupted, registry);
    expect(failure?.code).toBe("RUNTIME_PREFLIGHT_FAILED");
  });

  it("rejects a plan where a non-terminal node has zero outgoing edges (corrupted plan defense)", () => {
    const corrupted = { ...minimalPlan, outgoingEdgesByNode: { ...minimalPlan.outgoingEdgesByNode, intake: [] } };
    const registry = createTestRegistry(literalPatchExecutor, finalOutputExecutor);
    const failure = runPreflight(corrupted, registry);
    expect(failure?.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(failure?.nodeId).toBe("intake");
  });

  it("rejects a plan where a terminal node unexpectedly has an outgoing edge (corrupted plan defense)", () => {
    const corrupted = {
      ...minimalPlan,
      outgoingEdgesByNode: { ...minimalPlan.outgoingEdgesByNode, final: [{ sourceNodeId: "final", targetNodeId: "intake" }] },
    };
    const registry = createTestRegistry(literalPatchExecutor, finalOutputExecutor);
    const failure = runPreflight(corrupted, registry);
    expect(failure?.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(failure?.nodeId).toBe("final");
  });
});
