import { describe, expect, it, vi } from "vitest";
import { executeWorkflow } from "../src/engine.js";
import { finalOutputExecutor } from "../src/default-registry.js";
import { buildRequest, buildRunState, buildWorkflow, compileOrThrow, createTestRegistry, minimalPlan } from "./fixtures.js";
import type { NodeExecutor } from "../src/types.js";

describe("executeWorkflow — integrity", () => {
  it("never mutates the caller's CompiledWorkflowPlan", async () => {
    const snapshot = JSON.parse(JSON.stringify(minimalPlan));
    await executeWorkflow(buildRequest({ runId: "run.plan-integrity", plan: minimalPlan }));
    expect(minimalPlan).toEqual(snapshot);
  });

  it("never mutates the caller's initialState object", async () => {
    const initialState = buildRunState("run.state-integrity", { value: 1 });
    const snapshot = JSON.parse(JSON.stringify(initialState));
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "a",
        nodes: [
          { id: "a", kind: "deterministic", config: { statePatch: { value: 2 } } },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [{ sourceNodeId: "a", targetNodeId: "final" }],
      }),
    );
    await executeWorkflow(buildRequest({ runId: "run.state-integrity", plan, initialState }));
    expect(initialState).toEqual(snapshot);
  });

  it("does not let mutating the returned final state reach back into an intermediate history record's snapshot expectations", async () => {
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "a",
        nodes: [
          { id: "a", kind: "deterministic", config: { statePatch: { step: "a" } } },
          { id: "b", kind: "deterministic", config: { statePatch: { step: "b" } } },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [
          { sourceNodeId: "a", targetNodeId: "b" },
          { sourceNodeId: "b", targetNodeId: "final" },
        ],
      }),
    );
    const result = await executeWorkflow(buildRequest({ runId: "run.history-integrity", plan }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution.history.map((record) => [record.stateRevisionBefore, record.stateRevisionAfter])).toEqual([
      [0, 1],
      [1, 2],
      [2, 2],
    ]);
  });

  it("does not execute the final node twice and stops the walk exactly at the terminal node", async () => {
    const finalSpy = vi.fn(async (context: { state: { values: unknown } }) => ({ ok: true as const, output: context.state.values }));
    const deterministicExecutor: NodeExecutor = { kind: "deterministic", async execute() { return { ok: true }; } };
    const registry = createTestRegistry(deterministicExecutor, { kind: "final_output", execute: finalSpy as NodeExecutor["execute"] });
    const result = await executeWorkflow(buildRequest({ runId: "run.final-once", plan: minimalPlan, registry }));
    expect(result.ok).toBe(true);
    expect(finalSpy).toHaveBeenCalledTimes(1);
  });

  it("does not execute a downstream node after an upstream node fails", async () => {
    const throwing: NodeExecutor = {
      kind: "deterministic",
      async execute() {
        throw new Error("fails on purpose");
      },
    };
    const finalSpy = vi.fn(async () => ({ ok: true as const }));
    const registry = createTestRegistry(throwing, { kind: "final_output", execute: finalSpy });
    const result = await executeWorkflow(buildRequest({ runId: "run.no-downstream", plan: minimalPlan, registry }));
    expect(result.ok).toBe(false);
    expect(finalSpy).not.toHaveBeenCalled();
  });

  it("re-clones node config per invocation so an executor cannot corrupt the plan by mutating its context", async () => {
    const mutatingExecutor: NodeExecutor = {
      kind: "deterministic",
      async execute(context) {
        (context.node.config as Record<string, unknown>).mutated = true;
        return { ok: true };
      },
    };
    const registry = createTestRegistry(mutatingExecutor, finalOutputExecutor);
    await executeWorkflow(buildRequest({ runId: "run.no-corrupt", plan: minimalPlan, registry }));
    expect(minimalPlan.nodesById.intake?.config).not.toHaveProperty("mutated");
  });
});
