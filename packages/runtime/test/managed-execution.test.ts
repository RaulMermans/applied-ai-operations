import { describe, expect, it } from "vitest";
import type { JsonObject } from "@aao/contracts";
import { executeWorkflow } from "../src/engine.js";
import { finalOutputExecutor } from "../src/default-registry.js";
import { createNodeRegistry } from "../src/registry.js";
import type { NodeExecutor } from "../src/types.js";
import { buildRequest, buildRunState, buildTestClock, buildWorkflow, compileOrThrow, createTestRegistry, minimalPlan } from "./fixtures.js";

describe("managed executeWorkflow — Run + Node lifecycle on success", () => {
  it("walks CREATED -> VALIDATING -> QUEUED -> RUNNING -> COMPLETED, with the entry node walking READY -> RUNNING -> SUCCEEDED and the next node PENDING -> READY -> RUNNING -> SUCCEEDED", async () => {
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
    const clock = buildTestClock("2026-02-01T00:00:00.000Z");
    const result = await executeWorkflow(buildRequest({ runId: "run.lifecycle.success", plan, options: { clock } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Final authoritative Run lifecycle state — COMPLETED is the only
    // status truth exposed; createdAt is stable, updatedAt advanced.
    expect(result.execution.run.status).toBe("COMPLETED");
    expect(result.execution.run.createdAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result.execution.run.updatedAt > result.execution.run.createdAt).toBe(true);
    expect(result.execution.run.currentNodeId).toBeUndefined();

    // Every node ends SUCCEEDED; nothing is left PENDING/READY/RUNNING.
    expect(result.execution.nodeStatusesById).toEqual({ a: "SUCCEEDED", b: "SUCCEEDED", final: "SUCCEEDED" });

    expect(result.execution.history.map((r) => [r.nodeId, r.status])).toEqual([
      ["a", "SUCCEEDED"],
      ["b", "SUCCEEDED"],
      ["final", "SUCCEEDED"],
    ]);

    expect(result.execution.state.values).toEqual({ step: "b" });
    expect(result.latestSnapshot.run.status).toBe("COMPLETED");
    expect(result.latestSnapshot.stateSnapshot.values).toEqual({ step: "b" });
    // The safe-boundary invariant: no returned snapshot ever shows a RUNNING node.
    expect(Object.values(result.latestSnapshot.nodeStatusesById)).not.toContain("RUNNING");
  });
});

describe("managed executeWorkflow — preflight failure lifecycle", () => {
  it("walks CREATED -> VALIDATING -> FAILED, invoking zero executors, with authoritative state unchanged", async () => {
    const executeSpy = { called: false };
    const spyExecutor: NodeExecutor = {
      kind: "deterministic",
      async execute() {
        executeSpy.called = true;
        return { ok: true };
      },
    };
    // "model" has no registered executor -> NODE_EXECUTOR_NOT_FOUND at preflight.
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "reason",
        nodes: [
          { id: "reason", kind: "model", config: {} },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [{ sourceNodeId: "reason", targetNodeId: "final" }],
      }),
    );
    const registry = createNodeRegistry();
    registry.register(spyExecutor);
    registry.register(finalOutputExecutor);

    const initialState = buildRunState("run.lifecycle.preflight-fail", { seed: 1 });
    const result = await executeWorkflow({ runId: "run.lifecycle.preflight-fail", plan, initialState, registry });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.failure.code).toBe("NODE_EXECUTOR_NOT_FOUND");
    expect(executeSpy.called).toBe(false);

    expect(result.execution).toBeDefined();
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.run.currentNodeId).toBeUndefined();
    // No node ever became READY or RUNNING.
    expect(result.execution?.nodeStatusesById).toEqual({ reason: "PENDING", final: "PENDING" });
    expect(result.execution?.state.values).toEqual({ seed: 1 });
    expect(result.execution?.history).toEqual([]);

    expect(result.latestSnapshot).toBeDefined();
    expect(result.latestSnapshot?.run.status).toBe("FAILED");
  });
});

describe("managed executeWorkflow — Node failure lifecycle", () => {
  it("marks the failing node FAILED, the Run FAILED, keeps prior successes and preserves downstream nodes PENDING", async () => {
    const throwingB: NodeExecutor = {
      kind: "deterministic",
      async execute(context) {
        if (context.node.id === "b") throw new Error("boom: should never leak");
        const config = context.node.config as { statePatch?: JsonObject };
        return config.statePatch !== undefined ? { ok: true, statePatch: config.statePatch } : { ok: true };
      },
    };
    const finalSpyCalls: unknown[] = [];
    const registry = createTestRegistry(throwingB, {
      kind: "final_output",
      async execute(context) {
        finalSpyCalls.push(context.step);
        return { ok: true, output: context.state.values };
      },
    });
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "a",
        nodes: [
          { id: "a", kind: "deterministic", config: { statePatch: { a: 1 } } },
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
    const result = await executeWorkflow(buildRequest({ runId: "run.lifecycle.node-fail", plan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.failure.code).toBe("NODE_EXECUTION_FAILED");
    expect(result.failure.nodeId).toBe("b");
    expect(result.failure.message).not.toContain("should never leak");
    expect(finalSpyCalls).toHaveLength(0); // downstream never runs after a failure

    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.run.currentNodeId).toBeUndefined();
    expect(result.execution?.nodeStatusesById).toEqual({ a: "SUCCEEDED", b: "FAILED", c: "PENDING", final: "PENDING" });

    // Only "a"'s accepted patch is reflected; "b" never applied one.
    expect(result.execution?.state.values).toEqual({ a: 1 });
    expect(result.execution?.state.revision).toBe(1);

    const history = result.execution?.history ?? [];
    expect(history.map((r) => [r.nodeId, r.status])).toEqual([
      ["a", "SUCCEEDED"],
      ["b", "FAILED"],
    ]);
    const failedRecord = history[1];
    expect(failedRecord?.stateRevisionBefore).toBe(1);
    expect(failedRecord?.stateRevisionAfter).toBe(1); // unchanged: no patch from a failed node

    expect(result.latestSnapshot?.run.status).toBe("FAILED");
    expect(result.latestSnapshot?.stateSnapshot.values).toEqual({ a: 1 });
    expect(JSON.stringify(result)).not.toContain("should never leak");
  });
});

describe("managed executeWorkflow — invalid Node result lifecycle", () => {
  it("marks the offending node FAILED and the Run FAILED without contaminating authoritative state, for a malformed result shape", async () => {
    const malformed: NodeExecutor = { kind: "deterministic", async execute() { return "not an object" as never; } };
    const registry = createTestRegistry(malformed, finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.lifecycle.invalid-result", plan: minimalPlan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("INVALID_NODE_RESULT");
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById).toEqual({ intake: "FAILED", final: "PENDING" });
    expect(result.execution?.state.revision).toBe(0);
    expect(result.execution?.state.values).toEqual({});
  });

  it("marks the offending node FAILED and the Run FAILED without contaminating authoritative state, for an invalid state patch", async () => {
    const badPatch: NodeExecutor = { kind: "deterministic", async execute() { return { ok: true, statePatch: { when: new Date() } as never }; } };
    const registry = createTestRegistry(badPatch, finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.lifecycle.invalid-patch", plan: minimalPlan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("INVALID_STATE_PATCH");
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.nodeStatusesById.intake).toBe("FAILED");
    expect(result.execution?.state.revision).toBe(0);
  });
});

describe("managed executeWorkflow — determinism of the full managed shape", () => {
  it("produces byte-identical managed results for identical inputs and clock sequence", async () => {
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
    const run = (clockStart: string) =>
      executeWorkflow(
        buildRequest({
          runId: "run.managed-determinism",
          plan,
          initialState: buildRunState("run.managed-determinism", { value: 2 }),
          options: { clock: buildTestClock(clockStart) },
        }),
      );
    const [first, second] = await Promise.all([run("2026-04-01T00:00:00.000Z"), run("2026-04-01T00:00:00.000Z")]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
