import { describe, expect, it, vi } from "vitest";
import { executeWorkflow } from "../src/engine.js";
import { finalOutputExecutor } from "../src/default-registry.js";
import { buildRequest, buildRunState, buildWorkflow, compileOrThrow, createTestRegistry, literalPatchExecutor, minimalPlan } from "./fixtures.js";
import type { NodeExecutor } from "../src/types.js";

describe("executeWorkflow — safety", () => {
  it("fails with NODE_EXECUTOR_NOT_FOUND before executing anything when an executor is missing", async () => {
    const executeSpy = vi.fn(async () => ({}));
    const registry = createTestRegistry({ kind: "final_output", execute: executeSpy }); // no "deterministic" executor
    const result = await executeWorkflow(buildRequest({ runId: "run.missing", plan: minimalPlan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("NODE_EXECUTOR_NOT_FOUND");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("fails for an unsupported model node with no executor registered", async () => {
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
    const registry = createTestRegistry(finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.model", plan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("NODE_EXECUTOR_NOT_FOUND");
    expect(result.failure.nodeId).toBe("reason");
  });

  it("fails for an unsupported tool node with no executor registered", async () => {
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "act",
        nodes: [
          { id: "act", kind: "tool", config: {} },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [{ sourceNodeId: "act", targetNodeId: "final" }],
      }),
    );
    const registry = createTestRegistry(finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.tool", plan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("NODE_EXECUTOR_NOT_FOUND");
    expect(result.failure.nodeId).toBe("act");
  });

  it("rejects a conditional workflow before executing any node, with zero executors invoked", async () => {
    const intakeExecuteSpy = vi.fn(async () => ({}));
    const branchExecuteSpy = vi.fn(async () => ({}));
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
    const registry = createTestRegistry(
      { kind: "deterministic", execute: intakeExecuteSpy },
      finalOutputExecutor,
    );
    void branchExecuteSpy; // same executor instance handles all "deterministic" nodes; kept for clarity of intent
    const result = await executeWorkflow(buildRequest({ runId: "run.conditional", plan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("CONDITIONAL_ROUTING_UNSUPPORTED");
    expect(intakeExecuteSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed initial state before executing anything", async () => {
    const executeSpy = vi.fn(async () => ({}));
    const registry = createTestRegistry({ kind: "deterministic", execute: executeSpy }, finalOutputExecutor);
    const request = buildRequest({ runId: "run.badstate", plan: minimalPlan, registry, initialState: { revision: -1 } as never });
    const result = await executeWorkflow(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("INVALID_RUNTIME_INPUT");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("rejects a runId mismatch between request and initialState before executing anything", async () => {
    const executeSpy = vi.fn(async () => ({}));
    const registry = createTestRegistry({ kind: "deterministic", execute: executeSpy }, finalOutputExecutor);
    const request = buildRequest({ runId: "run.a", plan: minimalPlan, registry, initialState: buildRunState("run.b") });
    const result = await executeWorkflow(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("INVALID_RUNTIME_INPUT");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("normalizes an executor throwing into NODE_EXECUTION_FAILED without exposing a raw stack trace", async () => {
    const throwingExecutor: NodeExecutor = {
      kind: "deterministic",
      async execute() {
        throw new Error("boom: secret internal detail");
      },
    };
    const finalSpy = vi.fn(async () => ({}));
    const registry = createTestRegistry(throwingExecutor, { kind: "final_output", execute: finalSpy });
    const result = await executeWorkflow(buildRequest({ runId: "run.throw", plan: minimalPlan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("NODE_EXECUTION_FAILED");
    expect(result.failure.nodeId).toBe("intake");
    expect(result.failure.message).not.toMatch(/at Object\.execute|\.ts:\d+:\d+/); // no stack-trace shape
    expect(finalSpy).not.toHaveBeenCalled(); // downstream node never runs after a failure
  });

  it("returns NODE_EXECUTION_FAILED for a non-Error throw without leaking the thrown value verbatim", async () => {
    const throwingExecutor: NodeExecutor = {
      kind: "deterministic",
      async execute() {
        throw { secret: "token-abc" };
      },
    };
    const registry = createTestRegistry(throwingExecutor, finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.throw2", plan: minimalPlan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("NODE_EXECUTION_FAILED");
    expect(result.failure.message).not.toContain("token-abc");
  });

  it("rejects a malformed executor result as INVALID_NODE_RESULT and does not execute downstream nodes", async () => {
    const malformedExecutor: NodeExecutor = { kind: "deterministic", async execute() { return "not an object" as never; } };
    const finalSpy = vi.fn(async () => ({}));
    const registry = createTestRegistry(malformedExecutor, { kind: "final_output", execute: finalSpy });
    const result = await executeWorkflow(buildRequest({ runId: "run.malformed", plan: minimalPlan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("INVALID_NODE_RESULT");
    expect(finalSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid state patch as INVALID_STATE_PATCH", async () => {
    const badPatchExecutor: NodeExecutor = { kind: "deterministic", async execute() { return { statePatch: { when: new Date() } as never }; } };
    const registry = createTestRegistry(badPatchExecutor, finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.badpatch", plan: minimalPlan, registry }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("INVALID_STATE_PATCH");
  });

  it("stops with MAX_STEPS_EXCEEDED rather than looping forever if forced past the ceiling", async () => {
    // Two deterministic nodes ping-ponging via a manually corrupted routing
    // table — the compiler would never produce a cycle, so this exercises
    // the defensive ceiling directly against a hand-built plan.
    const plan = compileOrThrow(
      buildWorkflow({
        entryNodeId: "a",
        nodes: [
          { id: "a", kind: "deterministic", config: {} },
          { id: "b", kind: "deterministic", config: {} },
          { id: "final", kind: "final_output", config: {} },
        ],
        edges: [
          { sourceNodeId: "a", targetNodeId: "b" },
          { sourceNodeId: "b", targetNodeId: "final" },
        ],
      }),
    );
    const cyclicPlan = {
      ...plan,
      outgoingEdgesByNode: {
        ...plan.outgoingEdgesByNode,
        b: [{ sourceNodeId: "b", targetNodeId: "a" }],
      },
      incomingEdgesByNode: {
        ...plan.incomingEdgesByNode,
        a: [{ sourceNodeId: "b", targetNodeId: "a" }],
      },
    };
    const registry = createTestRegistry(literalPatchExecutor, finalOutputExecutor);
    const result = await executeWorkflow(buildRequest({ runId: "run.cyclic", plan: cyclicPlan, registry, options: { maxSteps: 6 } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("MAX_STEPS_EXCEEDED");
  });
});
