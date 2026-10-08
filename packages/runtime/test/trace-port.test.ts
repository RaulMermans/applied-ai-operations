import { describe, expect, it } from "vitest";
import type { RunState, TraceEventDraft } from "@aao/contracts";
import { finalOutputExecutor } from "../src/default-registry.js";
import { executeWorkflow } from "../src/engine.js";
import { createNodeRegistry } from "../src/registry.js";
import type { RuntimeDurabilityHooks, RuntimeTracePort } from "../src/types.js";
import { buildWorkflow, compileOrThrow } from "./fixtures.js";

const plan = compileOrThrow(
  buildWorkflow({
    entryNodeId: "a",
    nodes: [
      { id: "a", kind: "deterministic", config: {} },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "a", targetNodeId: "final" }],
  }),
);
const runId = "run.trace.port";
const initialState: RunState = { runId, revision: 0, values: {} };
const clock = () => { let tick = 0; return { now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, tick++)).toISOString() }; };

function capture(): RuntimeTracePort & { drafts: TraceEventDraft[] } {
  const drafts: TraceEventDraft[] = [];
  return { drafts, async emit(draft) { drafts.push(JSON.parse(JSON.stringify(draft)) as TraceEventDraft); } };
}

function registry() {
  const r = createNodeRegistry();
  r.register({ kind: "deterministic", async execute() { return { ok: true, statePatch: { a: 1 } }; } });
  r.register(finalOutputExecutor);
  return r;
}

function hooks(failCheckpoint?: number): RuntimeDurabilityHooks {
  let checkpoints = 0;
  return {
    async persistCheckpoint() { checkpoints += 1; if (checkpoints === failCheckpoint) throw new Error("disk"); },
    async beginAttempt() {},
    async recordAttemptOutcome() {},
    async isCancellationRequested() { return false; },
  };
}

describe("Runtime trace port (ADR-020)", () => {
  it("reports lifecycle drafts in order with Run identity, and the port result is never read", async () => {
    const port = capture();
    const result = await executeWorkflow({ runId, plan, registry: registry(), initialState, options: { clock: clock(), trace: port } });
    expect(result.ok).toBe(true);
    expect(port.drafts.map((draft) => `${draft.type}${draft.nodeId ? `@${draft.nodeId}` : ""}`)).toEqual(["run.started", "node.started@a", "state.updated@a", "node.completed@a", "route.selected", "node.started@final", "node.completed@final", "run.completed"]);
    for (const draft of port.drafts) expect(draft).toMatchObject({ runId, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version });
  });

  it("reports a commit only after its boundary is durably persisted", async () => {
    const port = capture();
    // Boundary 1 = RUNNING/entry READY; boundary 2 = "a" SUCCEEDED, final READY — make that one fail.
    const result = await executeWorkflow({ runId, plan, registry: registry(), initialState, options: { clock: clock(), trace: port, durability: hooks(2) } });
    expect(!result.ok && result.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    expect(port.drafts.map((draft) => draft.type)).toEqual(["run.started", "node.started", "failure.detected"]);
  });

  it("behaves identically with a port that rejects", async () => {
    const baseline = await executeWorkflow({ runId, plan, registry: registry(), initialState, options: { clock: clock() } });
    const rejecting = await executeWorkflow({ runId, plan, registry: registry(), initialState, options: { clock: clock(), trace: { emit: () => Promise.reject(new Error("trace down")) } } });
    expect(rejecting).toEqual(baseline);
  });
});
