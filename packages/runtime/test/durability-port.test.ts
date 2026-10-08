import { describe, expect, it } from "vitest";
import type { RunState } from "@aao/contracts";
import { finalOutputExecutor } from "../src/default-registry.js";
import { executeWorkflow, resumeWorkflow } from "../src/engine.js";
import { validateExecutionAgainstPlan } from "../src/execution-records.js";
import { isLegalNodeTransition } from "../src/node-lifecycle.js";
import { createNodeRegistry } from "../src/registry.js";
import type { NodeAttemptIntent, NodeAttemptOutcome, NodeExecutor, RuntimeDurabilityHooks, RuntimeExecutionState } from "../src/types.js";
import { buildWorkflow, compileOrThrow } from "./fixtures.js";

const plan = compileOrThrow(
  buildWorkflow({
    entryNodeId: "a",
    nodes: [
      { id: "a", kind: "deterministic", config: {} },
      { id: "b", kind: "model", config: {} },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [
      { sourceNodeId: "a", targetNodeId: "b" },
      { sourceNodeId: "b", targetNodeId: "final" },
    ],
  }),
);
const runId = "run.port";
const initialState: RunState = { runId, revision: 0, values: {} };

function tickClock() {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, tick++)).toISOString() };
}

function world(script: { b?: Array<NodeAttemptOutcome | "throw"> } = {}) {
  const calls = { a: 0, b: 0 };
  const registry = createNodeRegistry();
  registry.register({ kind: "deterministic", async execute() { calls.a++; return { ok: true, statePatch: { a: calls.a } }; } });
  const bExecutor: NodeExecutor = {
    kind: "model",
    retrySafety: () => "safe",
    async execute() {
      calls.b++;
      const step = script.b?.[calls.b - 1];
      if (step === "throw") throw new Error("secret /etc/passwd");
      if (step?.kind === "failure") return { ok: false, failure: { namespace: "model", code: step.executorFailure?.code ?? "X", category: step.category } };
      return { ok: true, statePatch: { b: calls.b }, output: { b: calls.b } };
    },
  };
  registry.register(bExecutor);
  registry.register(finalOutputExecutor);
  return { registry, calls };
}

/** In-memory durability port recording every call in order; `fail` makes the named hook reject once. */
function recordingHooks(fail?: { hook: keyof RuntimeDurabilityHooks; when?: (args: unknown[]) => boolean }) {
  const log: string[] = [];
  const checkpoints: Array<{ execution: RuntimeExecutionState }> = [];
  const outcomes: Array<{ intent: NodeAttemptIntent; outcome: NodeAttemptOutcome }> = [];
  let cancelled = false;
  let failed = false;
  const maybeFail = (hook: keyof RuntimeDurabilityHooks, args: unknown[]) => {
    if (!failed && fail?.hook === hook && (fail.when?.(args) ?? true)) {
      failed = true;
      throw new Error("disk full at /var/secret");
    }
  };
  const hooks: RuntimeDurabilityHooks = {
    async persistCheckpoint(boundary) {
      maybeFail("persistCheckpoint", [boundary]);
      log.push(`checkpoint:${boundary.snapshot.run.status}:${boundary.snapshot.run.currentNodeId ?? "-"}`);
      checkpoints.push({ execution: boundary.execution });
    },
    async beginAttempt(intent) {
      maybeFail("beginAttempt", [intent]);
      log.push(`begin:${intent.nodeId}:${intent.attempt}${intent.recoveryReplay ? ":replay" : ""}`);
    },
    async recordAttemptOutcome(intent, outcome) {
      maybeFail("recordAttemptOutcome", [intent, outcome]);
      log.push(`outcome:${intent.nodeId}:${intent.attempt}:${outcome.kind}`);
      outcomes.push({ intent, outcome });
    },
    async isCancellationRequested() {
      return cancelled;
    },
  };
  return { hooks, log, checkpoints, outcomes, cancel: () => { cancelled = true; } };
}

describe("Runtime durability port (ADR-019)", () => {
  it("brackets every attempt: checkpoint → intent → executor → outcome → commit → checkpoint", async () => {
    const w = world();
    const port = recordingHooks();
    const result = await executeWorkflow({ runId, plan, registry: w.registry, initialState, options: { clock: tickClock(), durability: port.hooks } });
    expect(result.ok && result.execution.run.status).toBe("COMPLETED");
    expect(port.log).toEqual([
      "checkpoint:RUNNING:a",
      "begin:a:1", "outcome:a:1:success", "checkpoint:RUNNING:b",
      "begin:b:1", "outcome:b:1:success", "checkpoint:RUNNING:final",
      "begin:final:1", "outcome:final:1:success", "checkpoint:COMPLETED:-",
    ]);
    // Persisted outcomes are Runtime-validated values, never raw executor responses.
    expect(port.outcomes[0]!.outcome).toEqual({ kind: "success", statePatch: { a: 1 } });
  });

  it("never invokes the executor when intent cannot be persisted, and reports the last durable boundary", async () => {
    const w = world();
    const port = recordingHooks({ hook: "beginAttempt", when: ([intent]) => (intent as NodeAttemptIntent).nodeId === "b" });
    const result = await executeWorkflow({ runId, plan, registry: w.registry, initialState, options: { clock: tickClock(), durability: port.hooks } });
    expect(!result.ok && result.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(w.calls).toEqual({ a: 1, b: 0 });
    // Not FAILED: the Run is left at its last durable safe boundary (b READY), state unchanged by b.
    expect(result.execution?.run.status).toBe("RUNNING");
    expect(result.execution?.nodeStatusesById.b).toBe("READY");
    expect(result.execution?.state).toEqual({ runId, revision: 1, values: { a: 1 } });
  });

  it("an outcome-persistence failure never commits the executed attempt", async () => {
    const w = world();
    const port = recordingHooks({ hook: "recordAttemptOutcome", when: ([intent]) => (intent as NodeAttemptIntent).nodeId === "b" });
    const result = await executeWorkflow({ runId, plan, registry: w.registry, initialState, options: { clock: tickClock(), durability: port.hooks } });
    expect(!result.ok && result.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    expect(w.calls.b).toBe(1);
    expect(result.execution?.state.revision).toBe(1);
    expect(result.execution?.nodeStatusesById.b).toBe("READY");
  });

  it("COMPLETED is not reported until the terminal checkpoint is persisted", async () => {
    const w = world();
    const port = recordingHooks({ hook: "persistCheckpoint", when: ([boundary]) => (boundary as { snapshot: { run: { status: string } } }).snapshot.run.status === "COMPLETED" });
    const result = await executeWorkflow({ runId, plan, registry: w.registry, initialState, options: { clock: tickClock(), durability: port.hooks } });
    expect(result.ok).toBe(false);
    expect(result.execution?.run.status).toBe("RUNNING");
    expect(result.execution?.nodeStatusesById.final).toBe("READY");
  });

  it("rejects malformed durability hooks before a Run exists", async () => {
    const w = world();
    const result = await executeWorkflow({ runId, plan, registry: w.registry, initialState, options: { durability: { persistCheckpoint: async () => undefined } as never } });
    expect(!result.ok && result.failure.code).toBe("INVALID_RUNTIME_INPUT");
    expect(w.calls).toEqual({ a: 0, b: 0 });
  });

  it("cancels only at a safe boundary: the READY Node becomes CANCELLED and never starts", async () => {
    expect(isLegalNodeTransition("READY", "CANCELLED")).toBe(true);
    const w = world();
    const port = recordingHooks();
    w.registry.get("deterministic")!.execute = async () => { w.calls.a++; port.cancel(); return { ok: true, statePatch: { a: 1 } }; };
    const result = await executeWorkflow({ runId, plan, registry: w.registry, initialState, options: { clock: tickClock(), durability: port.hooks } });
    expect(!result.ok && result.failure.code).toBe("RUN_CANCELLED");
    expect(result.execution?.run.status).toBe("CANCELLED");
    expect(result.execution?.nodeStatusesById).toEqual({ a: "SUCCEEDED", b: "CANCELLED", final: "PENDING" });
    expect(w.calls).toEqual({ a: 1, b: 0 });
    expect(port.log.at(-1)).toBe("checkpoint:CANCELLED:-");
  });
});

describe("resumeWorkflow", () => {
  async function stoppedBeforeB() {
    const w = world();
    const port = recordingHooks({ hook: "beginAttempt", when: ([intent]) => (intent as NodeAttemptIntent).nodeId === "b" });
    const stopped = await executeWorkflow({ runId, plan, registry: w.registry, initialState, options: { clock: tickClock(), durability: port.hooks } });
    return { w, execution: stopped.execution! };
  }

  it("continues a READY boundary through the same loop without re-running completed Nodes or creating a Run", async () => {
    const { w, execution } = await stoppedBeforeB();
    const frozen = JSON.stringify(execution);
    const resumed = await resumeWorkflow({ plan, registry: w.registry, execution, options: { clock: tickClock() } });
    expect(resumed.ok && resumed.execution.run.status).toBe("COMPLETED");
    expect(w.calls).toEqual({ a: 1, b: 1 });
    expect(resumed.execution?.run.createdAt).toBe(execution.run.createdAt);
    expect(resumed.execution?.history.map((record) => record.nodeId)).toEqual(["a", "b", "final"]);
    expect(JSON.stringify(execution)).toBe(frozen);
  });

  it("commits a recorded accepted outcome without invoking the executor, exactly once", async () => {
    const { w, execution } = await stoppedBeforeB();
    const resumed = await resumeWorkflow({ plan, registry: w.registry, execution, recovery: { nodeId: "b", step: execution.step + 1, priorOutcomes: [{ kind: "success", statePatch: { b: "recorded" }, output: { b: "recorded" } }] }, options: { clock: tickClock() } });
    expect(resumed.ok).toBe(true);
    expect(w.calls.b).toBe(0);
    expect(resumed.execution?.state.values).toEqual({ a: 1, b: "recorded" });
    expect(resumed.execution?.state.revision).toBe(2);
    expect(resumed.execution?.history.find((record) => record.nodeId === "b")).toMatchObject({ status: "SUCCEEDED", attemptCount: 1, stateRevisionBefore: 1, stateRevisionAfter: 2 });
  });

  it("resumes attempt accounting from recorded failures and never resets the budget", async () => {
    const { w, execution } = await stoppedBeforeB();
    const transient: NodeAttemptOutcome = { kind: "failure", code: "NODE_EXECUTION_FAILED", category: "TRANSIENT_DEPENDENCY", message: "m", executorFailure: { namespace: "model", code: "BUSY", category: "TRANSIENT_DEPENDENCY" } };
    const port = recordingHooks();
    const resumed = await resumeWorkflow({ plan, registry: w.registry, execution, recovery: { nodeId: "b", step: execution.step + 1, priorOutcomes: [transient, transient] }, options: { clock: tickClock(), durability: port.hooks, reliability: { policiesByNodeId: { b: { maxAttempts: 3 } } } } });
    expect(resumed.ok).toBe(true);
    expect(w.calls.b).toBe(1);
    expect(port.log).toContain("begin:b:3");
    expect(resumed.execution?.history.find((record) => record.nodeId === "b")).toMatchObject({ attemptCount: 3, attemptFailures: [{ attempt: 1, causeCode: "BUSY" }, { attempt: 2, causeCode: "BUSY" }] });
    // An exhausted budget recorded before the crash is final: no new attempt.
    const exhausted = await resumeWorkflow({ plan, registry: w.registry, execution, recovery: { nodeId: "b", step: execution.step + 1, priorOutcomes: [transient, transient, transient] }, options: { clock: tickClock(), reliability: { policiesByNodeId: { b: { maxAttempts: 3 } } } } });
    expect(!exhausted.ok && exhausted.failure.code).toBe("NODE_RETRY_EXHAUSTED");
    expect(w.calls.b).toBe(1);
  });

  it("replays an ambiguous attempt under the same attempt number, flagged as a recovery replay", async () => {
    const { w, execution } = await stoppedBeforeB();
    const port = recordingHooks();
    const resumed = await resumeWorkflow({ plan, registry: w.registry, execution, recovery: { nodeId: "b", step: execution.step + 1, priorOutcomes: [], replayAttempt: 1 }, options: { clock: tickClock(), durability: port.hooks } });
    expect(resumed.ok).toBe(true);
    expect(port.log).toContain("begin:b:1:replay");
    expect(w.calls.b).toBe(1);
  });

  it.each([
    ["wrong node", { nodeId: "a", step: 2, priorOutcomes: [] }],
    ["wrong step", { nodeId: "b", step: 5, priorOutcomes: [] }],
    ["accepted outcome not last", { nodeId: "b", step: 2, priorOutcomes: [{ kind: "success" }, { kind: "success" }] }],
    ["replay not next", { nodeId: "b", step: 2, priorOutcomes: [], replayAttempt: 2 }],
    ["recorded wait on a non-approval node", { nodeId: "b", step: 2, priorOutcomes: [{ kind: "wait", wait: { kind: "approval", referenceId: "x", requestFingerprint: "a".repeat(64) } }] }],
    ["failures past a final failure", { nodeId: "b", step: 2, priorOutcomes: [{ kind: "failure", code: "NODE_EXECUTION_FAILED", category: "EXECUTION", message: "m" }, { kind: "failure", code: "NODE_EXECUTION_FAILED", category: "EXECUTION", message: "m" }] }],
  ])("rejects an inconsistent recovery directive (%s) without executing", async (_name, recovery) => {
    const { w, execution } = await stoppedBeforeB();
    const resumed = await resumeWorkflow({ plan, registry: w.registry, execution, recovery: recovery as never, options: { clock: tickClock() } });
    expect(!resumed.ok && resumed.failure.code).toBe("INVALID_RECOVERY_DIRECTIVE");
    expect(w.calls.b).toBe(0);
  });

  it("returns terminal Runs without executing anything", async () => {
    const w = world();
    const completed = await executeWorkflow({ runId, plan, registry: w.registry, initialState, options: { clock: tickClock() } });
    if (!completed.ok) throw new Error("expected completion");
    const again = await resumeWorkflow({ plan, registry: w.registry, execution: completed.execution, options: { clock: tickClock() } });
    expect(again.ok && again.output).toEqual(completed.output);
    expect(w.calls).toEqual({ a: 1, b: 1 });
    const failedWorld = world({ b: ["throw"] });
    const failed = await executeWorkflow({ runId, plan, registry: failedWorld.registry, initialState, options: { clock: tickClock() } });
    const failedAgain = await resumeWorkflow({ plan, registry: failedWorld.registry, execution: failed.execution!, options: { clock: tickClock() } });
    expect(!failedAgain.ok && failedAgain.failure.code).toBe("RUN_ALREADY_TERMINAL");
    expect(failedWorld.calls.b).toBe(1);
  });

  it("rejects corrupted executions: inconsistent history, revision gaps, RUNNING Nodes, foreign plans", async () => {
    const { w, execution } = await stoppedBeforeB();
    expect(validateExecutionAgainstPlan(execution, plan)).toBeUndefined();
    const corruptions: RuntimeExecutionState[] = [
      { ...execution, history: [] },
      { ...execution, state: { ...execution.state, revision: 7 } },
      { ...execution, nodeStatusesById: { ...execution.nodeStatusesById, b: "RUNNING" } },
      { ...execution, history: [{ ...execution.history[0]!, nodeId: "b" }] },
      { ...execution, run: { ...execution.run, workflowId: "other.workflow" } },
    ];
    for (const corrupt of corruptions) {
      const resumed = await resumeWorkflow({ plan, registry: w.registry, execution: corrupt, options: { clock: tickClock() } });
      expect(resumed.ok).toBe(false);
      expect(w.calls.b).toBe(0);
    }
  });
});
