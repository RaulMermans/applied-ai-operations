import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileDurabilityStore, planFingerprint, type DurableCheckpoint, type DurableOperation } from "../src/index.js";
import { clockAt, compile, createEffects, crashingStore, initial, linearYaml, tempRoot, world } from "./fixtures.js";

const runId = "run.linear";

function runDir(root: string): string {
  return join(root, "runs", readdirSync(join(root, "runs")).find((name) => !name.startsWith(".tmp-"))!);
}

describe("plan fingerprint", () => {
  it("is deterministic canonical SHA-256 over the behaviorally relevant plan", () => {
    const plan = compile(linearYaml);
    expect(planFingerprint(plan)).toMatch(/^[a-f0-9]{64}$/);
    expect(planFingerprint(JSON.parse(JSON.stringify(plan)))).toBe(planFingerprint(plan));
    expect(planFingerprint(compile(linearYaml.replace("name: Durable linear", "name: Renamed for humans")))).toBe(planFingerprint(plan));
    expect(planFingerprint(compile(linearYaml.replace("  - id: c\n    kind: deterministic\n    config: {}", "  - id: c\n    kind: deterministic\n    config: { mode: strict }")))).not.toBe(planFingerprint(plan));
  });
});

describe("plan compatibility on resume", () => {
  async function stopped(root: string) {
    const effects = createEffects();
    const store = crashingStore(createFileDurabilityStore({ root }), "beginOperation", (operation: DurableOperation) => operation.nodeId === "b");
    const first = await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store }).host.execute({ runId, initialState: initial(runId) });
    expect(!first.ok && first.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    return effects;
  }

  it("resumes with the same plan", async () => {
    const root = tempRoot();
    const effects = await stopped(root);
    const resumed = await world({ yaml: linearYaml, root, effects, clock: clockAt(100) }).host.resume(runId);
    expect(resumed.ok && resumed.execution.run.status).toBe("COMPLETED");
  });

  it.each([
    ["a different workflow id", linearYaml.replace("id: durable.linear", "id: durable.other")],
    ["a different workflow version", linearYaml.replace('version: "1.0.0"', 'version: "1.0.1"')],
    ["the same version with a changed plan", linearYaml.replace("  - id: c\n    kind: deterministic\n    config: {}", "  - id: c\n    kind: deterministic\n    config: { mode: changed }")],
  ])("refuses %s with DURABILITY_PLAN_MISMATCH and executes nothing", async (_name, yaml) => {
    const root = tempRoot();
    const effects = await stopped(root);
    const before = { ...effects.executions };
    const resumed = await world({ yaml, root, effects, clock: clockAt(100) }).host.resume(runId);
    expect(!resumed.ok && resumed.failure.code).toBe("DURABILITY_PLAN_MISMATCH");
    expect(effects.executions).toEqual(before);
  });
});

describe("write-ahead ordering", () => {
  it("the executor runs only after its STARTED intent is on disk, and its outcome is durable before the next checkpoint", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const w = world({ yaml: linearYaml, root, effects, clock: clockAt(0) });
    const observed: string[] = [];
    const deterministic = w.registry.get("deterministic")!;
    const execute = deterministic.execute.bind(deterministic);
    deterministic.execute = async (context) => {
      // An independent store instance reads only what is durably on disk.
      const disk = createFileDurabilityStore({ root });
      const operation = (await disk.getOperationsForRun(runId)).find((entry) => entry.step === context.step);
      const checkpoint = await disk.getLatestCheckpoint(runId);
      observed.push(`${context.node.id}:${operation?.status}:${checkpoint?.executionSnapshot.run.currentNodeId}`);
      return execute(context);
    };
    const result = await w.host.execute({ runId, initialState: initial(runId) });
    expect(result.ok).toBe(true);
    expect(observed).toEqual(["a:STARTED:a", "b:STARTED:b", "c:STARTED:c"]);
    const operations = await createFileDurabilityStore({ root }).getOperationsForRun(runId);
    expect(operations.every((operation) => operation.status === "OUTCOME_RECORDED")).toBe(true);
  });
});

describe("crash windows", () => {
  it("A — intent cannot be persisted: zero executor calls, nothing advances; restart runs the Node once", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const store = crashingStore(createFileDurabilityStore({ root }), "beginOperation", (operation: DurableOperation) => operation.nodeId === "b");
    const first = await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store }).host.execute({ runId, initialState: initial(runId) });
    expect(!first.ok && first.failure).toMatchObject({ code: "DURABILITY_PERSISTENCE_FAILED", details: { durabilityCode: "DURABILITY_IO_FAILED" } });
    expect(effects.executions).toEqual({ a: 1 });
    expect(first.execution?.state).toEqual({ runId, revision: 1, values: { a: 1 } });
    expect(first.execution?.nodeStatusesById.b).toBe("READY");
    const second = world({ yaml: linearYaml, root, effects, clock: clockAt(100) });
    const view = await second.host.getRun(runId);
    expect(view?.operations.map((operation) => operation.nodeId)).toEqual(["a"]);
    const resumed = await second.host.resume(runId);
    expect(resumed.ok && resumed.execution.run.status).toBe("COMPLETED");
    expect(effects.executions).toEqual({ a: 1, b: 1, c: 1 });
  });

  it("completed Nodes never replay: A succeeded, crash entering B, restart → A executions remain 1", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const store = crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", (_runId: string, operationId: string) => operationId === "op.s2.a1");
    await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store }).host.execute({ runId, initialState: initial(runId) });
    expect(effects.executions).toEqual({ a: 1, b: 1 });
    const resumed = await world({ yaml: linearYaml, root, effects, clock: clockAt(100) }).host.resume(runId);
    expect(resumed.ok).toBe(true);
    // b was recovery-safe and replayed once; a was never re-executed.
    expect(effects.executions).toEqual({ a: 1, b: 2, c: 1 });
    expect(resumed.ok && resumed.execution.state.values).toEqual({ a: 1, b: 2, c: 1 });
    expect(resumed.ok && resumed.execution.state.revision).toBe(3);
  });

  it("B — outcome lost, recovery-unsafe Node: DURABILITY_UNSAFE_REPLAY, zero replay, no downstream work, durable truth untouched", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const store = crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", (_runId: string, operationId: string) => operationId === "op.s2.a1");
    const first = await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store, deterministicRecoverySafe: false }).host.execute({ runId, initialState: initial(runId) });
    expect(!first.ok && first.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    expect(first.execution?.nodeStatusesById.b).toBe("READY");
    for (const start of [100, 200]) {
      const resumed = await world({ yaml: linearYaml, root, effects, clock: clockAt(start), deterministicRecoverySafe: false }).host.resume(runId);
      expect(!resumed.ok && resumed.failure).toMatchObject({ code: "DURABILITY_UNSAFE_REPLAY", operationId: "op.s2.a1" });
    }
    expect(effects.executions).toEqual({ a: 1, b: 1 });
    const view = await world({ yaml: linearYaml, root, effects, clock: clockAt(300) }).host.getRun(runId);
    expect(view?.status).toBe("RUNNING");
    expect(view?.operations.at(-1)).toMatchObject({ operationId: "op.s2.a1", status: "STARTED", recoveryReplayCount: 0 });
  });

  it("B — outcome lost, recovery-safe Node: one bounded replay of the same attempt; a second crash fails closed", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const crash = (_runId: string, operationId: string) => operationId === "op.s2.a1";
    await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store: crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", crash) }).host.execute({ runId, initialState: initial(runId) });
    // The replay itself crashes before its outcome is recorded.
    const replayed = await world({ yaml: linearYaml, root, effects, clock: clockAt(100), store: crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", crash) }).host.resume(runId);
    expect(!replayed.ok && replayed.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    expect(effects.executions.b).toBe(2);
    const third = world({ yaml: linearYaml, root, effects, clock: clockAt(200) });
    expect((await third.host.getRun(runId))?.operations.at(-1)).toMatchObject({ operationId: "op.s2.a1", attempt: 1, recoveryReplayCount: 1, status: "STARTED" });
    const exhausted = await third.host.resume(runId);
    expect(!exhausted.ok && exhausted.failure.code).toBe("DURABILITY_RECOVERY_REPLAY_EXHAUSTED");
    expect(effects.executions).toEqual({ a: 1, b: 2 });
  });

  it("C — outcome durable, checkpoint lost: the executor is NOT called again; the recorded patch commits exactly once", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const store = crashingStore(createFileDurabilityStore({ root }), "writeCheckpoint", (checkpoint: DurableCheckpoint) => checkpoint.sequence === 2);
    const first = await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store }).host.execute({ runId, initialState: initial(runId) });
    expect(!first.ok && first.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    expect(effects.executions).toEqual({ a: 1, b: 1 });
    expect(first.execution?.state.revision).toBe(1);
    const second = world({ yaml: linearYaml, root, effects, clock: clockAt(100) });
    const before = await second.host.getRun(runId);
    expect(before?.checkpoint.sequence).toBe(1);
    expect(before?.operations.at(-1)).toMatchObject({ nodeId: "b", status: "OUTCOME_RECORDED", outcome: { kind: "success", statePatch: { b: 1 } } });
    const resumed = await second.host.resume(runId);
    expect(resumed.ok).toBe(true);
    expect(effects.executions).toEqual({ a: 1, b: 1, c: 1 });
    if (!resumed.ok) return;
    expect(resumed.execution.state).toEqual({ runId, revision: 3, values: { a: 1, b: 1, c: 1 } });
    expect(resumed.execution.history.find((record) => record.nodeId === "b")).toMatchObject({ status: "SUCCEEDED", stateRevisionBefore: 1, stateRevisionAfter: 2, attemptCount: 1 });
    expect(resumed.execution.nodeStatusesById.b).toBe("SUCCEEDED");
    // Sequence 2 — the lost boundary — is written by recovery: c READY (2), final READY (3), COMPLETED (4).
    const checkpoints = readdirSync(join(runDir(root), "checkpoints"));
    expect(checkpoints).toEqual(["000000.json", "000001.json", "000002.json", "000003.json", "000004.json"]);
  });

  it("D — after a checkpoint: restart continues from it with nothing re-executed", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const store = crashingStore(createFileDurabilityStore({ root }), "beginOperation", (operation: DurableOperation) => operation.nodeId === "c");
    await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store }).host.execute({ runId, initialState: initial(runId) });
    const resumed = await world({ yaml: linearYaml, root, effects, clock: clockAt(100) }).host.resume(runId);
    expect(resumed.ok && resumed.execution.history.map((record) => record.nodeId)).toEqual(["a", "b", "c", "final"]);
    expect(effects.executions).toEqual({ a: 1, b: 1, c: 1 });
    expect(resumed.ok && resumed.execution.run.createdAt).toBe("2026-10-08T12:00:00.000Z");
  });
});

describe("durable retry accounting", () => {
  const policy = { policiesByNodeId: { b: { maxAttempts: 3 } } };

  it("a persisted transient failure resumes at attempt 2 after restart; history reports attemptCount 2", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const failures = { b: [{ code: "BUSY", category: "TRANSIENT_DEPENDENCY" as const }] };
    // Process A: attempt 1 fails transiently and is recorded; the process dies before attempt 2 begins.
    const store = crashingStore(createFileDurabilityStore({ root }), "beginOperation", (operation: DurableOperation) => operation.operationId === "op.s2.a2");
    const first = await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store, reliability: policy, deterministicFailures: failures }).host.execute({ runId, initialState: initial(runId) });
    expect(!first.ok && first.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    expect(effects.executions.b).toBe(1);
    const resumed = await world({ yaml: linearYaml, root, effects, clock: clockAt(100), reliability: policy, deterministicFailures: failures }).host.resume(runId);
    expect(resumed.ok && resumed.execution.run.status).toBe("COMPLETED");
    expect(effects.executions.b).toBe(2);
    if (!resumed.ok) return;
    const record = resumed.execution.history.find((entry) => entry.nodeId === "b")!;
    expect(record).toMatchObject({ attemptCount: 2, attemptFailures: [{ attempt: 1, category: "TRANSIENT_DEPENDENCY", causeCode: "BUSY" }], stateRevisionBefore: 1, stateRevisionAfter: 2 });
    const operations = (await createFileDurabilityStore({ root }).getOperationsForRun(runId)).filter((operation) => operation.nodeId === "b");
    expect(operations.map((operation) => [operation.attempt, operation.recoveryReplayCount, operation.outcome?.kind])).toEqual([[1, 0, "failure"], [2, 0, "success"]]);
  });

  it("restart never resets maxAttempts: two recorded failures leave exactly one attempt", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const failures = { b: [{ code: "BUSY", category: "TRANSIENT_DEPENDENCY" as const }, { code: "BUSY", category: "TRANSIENT_DEPENDENCY" as const }, { code: "BUSY", category: "TRANSIENT_DEPENDENCY" as const }] };
    const store = crashingStore(createFileDurabilityStore({ root }), "beginOperation", (operation: DurableOperation) => operation.operationId === "op.s2.a3");
    await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store, reliability: policy, deterministicFailures: failures }).host.execute({ runId, initialState: initial(runId) });
    expect(effects.executions.b).toBe(2);
    const resumed = await world({ yaml: linearYaml, root, effects, clock: clockAt(100), reliability: policy, deterministicFailures: failures }).host.resume(runId);
    expect(!resumed.ok && resumed.failure).toMatchObject({ code: "NODE_RETRY_EXHAUSTED", attempt: 3, maxAttempts: 3 });
    expect(effects.executions.b).toBe(3);
    expect(resumed.execution?.state.revision).toBe(1);
    // The terminal failure is durable evidence: a later resume executes nothing and returns it.
    const again = await world({ yaml: linearYaml, root, effects, clock: clockAt(200), reliability: policy }).host.resume(runId);
    expect(!again.ok && again.failure.code).toBe("NODE_RETRY_EXHAUSTED");
    expect(effects.executions.b).toBe(3);
  });

  it("a crash replay is not a fresh logical attempt: it reuses attempt numbering and leaves the retry budget intact", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const failures = { b: [{ code: "BUSY", category: "TRANSIENT_DEPENDENCY" as const }] };
    const store = crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", (_runId: string, operationId: string) => operationId === "op.s2.a2");
    await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store, reliability: policy, deterministicFailures: failures }).host.execute({ runId, initialState: initial(runId) });
    const resumed = await world({ yaml: linearYaml, root, effects, clock: clockAt(100), reliability: policy }).host.resume(runId);
    expect(resumed.ok).toBe(true);
    const operations = (await createFileDurabilityStore({ root }).getOperationsForRun(runId)).filter((operation) => operation.nodeId === "b");
    expect(operations.map((operation) => [operation.attempt, operation.recoveryReplayCount])).toEqual([[1, 0], [2, 1]]);
    expect(resumed.ok && resumed.execution.history.find((entry) => entry.nodeId === "b")?.attemptCount).toBe(2);
  });
});

describe("terminal, duplicate, busy, and cancelled Runs", () => {
  it("a COMPLETED Run resumes as-is: zero executor calls, same Run, state, and output", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const done = await world({ yaml: linearYaml, root, effects, clock: clockAt(0) }).host.execute({ runId, initialState: initial(runId) });
    if (!done.ok) throw new Error("expected completion");
    const before = { ...effects.executions };
    const again = await world({ yaml: linearYaml, root, effects, clock: clockAt(100) }).host.resume(runId);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(effects.executions).toEqual(before);
    expect(again.execution).toEqual(done.execution);
    expect(again.output).toEqual(done.output);
  });

  it("a FAILED Run resumes with its persisted failure and executes nothing", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const failures = { b: [{ code: "BROKEN", category: "EXECUTION" as const }] };
    const failed = await world({ yaml: linearYaml, root, effects, clock: clockAt(0), deterministicFailures: failures }).host.execute({ runId, initialState: initial(runId) });
    expect(!failed.ok && failed.failure.code).toBe("NODE_EXECUTION_FAILED");
    const again = await world({ yaml: linearYaml, root, effects, clock: clockAt(100) }).host.resume(runId);
    expect(!again.ok && again.failure).toEqual(!failed.ok && failed.failure);
    expect(again.execution?.run.status).toBe("FAILED");
    expect(effects.executions).toEqual({ a: 1, b: 1 });
  });

  it("a repeated execute of an existing runId never runs the entry Node again", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const w = world({ yaml: linearYaml, root, effects, clock: clockAt(0) });
    await w.host.execute({ runId, initialState: initial(runId) });
    const again = await world({ yaml: linearYaml, root, effects, clock: clockAt(100) }).host.execute({ runId, initialState: initial(runId) });
    expect(!again.ok && again.failure.code).toBe("DURABLE_RUN_ALREADY_EXISTS");
    expect(effects.executions.a).toBe(1);
  });

  it("one host never executes the same Run concurrently", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const w = world({ yaml: linearYaml, root, effects, clock: clockAt(0) });
    const [first, second] = await Promise.all([w.host.execute({ runId, initialState: initial(runId) }), w.host.execute({ runId, initialState: initial(runId) })]);
    expect(first.ok).toBe(true);
    expect(!second.ok && second.failure.code).toBe("DURABLE_RUN_BUSY");
    expect(effects.executions.a).toBe(1);
  });

  it("cancellation persists, applies at the next safe boundary, survives restart, and no later Node executes", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const store = crashingStore(createFileDurabilityStore({ root }), "beginOperation", (operation: DurableOperation) => operation.nodeId === "b");
    const first = world({ yaml: linearYaml, root, effects, clock: clockAt(0), store });
    await first.host.execute({ runId, initialState: initial(runId) });
    const requested = await first.host.requestCancellation(runId);
    expect(requested.ok).toBe(true);
    const cancelled = await world({ yaml: linearYaml, root, effects, clock: clockAt(100) }).host.resume(runId);
    expect(!cancelled.ok && cancelled.failure.code).toBe("RUN_CANCELLED");
    expect(cancelled.execution?.run.status).toBe("CANCELLED");
    expect(cancelled.execution?.nodeStatusesById).toEqual({ a: "SUCCEEDED", b: "CANCELLED", c: "PENDING", final: "PENDING" });
    const again = await world({ yaml: linearYaml, root, effects, clock: clockAt(200) }).host.resume(runId);
    expect(!again.ok && again.failure.code).toBe("RUN_CANCELLED");
    expect(again.execution?.run.status).toBe("CANCELLED");
    expect(effects.executions).toEqual({ a: 1 });
  });

  it("cancellation requested mid-Run stops future Nodes but does not reverse the completed one", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const w = world({ yaml: linearYaml, root, effects, clock: clockAt(0) });
    const deterministic = w.registry.get("deterministic")!;
    const execute = deterministic.execute.bind(deterministic);
    deterministic.execute = async (context) => {
      const result = await execute(context);
      if (context.node.id === "a") await w.host.requestCancellation(runId);
      return result;
    };
    const result = await w.host.execute({ runId, initialState: initial(runId) });
    expect(!result.ok && result.failure.code).toBe("RUN_CANCELLED");
    expect(result.execution?.state.values).toEqual({ a: 1 });
    expect(effects.executions).toEqual({ a: 1 });
  });
});

describe("corrupt durable state fails closed", () => {
  async function crashedAtB(root: string) {
    const effects = createEffects();
    const store = crashingStore(createFileDurabilityStore({ root }), "writeCheckpoint", (checkpoint: DurableCheckpoint) => checkpoint.sequence === 2);
    await world({ yaml: linearYaml, root, effects, clock: clockAt(0), store }).host.execute({ runId, initialState: initial(runId) });
    return effects;
  }

  function rewriteOperation(root: string, name: string, change: (operation: Record<string, unknown>) => Record<string, unknown>) {
    const path = join(runDir(root), "operations", name);
    writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8")))));
  }

  it.each([
    ["an operation pointing at the wrong Node", (operation: Record<string, unknown>) => ({ ...operation, nodeId: "c" })],
    ["a state revision mismatch", (operation: Record<string, unknown>) => ({ ...operation, stateRevision: 5 })],
    ["an operation for another Run", (operation: Record<string, unknown>) => ({ ...operation, runId: "run.other" })],
    ["a raw executor payload as outcome", (operation: Record<string, unknown>) => ({ ...operation, outcome: { ok: true, output: { stack: "x" } } })],
  ])("%s", async (_name, change) => {
    const root = tempRoot();
    const effects = await crashedAtB(root);
    rewriteOperation(root, "s000002-a1.json", change);
    const before = { ...effects.executions };
    const resumed = await world({ yaml: linearYaml, root, effects, clock: clockAt(100) }).host.resume(runId);
    expect(!resumed.ok && resumed.failure.code).toBe("DURABILITY_CORRUPT_STATE");
    expect(effects.executions).toEqual(before);
  });

  it("a checkpoint whose history disagrees with its state revision cannot execute", async () => {
    const root = tempRoot();
    const effects = await crashedAtB(root);
    const path = join(runDir(root), "checkpoints", "000001.json");
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    checkpoint.executionSnapshot.stateSnapshot.revision = 4;
    writeFileSync(path, JSON.stringify(checkpoint));
    const resumed = await world({ yaml: linearYaml, root, effects, clock: clockAt(100) }).host.resume(runId);
    expect(!resumed.ok && resumed.failure.code).toBe("DURABILITY_CORRUPT_STATE");
    expect(effects.executions).toEqual({ a: 1, b: 1 });
  });

  it("an unknown Run is reported, not created", async () => {
    const root = tempRoot();
    const resumed = await world({ yaml: linearYaml, root, effects: createEffects(), clock: clockAt(0) }).host.resume("run.never");
    expect(!resumed.ok && resumed.failure.code).toBe("DURABLE_RUN_NOT_FOUND");
    expect(readdirSync(join(root, "runs"))).toEqual([]);
  });
});
