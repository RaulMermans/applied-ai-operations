import { describe, expect, it } from "vitest";
import { executeWorkflow } from "../src/engine.js";
import { buildRequest, buildWorkflow, compileOrThrow, createTestRegistry, minimalPlan } from "./fixtures.js";
import type { NodeExecutor } from "../src/types.js";

describe("Runtime result serialization", () => {
  it("round-trips a successful WorkflowExecutionResult through JSON.stringify -> JSON.parse", async () => {
    const result = await executeWorkflow(buildRequest({ runId: "run.serialize-ok", plan: minimalPlan }));
    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
  });

  it("round-trips a failed WorkflowExecutionResult through JSON.stringify -> JSON.parse", async () => {
    const throwing: NodeExecutor = {
      kind: "deterministic",
      async execute() {
        throw new Error("boom");
      },
    };
    const registry = createTestRegistry(throwing, { kind: "final_output", async execute() { return {}; } });
    const result = await executeWorkflow(buildRequest({ runId: "run.serialize-fail", plan: minimalPlan, registry }));
    expect(result.ok).toBe(false);
    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
  });

  it("round-trips the plan/initialState/options portion of a request (registry is a runtime dependency, not serialized state)", () => {
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "intake",
        nodes: [
          { id: "intake", kind: "deterministic", config: {} },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [{ sourceNodeId: "intake", targetNodeId: "final" }],
      }),
    );
    const request = buildRequest({ runId: "run.serialize-req", plan, options: { maxSteps: 4 } });
    const serializable = { runId: request.runId, plan: request.plan, initialState: request.initialState, options: request.options };
    const roundTripped = JSON.parse(JSON.stringify(serializable));
    expect(roundTripped).toEqual(serializable);
  });

  it("never embeds a live function inside a Runtime result", async () => {
    const result = await executeWorkflow(buildRequest({ runId: "run.check-no-embedded-fn", plan: minimalPlan }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/function\s*\(|=>/);
  });
});
