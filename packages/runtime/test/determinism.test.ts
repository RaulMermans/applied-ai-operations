import { describe, expect, it } from "vitest";
import { executeWorkflow } from "../src/engine.js";
import { buildRequest, buildRunState, buildWorkflow, compileOrThrow } from "./fixtures.js";

describe("Runtime determinism", () => {
  it("produces equivalent results for identical plan + state + registry-behavior + options", async () => {
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "a",
        nodes: [
          { id: "a", kind: "deterministic", config: { statePatch: { value: 4 } } },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [{ sourceNodeId: "a", targetNodeId: "final" }],
      }),
    );
    const first = await executeWorkflow(buildRequest({ runId: "run.determinism", plan, initialState: buildRunState("run.determinism", { value: 2 }) }));
    const second = await executeWorkflow(buildRequest({ runId: "run.determinism", plan, initialState: buildRunState("run.determinism", { value: 2 }) }));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("introduces no timestamp into the run result", async () => {
    const result = await executeWorkflow(buildRequest({ runId: "run.no-timestamp" }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("never generates a runId itself — the result always echoes back the caller-provided one", async () => {
    const result = await executeWorkflow(buildRequest({ runId: "caller.chosen.id" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.runId).toBe("caller.chosen.id");
  });
});
