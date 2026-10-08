import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApprovalEngine, createApprovalNodeExecutor } from "@aao/approval";
import { auditStreamIdForRun, type AuditEvent } from "@aao/contracts";
import { DurabilityError, createDurableRuntimeHost, createFileDurabilityStore, type DurabilityStore } from "@aao/durability";
import { createNodeRegistry, finalOutputExecutor, type NodeExecutor } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry } from "@aao/tool-runtime";
import { aggregateRunMetrics, checkAuditCompleteness, createAuditRecorder, createFileAuditStore, createFileTraceStore, createTraceRecorder, deriveRunMetrics, validateAuditStream } from "../src/index.js";
import { alice, bob, compile, governance, tempRoot } from "./fixtures.js";

/** prepare → approval → draft (Tool) → final */
const yaml = `
schemaVersion: 1
id: metrics.durable
version: "1.0.0"
name: Metrics durable
entryNodeId: prepare
nodes:
  - id: prepare
    kind: deterministic
    config: {}
  - id: approval
    kind: approval
    config:
      subjectStateKey: proposal
      permissionClasses: [read_only]
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
const runId = "run.metrics.durable";
const stream = auditStreamIdForRun(runId);
const plan = compile(yaml);

function at(seconds: number) {
  return new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + seconds * 1000).toISOString();
}
/** A ticking clock starting at `start` seconds; a later process starts later, like real time. */
function clockAt(start: number) {
  let tick = start;
  return { now: () => at(tick++) };
}

function roots() {
  return { durability: tempRoot("aao-s16-durable-"), trace: tempRoot("aao-s16-trace-"), audit: tempRoot("aao-s16-audit-") };
}
function effects() {
  return { toolCalls: 0, toolExecutionIds: [] as string[] };
}

type StoreMethod = Exclude<keyof DurabilityStore, "approvals">;
function crashing(store: DurabilityStore, method: StoreMethod, when: (...args: never[]) => boolean): DurabilityStore {
  let crashed = false;
  const original = store[method] as (...args: unknown[]) => Promise<unknown>;
  return { ...store, approvals: store.approvals, [method]: (...args: unknown[]) => { if (!crashed && (when as (...a: unknown[]) => boolean)(...args)) { crashed = true; return Promise.reject(new DurabilityError("DURABILITY_IO_FAILED")); } return original(...args); } } as DurabilityStore;
}

/** One simulated process over shared roots: durability, approvals, Tool, Trace recorder, and Audit recorder are built from scratch. */
function processAt(start: number, dirs: ReturnType<typeof roots>, world: ReturnType<typeof effects>, options: { store?: (store: DurabilityStore) => DurabilityStore; failFirstCall?: boolean; permission?: "read_only" | "write_draft" } = {}) {
  const base = createFileDurabilityStore({ root: dirs.durability });
  const store = options.store ? options.store(base) : base;
  const clock = clockAt(start);
  const auditStore = createFileAuditStore({ root: dirs.audit });
  const audit = createAuditRecorder({ store: auditStore, clock });
  const approvals = createApprovalEngine({ governance: governance(), clock, repository: store.approvals, audit });
  const tools = createToolRegistry();
  const permission = options.permission ?? "write_draft";
  tools.register({
    spec: { schemaVersion: 1, id: "local.draft", version: "1.0.0", name: "Draft", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: [permission] },
    ...(permission === "write_draft" ? { idempotency: "execution_id" as const } : { retrySafety: "safe" as const }),
    handler: { async execute({ toolExecutionId }) { world.toolCalls += 1; world.toolExecutionIds.push(toolExecutionId); return options.failFirstCall && world.toolCalls === 1 ? { ok: false, code: "UPSTREAM_UNAVAILABLE", retryable: true } : { ok: true, output: { draft: 1 } }; } },
  });
  const deterministic: NodeExecutor = { kind: "deterministic", recoverySafety: () => "safe", async execute() { return { ok: true, statePatch: { proposal: { action: "draft" } } }; } };
  const registry = createNodeRegistry();
  registry.register(deterministic);
  registry.register(createApprovalNodeExecutor(approvals, () => alice));
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ["read_only", "write_draft"] }), audit }));
  registry.register(finalOutputExecutor);
  const traceStore = createFileTraceStore({ root: dirs.trace });
  const trace = createTraceRecorder({ store: traceStore, clock });
  const host = createDurableRuntimeHost({ store, plan, registry, approvals, clock, sleeper: { sleep: async () => undefined }, ...(options.permission === "read_only" ? { reliability: { policiesByNodeId: { draft: { maxAttempts: 3 } } } } : {}), trace, audit });
  return { host, approvals, trace, traceStore, audit, auditStore };
}

const auditLabels = (events: readonly AuditEvent[]) => events.map((event) => `${event.type}:${event.actor.id}`);

describe("durable restart: Metrics and Audit across processes", () => {
  it("one Run, one duration, recovery counted once; Audit resolution at T1 in its own stream position, chain continuous across processes", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world, { permission: "read_only", failFirstCall: true });
    const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    expect(waiting.execution?.run.status).toBe("WAITING_FOR_APPROVAL");
    // A human approves between processes, through the approval engine of a host tool (clock at 50s).
    const between = processAt(50, dirs, world, { permission: "read_only" });
    const record = between.approvals.approve(waiting.execution!.wait!.referenceId, bob);
    await between.audit.flush();
    expect(record.resolvedAt).toBe(at(50));

    const b = processAt(100, dirs, world, { permission: "read_only", failFirstCall: true });
    const done = await b.host.resume(runId);
    expect(done.ok && done.execution?.run.status).toBe("COMPLETED");
    await b.audit.flush();

    const trace = await b.traceStore.getRunTrace(runId);
    const projection = deriveRunMetrics({ trace, traceHealth: b.trace.runHealth(runId) });
    expect(projection.ok).toBe(true);
    const metrics = projection.ok ? projection.metrics : undefined!;
    expect(metrics.runStatus).toBe("COMPLETED");
    expect(metrics.durationMs).toBe(Date.parse(trace.at(-1)!.occurredAt) - Date.parse(trace[0]!.occurredAt));
    expect(metrics.traceQuality.status).toBe("complete");
    expect(metrics).toMatchObject({ retries: { scheduled: 1 }, tools: { physicalInvocations: 2, logicalExecutions: 1, completed: 1, failed: 1 }, approvals: { requested: 1, approved: 1, pending: 0 } });
    expect(metrics.nodes.attemptDetails.filter((attempt) => attempt.nodeId === "prepare")).toHaveLength(1);
    expect(aggregateRunMetrics({ runs: [metrics] })).toMatchObject({ ok: true, metrics: { runCount: 1, runs: { completed: 1 }, latency: { eligibleRuns: 1 } } });

    const audit = await createFileAuditStore({ root: dirs.audit }).getStream(stream);
    expect(auditLabels(audit)).toEqual(["approval.requested:user.alice", "approval.resolved:user.bob", "tool.access.allowed:user.alice", "tool.access.allowed:user.alice"]);
    expect(audit[1]!.occurredAt).toBe(at(50));
    expect(trace.find((event) => event.type === "approval.resolved")!.occurredAt).not.toBe(at(50));
    expect(audit.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(validateAuditStream(audit, { streamId: stream })).toEqual({ valid: true, issues: [] });
    expect(checkAuditCompleteness({ trace, audit }).status).toBe("complete");
  });

  it("physical vs logical Tool metrics: a crash replay under one toolExecutionId is 2 physical invocations, 1 logical execution", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world);
    const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    a.approvals.approve(waiting.execution!.wait!.referenceId, bob);
    await processAt(100, dirs, world, { store: (store) => crashing(store, "recordOperationOutcome", (_runId: string, operationId: string) => operationId === "op.s3.a1") }).host.resume(runId);
    const c = processAt(200, dirs, world);
    expect((await c.host.resume(runId)).ok).toBe(true);
    expect(world.toolCalls).toBe(2);
    expect(new Set(world.toolExecutionIds).size).toBe(1);
    const projection = deriveRunMetrics({ trace: await c.traceStore.getRunTrace(runId) });
    const metrics = projection.ok ? projection.metrics : undefined!;
    expect(metrics.tools).toMatchObject({ physicalInvocations: 2, logicalExecutions: 1, completed: 2 });
    expect(metrics.durability).toMatchObject({ recoveryStarts: 1, recoveryReplays: 1 });
    expect(metrics.nodes.recoveryReplayAttempts).toBe(1);
    // The abandoned original attempt has no observed end: its duration is unavailable, not zero.
    expect(metrics.nodes.attemptDetails.filter((attempt) => attempt.nodeId === "draft").map((attempt) => [attempt.recoveryReplay, attempt.outcome, attempt.durationMs === null])).toEqual([[false, "open", true], [true, "completed", false]]);
  });
});

describe("attributed cancellation Audit", () => {
  it("request and application are distinct, attributed, source-timed events that survive restart", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world);
    await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    const requested = await a.host.requestCancellation(runId, { requestedBy: alice, reasonCode: "OPERATOR_REQUEST" });
    expect(requested.ok && requested.cancellation).toMatchObject({ requestedBy: alice, reasonCode: "OPERATOR_REQUEST" });
    // Idempotent: a second request keeps the first accountable requester.
    const again = await a.host.requestCancellation(runId, { requestedBy: { id: "service.batch", type: "service" } });
    expect(again.ok && again.cancellation.requestedBy).toEqual(alice);
    await a.audit.flush();
    const b = processAt(100, dirs, world);
    const result = await b.host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("RUN_CANCELLED");
    await b.audit.flush();
    const audit = await createFileAuditStore({ root: dirs.audit }).getStream(stream);
    expect(auditLabels(audit)).toEqual(["approval.requested:user.alice", "run.cancellation.requested:user.alice", "run.cancellation.applied:user.alice"]);
    const [, req, applied] = audit;
    expect(req).toMatchObject({ occurredAt: requested.ok ? requested.cancellation.requestedAt : "", target: { kind: "run", runId }, outcome: "requested", payload: { reasonCode: "OPERATOR_REQUEST" } });
    expect(applied).toMatchObject({ occurredAt: result.execution!.run.updatedAt, outcome: "applied", payload: { requestedAt: req!.occurredAt, nodeId: "approval" } });
    expect(validateAuditStream(audit)).toEqual({ valid: true, issues: [] });
    expect(checkAuditCompleteness({ trace: await b.traceStore.getRunTrace(runId), audit }).status).toBe("complete");
  });

  it("a cancellation request without a host-attested requester is refused; no actor is fabricated", async () => {
    const dirs = roots();
    const a = processAt(0, dirs, effects());
    await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    for (const request of [undefined, {}, { requestedBy: { id: "x", type: "admin" } }, { requestedBy: alice, reasonCode: "free text reason" }]) {
      expect(await a.host.requestCancellation(runId, request as never)).toMatchObject({ ok: false, failure: { code: "DURABILITY_INVALID_INPUT" } });
    }
    expect((await a.host.getRun(runId))!.cancellation).toBeUndefined();
  });

  it("an unattributed (pre-Sprint-16) durable request still cancels, but no applied Audit event is invented", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world);
    await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    await createFileDurabilityStore({ root: dirs.durability }).requestCancellation(runId, at(10));
    const b = processAt(100, dirs, world);
    expect((await b.host.resume(runId)).execution?.run.status).toBe("CANCELLED");
    await b.audit.flush();
    expect(auditLabels(await createFileAuditStore({ root: dirs.audit }).getStream(stream))).toEqual(["approval.requested:user.alice"]);
  });
});

describe("evidence channels are independent of each other and of execution", () => {
  it("corrupt or deleted Audit never affects durable recovery; recovery reads only durability", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world);
    const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    a.approvals.approve(waiting.execution!.wait!.referenceId, bob);
    await a.audit.flush();
    const [streamDir] = readdirSync(join(dirs.audit, "streams"));
    writeFileSync(join(dirs.audit, "streams", streamDir!, "events", "000000000.json"), "{tampered");
    const b = processAt(100, dirs, world);
    const result = await b.host.resume(runId);
    expect(result.ok && result.execution?.run.status).toBe("COMPLETED");
    expect(world.toolCalls).toBe(1);
    await b.audit.flush();
    expect(b.audit.health()).toMatchObject({ status: "degraded" });
    expect(b.audit.health().issues.every((issue) => issue.code === "AUDIT_STORE_CORRUPT")).toBe(true);
    // Trace is intact, so Metrics still derive completely while Audit is degraded.
    const projection = deriveRunMetrics({ trace: await b.traceStore.getRunTrace(runId), traceHealth: b.trace.runHealth(runId) });
    expect(projection).toMatchObject({ ok: true, quality: "complete", metrics: { runStatus: "COMPLETED" } });

    rmSync(dirs.audit, { recursive: true, force: true });
    const c = processAt(200, dirs, world);
    expect((await c.host.resume(runId)).ok).toBe(true);
  });

  it("Trace lost, Audit intact: the Audit chain still verifies, but operational Metrics are unavailable — never rebuilt from Audit", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world);
    const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    a.approvals.approve(waiting.execution!.wait!.referenceId, bob);
    await processAt(100, dirs, world).host.resume(runId);
    rmSync(dirs.trace, { recursive: true, force: true });
    expect(await createFileAuditStore({ root: dirs.audit }).verifyStream(stream)).toEqual({ valid: true, issues: [] });
    const projection = deriveRunMetrics({ trace: await createFileTraceStore({ root: dirs.trace }).getRunTrace(runId) });
    expect(projection).toMatchObject({ ok: false, quality: "invalid", code: "METRICS_INVALID_TRACE" });
  });

  it("Audit lost, Trace intact: Metrics derive; Audit completeness is degraded rather than reconstructed from Trace", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world);
    const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    a.approvals.approve(waiting.execution!.wait!.referenceId, bob);
    await a.audit.flush();
    rmSync(dirs.audit, { recursive: true, force: true });
    const b = processAt(100, dirs, world);
    await b.host.resume(runId);
    await b.audit.flush();
    const trace = await b.traceStore.getRunTrace(runId);
    expect(deriveRunMetrics({ trace })).toMatchObject({ ok: true, metrics: { runStatus: "COMPLETED" } });
    const completeness = checkAuditCompleteness({ trace, audit: await createFileAuditStore({ root: dirs.audit }).getStream(stream) });
    expect(completeness.status).toBe("degraded");
    expect(completeness.missing.map((entry) => entry.auditType)).toEqual(["approval.requested", "approval.resolved"]);
  });

  it("forged RunMetrics change nothing: Runtime truth stays where it is", async () => {
    const dirs = roots();
    const world = effects();
    const a = processAt(0, dirs, world);
    const waiting = await a.host.execute({ runId, initialState: { runId, revision: 0, values: {} } });
    a.approvals.reject(waiting.execution!.wait!.referenceId, bob);
    const failed = await processAt(100, dirs, world).host.resume(runId);
    expect(failed.execution?.run.status).toBe("FAILED");
    const projection = deriveRunMetrics({ trace: await createFileTraceStore({ root: dirs.trace }).getRunTrace(runId) });
    const forged = { ...(projection.ok ? projection.metrics : undefined!), runStatus: "COMPLETED" as const };
    expect(aggregateRunMetrics({ runs: [forged] })).toMatchObject({ ok: true, metrics: { runs: { completed: 1 } } });
    const view = await processAt(200, dirs, world).host.getRun(runId);
    expect(view!.status).toBe("FAILED");
    expect(world.toolCalls).toBe(0);
  });
});
