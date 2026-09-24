import { describe, expect, it } from "vitest";
import { executeWorkflow } from "../src/engine.js";
import { buildRequest, buildRunState, buildTestClock, buildWorkflow, compileOrThrow } from "./fixtures.js";

describe("Runtime determinism", () => {
  it("produces equivalent results for identical plan + state + registry-behavior + options + clock sequence", async () => {
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
    // Two independent deterministic clocks, both starting at the same
    // instant, so both runs mint the identical timestamp sequence — proving
    // determinism does not depend on sharing clock state between calls.
    const first = await executeWorkflow(
      buildRequest({ runId: "run.determinism", plan, initialState: buildRunState("run.determinism", { value: 2 }), options: { clock: buildTestClock() } }),
    );
    const second = await executeWorkflow(
      buildRequest({ runId: "run.determinism", plan, initialState: buildRunState("run.determinism", { value: 2 }), options: { clock: buildTestClock() } }),
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("mints every lifecycle timestamp from the injected clock, never real wall-clock time", async () => {
    const clock = buildTestClock("2026-03-01T00:00:00.000Z");
    const result = await executeWorkflow(buildRequest({ runId: "run.clock-bound", options: { clock } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.run.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(result.execution.run.updatedAt >= result.execution.run.createdAt).toBe(true);
    expect(result.latestSnapshot.stateSnapshot.capturedAt >= result.execution.run.createdAt).toBe(true);
    expect(clock.callCount()).toBeGreaterThan(0);
  });

  it("never generates a runId itself — the result always echoes back the caller-provided one", async () => {
    const result = await executeWorkflow(buildRequest({ runId: "caller.chosen.id" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.run.runId).toBe("caller.chosen.id");
  });
});
