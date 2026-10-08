import { describe, expect, it } from "vitest";
import { ApprovalError, continueApprovedWorkflow } from "@aao/approval";
import { auditStreamIdForRun, type AuditEvent, type Principal } from "@aao/contracts";
import { executeWorkflow } from "@aao/runtime";
import { createToolRegistry, executeTool } from "@aao/tool-runtime";
import { checkAuditCompleteness, createAuditRecorder, createInMemoryAuditStore, findForbiddenTraceKeys, summarizeObservabilityHealth, type AuditStore } from "../src/index.js";
import { SECRET, TRANSIENT, alice, bob, compile, ofType, toolYaml, trajectory, world, type WorldOptions } from "./fixtures.js";

const runId = "run.audit.flagship";
const stream = auditStreamIdForRun(runId);
const service = { id: "service.batch", type: "service" } as const;

/** One controllable clock shared by Runtime, Trace, Approval, and Audit: time moves only when a test says so. */
function manualClock(startIso = "2026-10-08T09:00:00.000Z") {
  let now = Date.parse(startIso);
  return { now: () => new Date(now).toISOString(), advance: (ms: number) => { now += ms; } };
}

async function toWait(options: WorldOptions & { auditStore: AuditStore }) {
  const w = world(options);
  const waiting = await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: {} }, options: w.runtimeOptions });
  if (!waiting.ok || !waiting.execution.wait) throw new Error("did not reach the approval wait");
  return { ...w, waiting, approvalId: waiting.execution.wait.referenceId };
}

const labels = (events: readonly AuditEvent[]) => events.map((event) => `${event.type}:${event.actor.id}:${event.outcome}`);

describe("primary Audit E2E: source-time Approval resolution and Tool access", () => {
  it("Alice requests, Bob approves at T1, the Runtime continues at T2, Tool access is allowed — Audit says T1, Trace says T2", async () => {
    const clock = manualClock();
    const auditStore = createInMemoryAuditStore();
    const w = await toWait({ auditStore, clock });
    clock.advance(60 * 60 * 1000); // an hour later, Bob decides
    const t1 = clock.now();
    const record = w.approvals.approve(w.approvalId, bob);
    expect(record.resolvedAt).toBe(t1);
    clock.advance(30 * 60 * 1000); // the host resumes half an hour after the decision
    const t2 = clock.now();
    const done = await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: w.waiting.execution, options: w.runtimeOptions });
    expect(done.ok && done.execution.run.status).toBe("COMPLETED");
    await w.auditRecorder!.flush();

    const audit = await auditStore.getStream(stream);
    expect(labels(audit)).toEqual(["approval.requested:user.alice:requested", "approval.resolved:user.bob:approved", "tool.access.allowed:user.alice:allowed"]);
    const auditResolved = audit[1]!;
    const traceResolved = ofType(await w.store.getRunTrace(runId), "approval.resolved")[0]!;
    // Different facts on purpose: Audit = authoritative resolution; Trace = Runtime consumption.
    expect(auditResolved.occurredAt).toBe(t1);
    expect(traceResolved.occurredAt).toBe(t2);
    expect(traceResolved.payload.resolvedAt).toBe(t1);
    expect(Date.parse(t2) - Date.parse(t1)).toBe(30 * 60 * 1000);
    expect(auditResolved).toMatchObject({ action: "approval.resolve", target: { kind: "approval", approvalId: w.approvalId }, payload: { approvalId: w.approvalId, nodeId: "approval", decision: "approved", requestFingerprint: record.requestFingerprint } });

    // Access accountability vs execution chronology: correlated by toolExecutionId, not duplicates.
    const trace = await w.store.getRunTrace(runId);
    expect(trajectory(trace).filter((label) => label.startsWith("tool."))).toEqual(["tool.call.started@lookup", "tool.call.completed@lookup"]);
    expect(audit[2]!.payload).toEqual({ toolExecutionId: ofType(trace, "tool.call.started")[0]!.payload.toolExecutionId, attempt: 1, nodeId: "lookup", permissionClasses: ["read_only"], agentCeilingApplied: false });
    expect(audit[2]!.target).toEqual({ kind: "tool", toolId: "local.lookup", toolVersion: "1.0.0" });
    expect(await auditStore.verifyStream(stream)).toEqual({ valid: true, issues: [] });
    expect(checkAuditCompleteness({ trace, audit })).toEqual({ status: "complete", missing: [] });
    expect(summarizeObservabilityHealth({ trace: w.recorder.health(), audit: w.auditRecorder!.health() })).toEqual({ trace: "healthy", audit: "healthy" });
  });

  it("request audit carries safe metadata only — never the Approval subject, Tool input/output, secrets, or profile data", async () => {
    const auditStore = createInMemoryAuditStore();
    const w = await toWait({ auditStore });
    w.approvals.approve(w.approvalId, bob);
    await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: w.waiting.execution, options: w.runtimeOptions });
    await w.auditRecorder!.flush();
    const audit = await auditStore.getStream(stream);
    expect(audit[0]!.payload).toEqual({ approvalId: w.approvalId, nodeId: "approval", requiredApproverRoleIds: ["manager"], permissionClasses: ["read_only"], allowSelfApproval: false, requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const serialized = JSON.stringify(audit);
    // The subject (proposal) holds SECRET under "credential"; the Tool output echoes SECRET under "apiKeyEcho".
    for (const leaked of [SECRET, "account-a", "credential", "apiKeyEcho", "proposal", "lookupResult", "email", "displayName"]) expect(serialized).not.toContain(leaked);
    for (const event of audit) {
      expect(Object.keys(event.actor).sort()).toEqual(["id", "type"]);
      expect(findForbiddenTraceKeys(event.payload)).toEqual([]);
    }
  });
});

describe("denied Approval resolution attempts are audited; authority never changes", () => {
  async function attempt(resolver: unknown, options: { requester?: Principal } = {}) {
    const auditStore = createInMemoryAuditStore();
    const w = await toWait({ auditStore, ...(options.requester ? { requester: options.requester } : {}) });
    let code: string | undefined;
    try { w.approvals.approve(w.approvalId, resolver as Principal); } catch (error) { code = (error as ApprovalError).code; }
    await w.auditRecorder!.flush();
    return { code, status: w.approvals.getApproval(w.approvalId)!.status, audit: await auditStore.getStream(stream), approvalId: w.approvalId };
  }

  it("ineligible role: Approval stays pending; Audit records approval.resolution_denied by the attempted resolver", async () => {
    const { code, status, audit, approvalId } = await attempt(alice);
    expect(code).toBe("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(status).toBe("pending");
    expect(labels(audit)).toEqual(["approval.requested:user.alice:requested", "approval.resolution_denied:user.alice:denied"]);
    expect(audit[1]!.payload).toEqual({ approvalId, nodeId: "approval", attemptedDecision: "approved", reasonCode: "APPROVAL_RESOLVER_NOT_ELIGIBLE" });
    expect(audit.some((event) => event.type === "approval.resolved")).toBe(false);
  });

  it("self-approval: forbidden, pending, audited with APPROVAL_SELF_APPROVAL_FORBIDDEN", async () => {
    const { code, status, audit } = await attempt(bob, { requester: bob });
    expect(code).toBe("APPROVAL_SELF_APPROVAL_FORBIDDEN");
    expect(status).toBe("pending");
    expect(labels(audit)).toEqual(["approval.requested:user.bob:requested", "approval.resolution_denied:user.bob:denied"]);
    expect(audit[1]!.payload.reasonCode).toBe("APPROVAL_SELF_APPROVAL_FORBIDDEN");
  });

  it("nonhuman resolver: the service principal is recorded as the attempted actor", async () => {
    const { code, audit } = await attempt(service);
    expect(code).toBe("APPROVAL_HUMAN_REQUIRED");
    expect(audit[1]).toMatchObject({ type: "approval.resolution_denied", actor: service, payload: { reasonCode: "APPROVAL_HUMAN_REQUIRED" } });
  });

  it("an unattributable attempt (malformed principal) is refused without fabricating an actor", async () => {
    const { code, audit } = await attempt({ id: "", type: "admin" });
    expect(code).toBe("APPROVAL_HUMAN_REQUIRED");
    expect(labels(audit)).toEqual(["approval.requested:user.alice:requested"]);
  });

  it("duplicate resolution: one approval.resolved, the second attempt is a denied conflict, and the first decision stands", async () => {
    const auditStore = createInMemoryAuditStore();
    const w = await toWait({ auditStore });
    w.approvals.approve(w.approvalId, bob);
    expect(() => w.approvals.reject(w.approvalId, bob)).toThrow(expect.objectContaining({ code: "APPROVAL_ALREADY_RESOLVED" }));
    await w.auditRecorder!.flush();
    const audit = await auditStore.getStream(stream);
    expect(labels(audit)).toEqual(["approval.requested:user.alice:requested", "approval.resolved:user.bob:approved", "approval.resolution_denied:user.bob:denied"]);
    expect(audit[2]!.payload).toMatchObject({ attemptedDecision: "rejected", reasonCode: "APPROVAL_ALREADY_RESOLVED" });
    expect(w.approvals.getApproval(w.approvalId)!.status).toBe("approved");
  });

  it("rejection is audited at the authoritative transition with the rejected outcome", async () => {
    const auditStore = createInMemoryAuditStore();
    const w = await toWait({ auditStore });
    w.approvals.reject(w.approvalId, bob);
    await w.auditRecorder!.flush();
    expect(labels(await auditStore.getStream(stream))).toEqual(["approval.requested:user.alice:requested", "approval.resolved:user.bob:rejected"]);
  });

  it("an exact-request replay of the Approval Node does not duplicate approval.requested", async () => {
    const auditStore = createInMemoryAuditStore();
    const w = await toWait({ auditStore });
    // Re-running the same exact request (as a crash replay would) returns the stored record.
    const record = w.approvals.getApproval(w.approvalId)!;
    w.approvals.requestApproval({ approvalId: record.approvalId, runId: record.runId, nodeId: record.nodeId, requestFingerprint: record.requestFingerprint, requestedBy: record.requestedBy, requiredApproverRoleIds: [...record.requiredApproverRoleIds], permissionClasses: [...record.permissionClasses], allowSelfApproval: record.allowSelfApproval });
    await w.auditRecorder!.flush();
    expect(labels(await auditStore.getStream(stream))).toEqual(["approval.requested:user.alice:requested"]);
    expect(w.auditRecorder!.health()).toMatchObject({ status: "healthy", deduplicated: 1 });
  });
});

describe("Tool access Audit", () => {
  const toolRun = async (options: WorldOptions & { auditStore: AuditStore }) => {
    const w = world({ plan: compile(toolYaml), ...options });
    const result = await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: { proposal: { q: "x" } } }, options: w.runtimeOptions });
    await w.auditRecorder!.flush();
    return { ...w, result, audit: await options.auditStore.getStream(stream), trace: await w.store.getRunTrace(runId) };
  };

  it("deny: tool.access.denied with principal, Tool ref, and bounded reason; Trace shows tool.call.blocked; handler calls 0", async () => {
    const { audit, trace, calls, result } = await toolRun({ auditStore: createInMemoryAuditStore(), grants: [] });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ type: "tool.access.denied", actor: alice, action: "tool.execute", outcome: "denied", target: { kind: "tool", toolId: "local.lookup", toolVersion: "1.0.0" }, payload: { attempt: 1, nodeId: "lookup", permissionClasses: ["read_only"], reasonCode: "PERMISSION_NOT_GRANTED" } });
    expect(trajectory(trace)).toContain("tool.call.blocked@lookup");
    expect(audit[0]!.payload.toolExecutionId).toBe(ofType(trace, "tool.call.blocked")[0]!.payload.toolExecutionId);
    expect(checkAuditCompleteness({ trace, audit }).status).toBe("complete");
  });

  it("retries: one access decision per Runtime attempt, correlated with the physical Tool calls", async () => {
    const { audit, calls, trace } = await toolRun({ auditStore: createInMemoryAuditStore(), toolScript: [TRANSIENT], toolRetrySafety: "safe", reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } });
    expect(calls).toHaveLength(2);
    expect(audit.map((event) => [event.type, event.payload.attempt])).toEqual([["tool.access.allowed", 1], ["tool.access.allowed", 2]]);
    expect(ofType(trace, "tool.call.started").map((event) => event.payload.attempt)).toEqual([1, 2]);
  });

  it("only actual authorization decisions are audited — not support-gate, missing-context, or request-validation failures", async () => {
    const recorder = createAuditRecorder({ store: createInMemoryAuditStore() });
    const tools = createToolRegistry();
    tools.register({ spec: { schemaVersion: 1, id: "local.send", version: "1.0.0", name: "Send", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["external_side_effect"] }, handler: { execute: async () => ({ ok: true, output: {} }) } });
    tools.register({ spec: { schemaVersion: 1, id: "local.read", version: "1.0.0", name: "Read", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["read_only"] }, handler: { execute: async () => ({ ok: true, output: {} }) } });
    const audit = { port: recorder, runId, attempt: 1 };
    const context = { schemaVersion: 1 as const, principal: alice, grantedPermissionClasses: ["read_only" as const, "external_side_effect" as const] };
    expect((await executeTool({ tools, request: { schemaVersion: 1, toolExecutionId: "t.1", toolRef: { id: "local.send", version: "1.0.0" }, input: {} }, authorizationContext: context, audit })).ok).toBe(false);
    expect((await executeTool({ tools, request: { schemaVersion: 1, toolExecutionId: "t.2", toolRef: { id: "local.read", version: "1.0.0" }, input: {} }, authorizationContext: undefined as never, audit })).ok).toBe(false);
    expect((await executeTool({ tools, request: { schemaVersion: 1, toolExecutionId: "t.3", toolRef: { id: "local.missing", version: "1.0.0" }, input: {} }, authorizationContext: context, audit })).ok).toBe(false);
    await recorder.flush();
    expect(recorder.health().appended).toBe(0);
    // An Agent acting through the principal is recorded by its registered reference only.
    const withAgent = { ...context, agent: { agentRef: { id: "agent.researcher", version: "1.0.0" }, permissionCeiling: ["read_only" as const] } };
    expect((await executeTool({ tools, request: { schemaVersion: 1, toolExecutionId: "t.4", toolRef: { id: "local.read", version: "1.0.0" }, input: { prompt: SECRET } }, authorizationContext: withAgent, audit })).ok).toBe(true);
    await recorder.flush();
    expect(recorder.health().appended).toBe(1);
  });
});

describe("Audit failure isolation", () => {
  it("a failing Audit Store changes nothing about Approval, Tool authorization, Tool calls, or Run outcome — and causes no retry", async () => {
    const run = async (auditStore: AuditStore) => {
      const w = await toWait({ auditStore, toolScript: [TRANSIENT], toolRetrySafety: "safe", reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } });
      const record = w.approvals.approve(w.approvalId, bob);
      const done = await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: w.waiting.execution, options: w.runtimeOptions });
      await w.auditRecorder!.flush();
      return { record, done, calls: w.calls.length, trace: trajectory(await w.store.getRunTrace(runId)), health: w.auditRecorder!.health() };
    };
    const healthy = await run(createInMemoryAuditStore());
    let appendCalls = 0;
    const failing: AuditStore = { ...createInMemoryAuditStore(), append: async () => { appendCalls += 1; throw new Error("ENOSPC: /audit/disk full, token=sk-live-XYZ"); } };
    const degraded = await run(failing);

    expect(degraded.record.status).toBe("approved");
    expect(degraded.done.ok && degraded.done.execution.run.status).toBe("COMPLETED");
    expect(degraded.done.execution!.state).toEqual(healthy.done.execution!.state);
    expect(degraded.calls).toBe(healthy.calls);
    expect(degraded.calls).toBe(2);
    expect(degraded.trace).toEqual(healthy.trace);
    // Each audit event was attempted exactly once: Audit failure never retries itself or the action.
    expect(appendCalls).toBe(4);
    expect(degraded.health.status).toBe("degraded");
    expect(new Set(degraded.health.issues.map((issue) => issue.code))).toEqual(new Set(["AUDIT_STORE_FAILURE"]));
    expect(JSON.stringify(degraded.health)).not.toMatch(/ENOSPC|disk|sk-live/);
  });

  it("Trace cannot substitute for missing Audit: completeness is degraded, never inferred from Trace", async () => {
    let failNext = false;
    const base = createInMemoryAuditStore();
    const flaky: AuditStore = { ...base, append: async (event) => { if (failNext && event.type === "approval.resolved") throw new Error("down"); return base.append(event); } };
    const w = await toWait({ auditStore: flaky });
    failNext = true;
    w.approvals.approve(w.approvalId, bob);
    await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: w.waiting.execution, options: w.runtimeOptions });
    await w.auditRecorder!.flush();
    const trace = await w.store.getRunTrace(runId);
    const audit = await base.getStream(stream);
    expect(ofType(trace, "approval.resolved")).toHaveLength(1);
    expect(audit.some((event) => event.type === "approval.resolved")).toBe(false);
    const completeness = checkAuditCompleteness({ trace, audit });
    expect(completeness.status).toBe("degraded");
    expect(completeness.missing).toEqual([{ auditType: "approval.resolved", traceSequence: ofType(trace, "approval.resolved")[0]!.sequence }]);
    expect(summarizeObservabilityHealth({ trace: w.recorder.health(), audit: w.auditRecorder!.health() })).toEqual({ trace: "healthy", audit: "degraded" });
  });
});

describe("Audit is evidence, never authority", () => {
  it("a forged approval.resolved Audit event cannot approve: the repository stays pending and the Run stays waiting", async () => {
    const auditStore = createInMemoryAuditStore();
    const w = await toWait({ auditStore });
    const forger = createAuditRecorder({ store: auditStore });
    forger.emit({ type: "approval.resolved", runId, actor: bob, target: { kind: "approval", approvalId: w.approvalId }, occurredAt: "2026-10-08T12:30:00.000Z", key: { approvalId: w.approvalId }, payload: { approvalId: w.approvalId, nodeId: "approval", decision: "approved", requestFingerprint: w.approvals.getApproval(w.approvalId)!.requestFingerprint } });
    await forger.flush();
    expect((await auditStore.getStream(stream)).some((event) => event.type === "approval.resolved")).toBe(true);
    expect(w.approvals.getApproval(w.approvalId)!.status).toBe("pending");
    const result = await continueApprovedWorkflow(w.approvals, { plan: w.plan, registry: w.registry, execution: w.waiting.execution, options: w.runtimeOptions });
    expect(result.execution?.run.status).toBe("WAITING_FOR_APPROVAL");
    expect(w.calls).toHaveLength(0);
  });

  it("a forged tool.access.allowed Audit event cannot authorize: Governance/Authorization still deny and handler calls stay 0", async () => {
    const auditStore = createInMemoryAuditStore();
    const forger = createAuditRecorder({ store: auditStore });
    forger.emit({ type: "tool.access.allowed", runId, actor: alice, target: { kind: "tool", toolId: "local.lookup", toolVersion: "1.0.0" }, key: { toolExecutionId: "forged", attempt: 1, decision: "allow" }, payload: { toolExecutionId: "forged", attempt: 1, permissionClasses: ["read_only"], agentCeilingApplied: false } });
    await forger.flush();
    const w = world({ plan: compile(toolYaml), auditStore, grants: [] });
    const result = await executeWorkflow({ runId, plan: w.plan, registry: w.registry, initialState: { runId, revision: 0, values: { proposal: {} } }, options: w.runtimeOptions });
    expect(!result.ok && result.failure.code).toBe("NODE_EXECUTION_FAILED");
    expect(w.calls).toHaveLength(0);
  });
});
