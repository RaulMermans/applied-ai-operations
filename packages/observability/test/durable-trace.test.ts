import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionClass, TraceEvent } from "@aao/contracts";
import { createApprovalEngine, createApprovalNodeExecutor } from "@aao/approval";
import { DurabilityError, createDurableRuntimeHost, createFileDurabilityStore, type DurabilityStore } from "@aao/durability";
import { createNodeRegistry, finalOutputExecutor, type NodeExecutor } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry } from "@aao/tool-runtime";
import { compareTraceWithExecution, createFileTraceStore, createInMemoryTraceStore, createTraceRecorder, validateTrace, type TraceStore } from "../src/index.js";
import { alice, bob, clockAt, compile, governance, ofType, tempRoot, trajectory } from "./fixtures.js";

/** prepare → approval → draft (write_draft Tool) → final */
const yaml = `
schemaVersion: 1
id: trace.durable
version: "1.0.0"
name: Trace durable
entryNodeId: prepare
nodes:
  - id: prepare
    kind: deterministic
    config: {}
  - id: approval
    kind: approval
    config:
      subjectStateKey: proposal
      permissionClasses: [write_draft]
      requiredApproverRoleIds: [manager]
  - id: draft
    kind: tool
    config:
      toolRef: { id: local.draft, version: "1.0.0" }
      inputStateKey: proposal
      resultStateKey: draftResult
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: prepare, targetNodeId: approval }
  - { sourceNodeId: approval, targetNodeId: draft }
  - { sourceNodeId: draft, targetNodeId: final }
`;
const runId = "run.trace.durable";
const plan = compile(yaml);

/** Durable "external world": survives every simulated process. */
function effects() {
  return { toolCalls: 0, toolExecutionIds: [] as string[] };
}

type StoreMethod = Exclude<keyof DurabilityStore, "approvals">;
/** The named durability write rejects once (when `when` matches): a process dying at that instant. */
function crashing(store: DurabilityStore, method: StoreMethod, when: (...args: never[]) => boolean = () => true): DurabilityStore {
  let crashed = false;
  const original = store[method] as (...args: unknown[]) => Promise<unknown>;
  return { ...store, approvals: store.approvals, [method]: (...args: unknown[]) => { if (!crashed && (when as (...a: unknown[]) => boolean)(...args)) { crashed = true; return Promise.reject(new DurabilityError("DURABILITY_IO_FAILED")); } return original(...args); } } as DurabilityStore;
}

/** One simulated process: fresh durability store, approval engine, registries, trace store, recorder, and host over shared roots. */
function processAt(start: number, roots: { durability: string; trace: string }, world: ReturnType<typeof effects>, options: { idempotent?: boolean; store?: (store: DurabilityStore) => DurabilityStore; traceStore?: TraceStore; tracing?: boolean; permission?: PermissionClass } = {}) {
  const base = createFileDurabilityStore({ root: roots.durability });
  const store = options.store ? options.store(base) : base;
  const approvals = createApprovalEngine({ governance: governance(), clock: clockAt(start), repository: store.approvals });
  const tools = createToolRegistry();
  tools.register({
    spec: { schemaVersion: 1, id: "local.draft", version: "1.0.0", name: "Draft", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: [options.permission ?? "write_draft"] },
    ...(options.idempotent === false ? {} : { idempotency: "execution_id" as const }),
    handler: { async execute({ toolExecutionId }) { world.toolCalls += 1; world.toolExecutionIds.push(toolExecutionId); return { ok: true, output: { draft: 1 } }; } },
  });
  const deterministic: NodeExecutor = { kind: "deterministic", recoverySafety: () => "safe", async execute() { return { ok: true, statePatch: { proposal: { action: "draft" } } }; } };
  const registry = createNodeRegistry();
  registry.register(deterministic);
  registry.register(createApprovalNodeExecutor(approvals, () => alice));
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ["read_only", "write_draft"] }) }));
  registry.register(finalOutputExecutor);
  const traceStore = options.traceStore ?? createFileTraceStore({ root: roots.trace });
  const recorder = createTraceRecorder({ store: traceStore, clock: clockAt(start) });
  const host = createDurableRuntimeHost({ store, plan, registry, approvals, clock: clockAt(start), sleeper: { sleep: async () => undefined }, ...(options.tracing === false ? {} : { trace: recorder }) });
  return { host, approvals, recorder, traceStore };
}

function roots() {
  return { durability: tempRoot("aao-trace-durable-"), trace: tempRoot("aao-trace-store-") };
}

async function readTrace(root: string): Promise<TraceEvent[]> {
  return createFileTraceStore({ root }).getRunTrace(runId);
}

/** Process A: execute to the durable approval wait; then approve (as a human would, between processes). */
async function toApprovedWait(dirs: ReturnType<typeof roots>, world: ReturnType<typeof effects>) {
  const a = processAt(0, dirs, world);
  const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
  if (!waiting.ok || waiting.execution?.run.status !== "WAITING_FOR_APPROVAL") throw new Error("process A did not reach the wait");
  a.approvals.approve(waiting.execution.wait!.referenceId, bob);
  return waiting;
}

describe("durable restart trace continuity", () => {
  it("Process B continues the same trace: same traceId, continued sequence, one run.started, one run.completed, no duplicates", async () => {
    const dirs = roots();
    const world = effects();
    await toApprovedWait(dirs, world);
    const afterA = await readTrace(dirs.trace);
    expect(trajectory(afterA).at(-1)).toBe("node.waiting@approval");

    const b = processAt(100, dirs, world);
    const result = await b.host.resume(runId);
    expect(result.ok && result.execution?.run.status).toBe("COMPLETED");
    const events = await readTrace(dirs.trace);
    expect(events.slice(0, afterA.length)).toEqual(afterA);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
    expect(new Set(events.map((event) => event.traceId))).toEqual(new Set([afterA[0]!.traceId]));
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    expect(ofType(events, "run.started")).toHaveLength(1);
    expect(ofType(events, "run.completed")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("run.completed");
    expect(ofType(events, "checkpoint.created").map((event) => event.payload.checkpointSequence)).toEqual(ofType(events, "checkpoint.created").map((_, index) => index));
    expect(world.toolCalls).toBe(1);
    expect(validateTrace(events, { runStatus: "COMPLETED" })).toEqual({ valid: true, issues: [] });
    expect(compareTraceWithExecution(events, result.execution!)).toEqual({ valid: true, issues: [] });
    expect(b.recorder.health().status).toBe("healthy");
  });

  it("checkpoint events carry metadata only (no Runtime snapshot) and the plan fingerprint", async () => {
    const dirs = roots();
    await toApprovedWait(dirs, effects());
    const [first] = ofType(await readTrace(dirs.trace), "checkpoint.created");
    expect(Object.keys(first!.payload).sort()).toEqual(["checkpointId", "checkpointSequence", "currentNodeId", "planFingerprint", "runStatus", "stateRevision", "step"]);
    expect(first!.payload).toMatchObject({ checkpointId: "checkpoint.000000", checkpointSequence: 0, runStatus: "RUNNING", stateRevision: 0, currentNodeId: "prepare" });
  });
});

describe("durable recovery trace", () => {
  it("crash window C: outcome recorded, checkpoint lost → recovery.outcome_reused, recovered node.completed, no new Tool call event", async () => {
    const dirs = roots();
    const world = effects();
    await toApprovedWait(dirs, world);
    // Process B: the Tool succeeds and its outcome is durable, then the process dies before the next checkpoint.
    const b = processAt(100, dirs, world, { store: (store) => crashing(store, "writeCheckpoint", (checkpoint: { executionSnapshot: { nodeStatusesById: Record<string, string> } }) => checkpoint.executionSnapshot.nodeStatusesById.draft === "SUCCEEDED") });
    const crashed = await b.host.resume(runId);
    expect(!crashed.ok && crashed.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    const afterB = await readTrace(dirs.trace);
    expect(ofType(afterB, "tool.call.completed")).toHaveLength(1);
    expect(ofType(afterB, "node.completed").map((event) => event.nodeId)).not.toContain("draft");

    const c = processAt(200, dirs, world);
    const result = await c.host.resume(runId);
    expect(result.ok && result.execution?.run.status).toBe("COMPLETED");
    expect(world.toolCalls).toBe(1);
    const events = await readTrace(dirs.trace);
    const recovered = trajectory(events.slice(afterB.length));
    expect(recovered.slice(0, 2)).toEqual(["recovery.started", "recovery.outcome_reused@draft"]);
    expect(recovered).toContain("checkpoint.created");
    expect(recovered).toContain("recovery.completed");
    expect(recovered).not.toContain("tool.call.started@draft");
    expect(recovered).not.toContain("node.started@draft");
    expect(ofType(events, "node.completed").find((event) => event.nodeId === "draft")!.payload).toMatchObject({ outcomeSource: "recovered" });
    expect(ofType(events, "recovery.outcome_reused")[0]!.payload).toMatchObject({ operationId: expect.stringMatching(/^op\.s3\.a1$/), outcomeKind: "success" });
    expect(validateTrace(events, { runStatus: "COMPLETED" }).valid).toBe(true);
  });

  it("crash window B: ambiguous recovery-safe Tool → recovery.replayed and a correlated replay call under the same toolExecutionId", async () => {
    const dirs = roots();
    const world = effects();
    await toApprovedWait(dirs, world);
    const b = processAt(100, dirs, world, { store: (store) => crashing(store, "recordOperationOutcome", (_runId: string, operationId: string) => operationId === "op.s3.a1") });
    await b.host.resume(runId);
    const c = processAt(200, dirs, world);
    const result = await c.host.resume(runId);
    expect(result.ok && result.execution?.run.status).toBe("COMPLETED");
    expect(world.toolCalls).toBe(2);
    expect(new Set(world.toolExecutionIds).size).toBe(1);
    const events = await readTrace(dirs.trace);
    const starts = ofType(events, "tool.call.started");
    expect(starts.map((event) => [event.payload.toolExecutionId, event.payload.attempt, event.payload.recoveryReplay])).toEqual([[world.toolExecutionIds[0], 1, false], [world.toolExecutionIds[0], 1, true]]);
    expect(starts[0]!.spanId).toBe(starts[1]!.spanId);
    const fromC = trajectory(events.slice(events.findIndex((event) => event.type === "recovery.started")));
    expect(fromC.slice(0, 4)).toEqual(["recovery.started", "recovery.replayed@draft", "node.started@draft", "tool.call.started@draft"]);
    expect(fromC).toContain("recovery.completed");
    expect(ofType(events, "recovery.replayed")[0]!.payload).toEqual({ operationId: "op.s3.a1", step: 3, attempt: 1, recoveryReplayCount: 1 });
    expect(validateTrace(events, { runStatus: "COMPLETED" }).valid).toBe(true);
  });

  it("unsafe recovery: recovery.blocked + failure.detected, and no run.failed because the Run is not FAILED", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world, { idempotent: false });
    const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    a.approvals.approve(waiting.execution!.wait!.referenceId, bob);
    const b = processAt(100, dirs, world, { idempotent: false, store: (store) => crashing(store, "recordOperationOutcome", (_runId: string, operationId: string) => operationId === "op.s3.a1") });
    await b.host.resume(runId);
    const c = processAt(200, dirs, world, { idempotent: false });
    const result = await c.host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("DURABILITY_UNSAFE_REPLAY");
    expect(world.toolCalls).toBe(1);
    expect((await c.host.getRun(runId))!.status).toBe("RUNNING");
    const events = await readTrace(dirs.trace);
    expect(trajectory(events).slice(-3)).toEqual(["recovery.started", "recovery.blocked@draft", "failure.detected"]);
    expect(ofType(events, "recovery.blocked")[0]!.payload).toEqual({ operationId: "op.s3.a1", step: 3, attempt: 1, code: "DURABILITY_UNSAFE_REPLAY" });
    expect(ofType(events, "failure.detected").at(-1)!.payload).toMatchObject({ source: "durability", code: "DURABILITY_UNSAFE_REPLAY" });
    expect(ofType(events, "run.failed")).toHaveLength(0);
    expect(validateTrace(events, { runStatus: "RUNNING" }).valid).toBe(true);
  });

  it("re-entering the same recovery boundary in a later process deduplicates the semantic recovery event", async () => {
    const dirs = roots();
    const world = effects();
    await toApprovedWait(dirs, world);
    await processAt(100, dirs, world, { store: (store) => crashing(store, "recordOperationOutcome", (_runId: string, operationId: string) => operationId === "op.s3.a1") }).host.resume(runId);
    // Process C reaches the recovery boundary, then dies while marking the replay.
    const c = processAt(200, dirs, world, { store: (store) => crashing(store, "markOperationReplay") });
    const died = await c.host.resume(runId);
    expect(died.ok).toBe(false);
    // Process D re-enters the same recovery boundary from the same checkpoint.
    const d = processAt(300, dirs, world);
    expect((await d.host.resume(runId)).ok).toBe(true);
    const events = await readTrace(dirs.trace);
    expect(ofType(events, "recovery.started")).toHaveLength(1);
    expect(d.recorder.health().deduplicated).toBeGreaterThanOrEqual(1);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  });
});

describe("Trace is not durability", () => {
  it("Trace says the Tool completed while durability says ambiguous: recovery follows durability and replays", async () => {
    // The window-B setup: Process B's trace recorded tool.call.completed, but the outcome never became durable.
    const dirs = roots();
    const world = effects();
    await toApprovedWait(dirs, world);
    await processAt(100, dirs, world, { store: (store) => crashing(store, "recordOperationOutcome", (_runId: string, operationId: string) => operationId === "op.s3.a1") }).host.resume(runId);
    expect(ofType(await readTrace(dirs.trace), "tool.call.completed")).toHaveLength(1);
    await processAt(200, dirs, world).host.resume(runId);
    expect(world.toolCalls).toBe(2);
  });

  it("Trace lacks the Tool completion while durability has the accepted outcome: recovery reuses it (Trace cannot veto)", async () => {
    const dirs = roots();
    const world = effects();
    await toApprovedWait(dirs, world);
    const blind: TraceStore = { ...createInMemoryTraceStore(), append: async () => { throw new Error("trace down"); } };
    await processAt(100, dirs, world, { traceStore: blind, store: (store) => crashing(store, "writeCheckpoint", (checkpoint: { executionSnapshot: { nodeStatusesById: Record<string, string> } }) => checkpoint.executionSnapshot.nodeStatusesById.draft === "SUCCEEDED") }).host.resume(runId);
    expect(ofType(await readTrace(dirs.trace), "tool.call.completed")).toHaveLength(0);
    const result = await processAt(200, dirs, world).host.resume(runId);
    expect(result.ok && result.execution?.run.status).toBe("COMPLETED");
    expect(world.toolCalls).toBe(1);
  });

  it("deleting the Trace Store leaves durable recovery intact; the new trace is reported incomplete", async () => {
    const dirs = roots();
    const world = effects();
    await toApprovedWait(dirs, world);
    rmSync(dirs.trace, { recursive: true, force: true });
    const b = processAt(100, dirs, world);
    const result = await b.host.resume(runId);
    expect(result.ok && result.execution?.run.status).toBe("COMPLETED");
    expect(world.toolCalls).toBe(1);
    const events = await readTrace(dirs.trace);
    expect(events[0]!.sequence).toBe(0);
    expect(validateTrace(events, { runStatus: "COMPLETED" }).issues.map((issue) => issue.code)).toContain("TRACE_RUN_START_MISSING");
  });

  it("a corrupt Trace Store leaves durable recovery intact; the recorder reports degraded", async () => {
    const dirs = roots();
    const world = effects();
    await toApprovedWait(dirs, world);
    const runDir = readdirSync(join(dirs.trace, "runs"))[0]!;
    writeFileSync(join(dirs.trace, "runs", runDir, "events", "000000003.json"), "{garbage");
    const b = processAt(100, dirs, world);
    const result = await b.host.resume(runId);
    expect(result.ok && result.execution?.run.status).toBe("COMPLETED");
    expect(world.toolCalls).toBe(1);
    expect(b.recorder.health().status).toBe("degraded");
    expect(b.recorder.health().issues.every((issue) => issue.code === "TRACE_STORE_CORRUPT")).toBe(true);
  });

  it("durable operation records are not trace events: an untraced durable Run has a ledger and an empty trace", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world, { tracing: false });
    const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    a.approvals.approve(waiting.execution!.wait!.referenceId, bob);
    await processAt(100, dirs, world, { tracing: false }).host.resume(runId);
    const view = await processAt(200, dirs, world, { tracing: false }).host.getRun(runId);
    expect(view!.operations.length).toBeGreaterThan(0);
    expect(await readTrace(dirs.trace)).toEqual([]);
  });
});

describe("cancellation trace", () => {
  it("records cancellation.requested, cancellation.applied, run.cancelled, then the pending approval's cancellation", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world);
    await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    await a.host.requestCancellation(runId);
    const result = await processAt(100, dirs, world).host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("RUN_CANCELLED");
    const events = await readTrace(dirs.trace);
    const tail = trajectory(events.slice(events.findIndex((event) => event.type === "cancellation.requested")));
    expect(tail[0]).toBe("cancellation.requested");
    expect(tail.slice(-3)).toEqual(["cancellation.applied@approval", "run.cancelled", "approval.resolved@approval"]);
    expect(ofType(events, "approval.resolved")[0]!.payload).toMatchObject({ status: "cancelled" });
    expect(validateTrace(events, { runStatus: "CANCELLED" })).toEqual({ valid: true, issues: [] });
  });
});
