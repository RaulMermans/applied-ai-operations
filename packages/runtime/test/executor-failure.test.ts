import { describe, expect, it, vi } from "vitest";
import { executeWorkflow } from "../src/engine.js";
import { finalOutputExecutor } from "../src/default-registry.js";
import { validateSnapshotAgainstPlan } from "../src/execution-snapshot.js";
import { validateNodeExecutionResult } from "../src/node-result-validation.js";
import { buildRunState, buildTestClock, buildWorkflow, compileOrThrow, createTestRegistry, literalPatchExecutor } from "./fixtures.js";
import type { NodeExecutor } from "../src/types.js";

/**
 * The generic safe executor-failure protocol (Sprint 7): an executor may
 * *return* `{ ok: false, failure: { namespace, code } }`. The Runtime keeps
 * its own generic `NODE_EXECUTION_FAILED` and carries the validated pair as
 * opaque subordinate `executorFailure` — it never interprets the namespace.
 * The failing kind here is deliberately `evaluator` with an invented
 * namespace, to prove nothing is special-cased for `model` or `agent`.
 */
const plan = compileOrThrow(
  buildWorkflow({
    entryNodeId: "intake",
    nodes: [
      { id: "intake", kind: "deterministic", config: { statePatch: { seen: true } } },
      { id: "check", kind: "evaluator", config: {} },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [
      { sourceNodeId: "intake", targetNodeId: "check" },
      { sourceNodeId: "check", targetNodeId: "final" },
    ],
  }),
);

function run(checkExecutor: NodeExecutor) {
  const finalSpy = vi.fn(finalOutputExecutor.execute);
  const registry = createTestRegistry(literalPatchExecutor, checkExecutor, { kind: "final_output", execute: finalSpy });
  const initialState = buildRunState("run.executor-failure", { input: "x" });
  return {
    finalSpy,
    initialState,
    result: executeWorkflow({ runId: "run.executor-failure", plan, initialState, registry, options: { clock: buildTestClock() } }),
  };
}

describe("safe executor-failure protocol — Runtime handling", () => {
  it("an explicit safe failure → node FAILED, Run FAILED, downstream PENDING, no patch, NODE_EXECUTION_FAILED + executorFailure", async () => {
    const { result: pending, finalSpy, initialState } = run({
      kind: "evaluator",
      async execute() {
        return { ok: false, failure: { namespace: "quality_gate", code: "THRESHOLD_NOT_MET" } };
      },
    });
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      code: "NODE_EXECUTION_FAILED",
      message: 'Node "check" (kind "evaluator") reported an executor failure.',
      nodeId: "check",
      step: 2,
      executorFailure: { namespace: "quality_gate", code: "THRESHOLD_NOT_MET" },
    });
    expect(result.execution?.run.status).toBe("FAILED");
    expect(result.execution?.run.currentNodeId).toBeUndefined();
    expect(result.execution?.nodeStatusesById).toEqual({ intake: "SUCCEEDED", check: "FAILED", final: "PENDING" });
    // Only intake's patch was applied; the failing node contributed nothing.
    expect(result.execution?.state).toEqual({ runId: "run.executor-failure", revision: 1, values: { input: "x", seen: true } });
    expect(result.execution?.history.at(-1)).toEqual({ nodeId: "check", kind: "evaluator", step: 2, status: "FAILED", stateRevisionBefore: 1, stateRevisionAfter: 1 });
    expect(finalSpy).not.toHaveBeenCalled();
    expect(initialState.values).toEqual({ input: "x" });
    expect(result.latestSnapshot?.stateSnapshot.revision).toBe(1);
    expect(validateSnapshotAgainstPlan(result.latestSnapshot, plan)).toBeUndefined();
  });

  it("the failure (including executorFailure) survives a JSON round trip unchanged", async () => {
    const result = await run({
      kind: "evaluator",
      async execute() {
        return { ok: false, failure: { namespace: "agent", code: "MAX_AGENT_ITERATIONS_EXCEEDED" } };
      },
    }).result;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.parse(JSON.stringify(result.failure))).toEqual(result.failure);
    expect(JSON.parse(JSON.stringify(result.latestSnapshot))).toEqual(result.latestSnapshot);
  });

  it.each([
    ["an extra message field", { ok: false, failure: { namespace: "model", code: "MODEL_ROUTE_NOT_FOUND" }, message: "sk-live-SECRET" }],
    ["a nested extra field inside failure", { ok: false, failure: { namespace: "model", code: "MODEL_ROUTE_NOT_FOUND", details: { url: "https://api.example.com?key=SECRET" } } }],
    ["a raw Error as the failure", { ok: false, failure: new Error("SECRET stack") }],
    ["a free-text code", { ok: false, failure: { namespace: "model", code: "provider said: SECRET" } }],
    ["an uppercase namespace", { ok: false, failure: { namespace: "Model", code: "MODEL_ROUTE_NOT_FOUND" } }],
    ["an unbounded code", { ok: false, failure: { namespace: "model", code: `A${"B".repeat(64)}` } }],
    ["a statePatch smuggled alongside a failure", { ok: false, failure: { namespace: "model", code: "X" }, statePatch: { hijacked: true } }],
    ["a missing failure", { ok: false }],
    ["a legacy result with no ok discriminant", { statePatch: { legacy: true } }],
  ])("rejects %s as INVALID_NODE_RESULT, with no executorFailure and no secret", async (_label, raw) => {
    const result = await run({ kind: "evaluator", execute: async () => raw as never }).result;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("INVALID_NODE_RESULT");
    expect(result.failure.executorFailure).toBeUndefined();
    expect(result.execution?.nodeStatusesById).toEqual({ intake: "SUCCEEDED", check: "FAILED", final: "PENDING" });
    expect(result.execution?.state.values).not.toHaveProperty("hijacked");
    expect(result.execution?.state.values).not.toHaveProperty("legacy");
    expect(JSON.stringify(result)).not.toMatch(/SECRET|example\.com/);
  });

  it("a thrown executor stays generic: NODE_EXECUTION_FAILED with no executorFailure and no exception details", async () => {
    class ProviderError extends Error {
      code = "MODEL_ROUTE_NOT_FOUND";
      failure = { namespace: "model", code: "MODEL_ROUTE_NOT_FOUND" };
    }
    const result = await run({
      kind: "evaluator",
      async execute() {
        throw new ProviderError("sk-live-SECRET MODEL_ROUTE_NOT_FOUND at https://api.example.com");
      },
    }).result;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ code: "NODE_EXECUTION_FAILED", message: 'Node "check" (kind "evaluator") threw during execution.', nodeId: "check", step: 2 });
    expect(result.failure).not.toHaveProperty("executorFailure");
    // Nothing is inferred from the exception, even when it *looks* like a structured failure.
    expect(JSON.stringify(result)).not.toMatch(/SECRET|example\.com|MODEL_ROUTE_NOT_FOUND/);
  });
});

describe("validateNodeExecutionResult — executor failures", () => {
  it("accepts a bounded { ok: false, failure: { namespace, code } } and returns a fresh copy", () => {
    const failure = { namespace: "model", code: "MODEL_ROUTE_NOT_FOUND" };
    const validated = validateNodeExecutionResult({ ok: false, failure });
    expect(validated).toEqual({ ok: true, result: { ok: false, failure: { namespace: "model", code: "MODEL_ROUTE_NOT_FOUND" } } });
    if (validated.ok && !validated.result.ok) expect(validated.result.failure).not.toBe(failure);
  });

  it("rejects ok values other than true/false", () => {
    expect(validateNodeExecutionResult({ ok: "false", failure: { namespace: "model", code: "X" } }).ok).toBe(false);
    expect(validateNodeExecutionResult({ ok: 1 }).ok).toBe(false);
  });
});
