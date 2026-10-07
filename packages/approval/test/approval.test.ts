import { describe, expect, it } from "vitest";
import { ApprovalRecordSchema, type PermissionClass } from "@aao/contracts";
import { authorizationContextFromAuthority, agentAuthorityFromSpec } from "@aao/authorization";
import { createGovernanceRegistry, resolveAuthority } from "@aao/governance";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { RuntimeExecutionSnapshotSchema, createNodeRegistry, executeWorkflow, finalOutputExecutor, validateSnapshotAgainstPlan } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry, executeTool } from "@aao/tool-runtime";
import { approvalIdForFingerprint, continueApprovedWorkflow, createApprovalEngine, createApprovalNodeExecutor, fingerprintApprovalSubject } from "../src/index.js";

const alice = { id: "user.alice", type: "user" } as const;
const bob = { id: "user.bob", type: "user" } as const;
const charlie = { id: "user.charlie", type: "user" } as const;
const dana = { id: "user.dana", type: "user" } as const;
const service = { id: "service.one", type: "service" } as const;
const system = { id: "system.one", type: "system" } as const;
const governance = createGovernanceRegistry({
  actors: [alice, bob, charlie, dana, service, system],
  roles: [
    { id: "operator", version: "1.0.0", permissionClasses: ["write_draft"] },
    { id: "manager", version: "1.0.0", permissionClasses: ["write_draft"] },
    { id: "researcher", version: "1.0.0", permissionClasses: ["read_only"] },
    { id: "reviewer", version: "1.0.0", permissionClasses: ["write_draft"] },
  ],
  bindings: [
    { id: "alice.operator", actorId: alice.id, roleId: "operator", status: "active" },
    { id: "alice.manager", actorId: alice.id, roleId: "manager", status: "active" },
    { id: "bob.manager", actorId: bob.id, roleId: "manager", status: "active" },
    { id: "charlie.researcher", actorId: charlie.id, roleId: "researcher", status: "active" },
    { id: "dana.reviewer", actorId: dana.id, roleId: "reviewer", status: "active" },
    { id: "service.manager", actorId: service.id, roleId: "manager", status: "active" },
    { id: "system.manager", actorId: system.id, roleId: "manager", status: "active" },
  ], policies: [],
});
function clock() { let tick = 0; return { now: () => new Date(Date.UTC(2026, 8, 30, 12, 0, tick++)).toISOString() }; }
const yaml = `
schemaVersion: 1
id: approval.safe-draft
version: "1.0.0"
name: Approval safe draft
entryNodeId: proposal
nodes:
  - id: proposal
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
  - { sourceNodeId: proposal, targetNodeId: approval }
  - { sourceNodeId: approval, targetNodeId: draft }
  - { sourceNodeId: draft, targetNodeId: final }
`;
function world(options: { grants?: string[]; yaml?: string } = {}) {
  const compiled = compileWorkflowSource(options.yaml ?? yaml, "yaml");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const runtimeClock = clock();
  const engine = createApprovalEngine({ governance, clock: runtimeClock });
  const tools = createToolRegistry();
  let calls = 0;
  tools.register({ spec: { schemaVersion: 1, id: "local.draft", version: "1.0.0", name: "Draft", inputSchema: { type: "object", properties: { action: { type: "string" }, target: { type: "string" } }, required: ["action", "target"], additionalProperties: false }, outputSchema: { type: "object", properties: { saved: { type: "boolean" } }, required: ["saved"], additionalProperties: false }, permissionClasses: ["write_draft"] }, handler: { async execute() { calls++; return { ok: true, output: { saved: true } }; } } });
  const registry = createNodeRegistry();
  registry.register({ kind: "deterministic", async execute() { return { ok: true, statePatch: { proposal: { action: "prepare-draft", target: "account-a" } } }; } });
  registry.register(createApprovalNodeExecutor(engine, () => alice));
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: (options.grants ?? ["write_draft"]) as ["write_draft"] }) }));
  registry.register(finalOutputExecutor);
  const runId = "run.approval";
  return { plan: compiled.plan, engine, registry, runtimeClock, runId, calls: () => calls, start: () => executeWorkflow({ runId, plan: compiled.plan, registry, initialState: { runId, revision: 0, values: {} }, options: { clock: runtimeClock } }) };
}

describe("approval engine", () => {
  it("binds canonical material, creates idempotently, and keeps terminal records immutable", () => {
    const engine = createApprovalEngine({ governance, clock: clock() });
    const fingerprint = fingerprintApprovalSubject("run.one", "approval", 1, { b: 2, a: 1 });
    expect(fingerprint).toBe(fingerprintApprovalSubject("run.one", "approval", 1, { a: 1, b: 2 }));
    expect(fingerprint).not.toBe(fingerprintApprovalSubject("run.one", "approval", 2, { a: 1, b: 2 }));
    const request = { approvalId: approvalIdForFingerprint("run.one", "approval", fingerprint), runId: "run.one", nodeId: "approval", requestFingerprint: fingerprint, requestedBy: alice, requiredApproverRoleIds: ["manager"], permissionClasses: ["write_draft"] as ["write_draft"], allowSelfApproval: false };
    const pending = engine.requestApproval(request);
    expect(ApprovalRecordSchema.parse(pending)).toEqual(pending);
    expect(engine.requestApproval(request)).toBe(pending);
    expect(() => engine.requestApproval({ ...request, requestFingerprint: "b".repeat(64) })).toThrow("APPROVAL_REQUEST_MISMATCH");
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.permissionClasses)).toBe(true);
    for (const actor of [service, system]) expect(() => engine.approve(pending.approvalId, actor)).toThrow("APPROVAL_HUMAN_REQUIRED");
    for (const forged of [{ id: "model.one", type: "model" }, { id: "agent.one", type: "agent" }, { id: "workflow.one", type: "workflow" }, { id: "tool.one", type: "tool" }, { id: "mcp.one", type: "mcp" }, { id: "memory.one", type: "memory" }, { id: "user.bob", type: "user", roleIds: ["manager"] }]) expect(() => engine.approve(pending.approvalId, forged as never)).toThrow("APPROVAL_HUMAN_REQUIRED");
    expect(() => engine.approve(pending.approvalId, charlie)).toThrow("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(() => engine.approve(pending.approvalId, dana)).toThrow("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(() => engine.approve(pending.approvalId, alice)).toThrow("APPROVAL_SELF_APPROVAL_FORBIDDEN");
    const approved = engine.approve(pending.approvalId, bob);
    expect(approved.status).toBe("approved");
    expect(() => engine.reject(pending.approvalId, alice)).toThrow("APPROVAL_ALREADY_RESOLVED");
    expect(engine.getApproval(pending.approvalId)).toBe(approved);
  });

  it("approver eligibility uses trusted role membership, not the requester's action permissions", () => {
    const erin = { id: "user.erin", type: "user" } as const;
    const frank = { id: "user.frank", type: "user" } as const;
    const gina = { id: "user.gina", type: "user" } as const;
    const decoupled = createGovernanceRegistry({
      actors: [alice, bob, erin, frank, gina],
      roles: [
        { id: "operator", version: "1.0.0", permissionClasses: ["write_draft"] },
        { id: "manager", version: "1.0.0", permissionClasses: ["read_only"] },
        { id: "auditor", version: "1.0.0", permissionClasses: ["read_only"] },
      ],
      bindings: [
        { id: "alice.operator", actorId: alice.id, roleId: "operator", status: "active" },
        { id: "bob.manager", actorId: bob.id, roleId: "manager", status: "active" },
        { id: "erin.auditor", actorId: erin.id, roleId: "auditor", status: "active" },
        { id: "frank.manager", actorId: frank.id, roleId: "manager", status: "inactive" },
        { id: "gina.operator", actorId: gina.id, roleId: "operator", status: "active" },
      ],
      policies: [{ id: "deny.manager.read", rules: [{ id: "manager.read", effect: "DENY", permissionClasses: ["read_only"], roleIds: ["manager"] }] }],
    });
    expect(resolveAuthority(decoupled, bob, ["write_draft"]).decision).toBe("DENY");
    const engine = createApprovalEngine({ governance: decoupled, clock: clock() });
    const base = { runId: "run.decoupled", nodeId: "approval", requestFingerprint: "d".repeat(64), requestedBy: alice, requiredApproverRoleIds: ["manager"], permissionClasses: ["write_draft"] as ["write_draft"], allowSelfApproval: false };
    const pending = engine.requestApproval({ ...base, approvalId: "approval.decoupled" });
    for (const ineligible of [erin, frank, gina, { id: "user.unknown", type: "user" } as const]) expect(() => engine.approve(pending.approvalId, ineligible)).toThrow("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(engine.approve(pending.approvalId, bob)).toMatchObject({ status: "approved", resolvedBy: bob });
    const rejectable = engine.requestApproval({ ...base, approvalId: "approval.decoupled.reject" });
    expect(engine.reject(rejectable.approvalId, bob).status).toBe("rejected");
    expect(() => engine.requestApproval({ ...base, approvalId: "approval.bob.request", requestedBy: bob })).toThrow("APPROVAL_REQUESTER_NOT_AUTHORIZED");
  });

  it("enforces contract lifecycle evidence", () => {
    const base = { schemaVersion: 2, approvalId: "approval.test", runId: "run.test", nodeId: "approval", requestFingerprint: "a".repeat(64), requestedBy: alice, requiredApproverRoleIds: ["manager"], allowSelfApproval: false, permissionClasses: ["write_draft"], requestedAt: "2026-09-30T12:00:00Z" };
    expect(ApprovalRecordSchema.safeParse({ ...base, status: "pending" }).success).toBe(true);
    for (const status of ["approved", "rejected"]) {
      expect(ApprovalRecordSchema.safeParse({ ...base, status, resolvedAt: "2026-09-30T12:01:00Z", resolvedBy: bob }).success).toBe(true);
      expect(ApprovalRecordSchema.safeParse({ ...base, status, resolvedAt: "2026-09-30T12:01:00Z" }).success).toBe(false);
    }
    for (const status of ["expired", "cancelled"]) expect(ApprovalRecordSchema.safeParse({ ...base, status, resolvedAt: "2026-09-30T12:01:00Z" }).success).toBe(true);
    expect(ApprovalRecordSchema.safeParse({ ...base, status: "pending", resolvedBy: bob }).success).toBe(false);
    expect(ApprovalRecordSchema.safeParse({ ...base, status: "expired" }).success).toBe(false);
    expect(ApprovalRecordSchema.safeParse({ ...base, status: "approved", resolvedBy: bob, resolvedAt: "2026-09-30T11:59:00Z" }).success).toBe(false);
    expect(ApprovalRecordSchema.safeParse({ ...base, status: "pending", requestFingerprint: "" }).success).toBe(false);
  });

  it("allows an explicitly trusted self-approval exception and deterministic expiry/cancellation", () => {
    const engine = createApprovalEngine({ governance, clock: clock() });
    const base = { runId: "run.self", nodeId: "approval", requestFingerprint: "c".repeat(64), requestedBy: alice, requiredApproverRoleIds: ["manager"], permissionClasses: ["write_draft"] as ["write_draft"], allowSelfApproval: true };
    const self = engine.requestApproval({ ...base, approvalId: "approval.self" });
    expect(engine.approve(self.approvalId, alice).resolvedBy).toEqual(alice);
    expect(() => engine.expire(self.approvalId)).toThrow("APPROVAL_ALREADY_RESOLVED");
    const expired = engine.requestApproval({ ...base, approvalId: "approval.expired" });
    expect(engine.expire(expired.approvalId).status).toBe("expired");
    const cancelled = engine.requestApproval({ ...base, approvalId: "approval.cancelled" });
    expect(engine.cancel(cancelled.approvalId).status).toBe("cancelled");
    expect(() => engine.approve(cancelled.approvalId, bob)).toThrow("APPROVAL_ALREADY_RESOLVED");
  });
});

describe("approval workflow", () => {
  it("waits, rejects unauthorized/self/nonhuman decisions, then approves and executes safe Tool once", async () => {
    const w = world();
    const waiting = await w.start();
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    expect(waiting.execution.run.status).toBe("WAITING_FOR_APPROVAL");
    expect(waiting.execution.nodeStatusesById).toEqual({ proposal: "SUCCEEDED", approval: "WAITING", draft: "PENDING", final: "PENDING" });
    expect(waiting.execution.state.revision).toBe(1);
    expect(w.calls()).toBe(0);
    expect(waiting.latestSnapshot.wait).toEqual(waiting.execution.wait);
    expect(RuntimeExecutionSnapshotSchema.parse(JSON.parse(JSON.stringify(waiting.latestSnapshot)))).toEqual(waiting.latestSnapshot);
    expect(validateSnapshotAgainstPlan(waiting.latestSnapshot, w.plan)).toBeUndefined();
    const id = waiting.execution.wait!.referenceId;
    expect(w.engine.getApproval(id)?.status).toBe("pending");
    expect(JSON.stringify(w.engine.getApproval(id))).not.toContain("account-a");
    const pending = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: { clock: w.runtimeClock } });
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.failure.code).toBe("APPROVAL_STILL_PENDING");
    for (const actor of [service, system]) expect(() => w.engine.approve(id, actor)).toThrow("APPROVAL_HUMAN_REQUIRED");
    expect(() => w.engine.approve(id, charlie)).toThrow("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(() => w.engine.approve(id, dana)).toThrow("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(() => w.engine.approve(id, alice)).toThrow("APPROVAL_SELF_APPROVAL_FORBIDDEN");
    expect(waiting.execution.run.status).toBe("WAITING_FOR_APPROVAL");
    w.engine.approve(id, bob);
    const completed = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: { clock: w.runtimeClock } });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.execution.run.status).toBe("COMPLETED");
    expect(completed.execution.nodeStatusesById).toEqual({ proposal: "SUCCEEDED", approval: "SUCCEEDED", draft: "SUCCEEDED", final: "SUCCEEDED" });
    expect(completed.execution.state.revision).toBe(2);
    expect(w.calls()).toBe(1);
    const replay = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: { clock: w.runtimeClock } });
    expect(replay.ok).toBe(false);
    expect(w.calls()).toBe(1);
  });

  it.each(["reject", "expire", "cancel"] as const)("%s terminates without downstream work", async (decision) => {
    const w = world(); const waiting = await w.start(); if (!waiting.ok) throw new Error("wait failed");
    const id = waiting.execution.wait!.referenceId;
    if (decision === "reject") w.engine.reject(id, bob);
    else if (decision === "expire") w.engine.expire(id);
    else w.engine.cancel(id);
    const result = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: { clock: w.runtimeClock } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe(decision === "reject" ? "APPROVAL_REJECTED" : decision === "expire" ? "APPROVAL_EXPIRED" : "APPROVAL_CANCELLED");
    expect(result.execution?.run.status).toBe(decision === "cancel" ? "CANCELLED" : "FAILED");
    expect(result.execution?.nodeStatusesById.approval).toBe(decision === "cancel" ? "CANCELLED" : "FAILED");
    expect(result.execution?.nodeStatusesById.draft).toBe("PENDING");
    expect(w.calls()).toBe(0);
  });

  it("rejects changed subject before downstream invocation", async () => {
    const w = world(); const waiting = await w.start(); if (!waiting.ok) throw new Error("wait failed");
    w.engine.approve(waiting.execution.wait!.referenceId, bob);
    waiting.execution.state.values.proposal = { action: "prepare-draft", target: "account-b" };
    const result = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: { clock: w.runtimeClock } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("APPROVAL_REQUEST_MISMATCH");
    expect(w.calls()).toBe(0);
  });

  it("rejects a copied waiting execution after the same request was consumed", async () => {
    const w = world(); const waiting = await w.start(); if (!waiting.ok) throw new Error("wait failed");
    const copy = structuredClone(waiting.execution);
    w.engine.approve(waiting.execution.wait!.referenceId, bob);
    const first = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: { clock: w.runtimeClock } });
    expect(first.ok).toBe(true);
    const second = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: copy, options: { clock: w.runtimeClock } });
    expect(second.ok).toBe(false);
    expect(w.calls()).toBe(1);
  });

  it.each([
    "permissionClasses: [write_draft]\n      requiredApproverRoleIds: [manager]",
    "subjectStateKey: proposal\n      permissionClasses: []\n      requiredApproverRoleIds: [manager]",
    "subjectStateKey: proposal\n      permissionClasses: [write_draft, write_draft]\n      requiredApproverRoleIds: [manager]",
    "subjectStateKey: proposal\n      permissionClasses: [unknown]\n      requiredApproverRoleIds: [manager]",
    "subjectStateKey: proposal\n      permissionClasses: [write_draft]\n      requiredApproverRoleIds: []",
    "subjectStateKey: proposal\n      permissionClasses: [write_draft]\n      requiredApproverRoleIds: [manager]\n      identity: user.bob",
  ])("rejects invalid static approval configuration before proposal execution", async (config) => {
    const malformed = yaml.replace("subjectStateKey: proposal\n      permissionClasses: [write_draft]\n      requiredApproverRoleIds: [manager]", config);
    const w = world({ yaml: malformed });
    const result = await w.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(result.execution?.nodeStatusesById.proposal).toBe("PENDING");
    expect(w.calls()).toBe(0);
  });

  it("approved decision cannot give the Tool a missing write_draft grant", async () => {
    const w = world({ grants: [] }); const waiting = await w.start(); if (!waiting.ok) throw new Error("wait failed");
    w.engine.approve(waiting.execution.wait!.referenceId, bob);
    const result = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: { clock: w.runtimeClock } });
    expect(result.ok).toBe(false);
    expect(w.calls()).toBe(0);
    if (!result.ok) expect(result.failure.executorFailure?.code).toBe("TOOL_AUTHORIZATION_DENIED");
  });

  it("rejects malformed waiting snapshots and preserves the exact wait descriptor through JSON", async () => {
    const w = world(); const waiting = await w.start(); if (!waiting.ok) throw new Error("wait failed");
    const snapshot = JSON.parse(JSON.stringify(waiting.latestSnapshot));
    expect(validateSnapshotAgainstPlan(snapshot, w.plan)).toBeUndefined();
    for (const changed of [
      { ...snapshot, wait: undefined },
      { ...snapshot, wait: { ...snapshot.wait, referenceId: undefined } },
      { ...snapshot, nodeStatusesById: { ...snapshot.nodeStatusesById, approval: "READY" } },
      { ...snapshot, run: { ...snapshot.run, status: "RUNNING" } },
      { ...snapshot, nodeStatusesById: { ...snapshot.nodeStatusesById, draft: "RUNNING" } },
    ]) expect(RuntimeExecutionSnapshotSchema.safeParse(changed).success).toBe(false);
    expect(snapshot.stateSnapshot.revision).toBe(1);
    expect(snapshot.run.currentNodeId).toBe("approval");
    expect(snapshot.step).toBe(2);
  });

  it("approved evidence cannot override Governance DENY or an Agent ceiling", async () => {
    const w = world(); const waiting = await w.start(); if (!waiting.ok) throw new Error("wait failed");
    expect(w.engine.approve(waiting.execution.wait!.referenceId, bob).status).toBe("approved");
    const tools = createToolRegistry(); let calls = 0;
    tools.register({ spec: { schemaVersion: 1, id: "local.draft2", version: "1.0.0", name: "Draft", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["write_draft"] }, handler: { async execute() { calls++; return { ok: true, output: {} }; } } });
    const request = { schemaVersion: 1, toolExecutionId: "tool.after.approval", toolRef: { id: "local.draft2", version: "1.0.0" }, input: {} };
    const denying = createGovernanceRegistry({ actors: [alice], roles: [{ id: "operator", version: "1.0.0", permissionClasses: ["write_draft"] }], bindings: [{ id: "alice.operator", actorId: alice.id, roleId: "operator", status: "active" }], policies: [{ id: "deny.draft", rules: [{ id: "draft", effect: "DENY", permissionClasses: ["write_draft"] }] }] });
    const decision = resolveAuthority(denying, alice, ["write_draft"]);
    expect(decision.decision).toBe("DENY");
    const denied = await executeTool({ tools, request, authorizationContext: authorizationContextFromAuthority(decision.authority!) });
    expect(denied.ok).toBe(false);
    const allowed = resolveAuthority(governance, alice, ["write_draft"]);
    const ceiling = agentAuthorityFromSpec({ id: "agent.read", version: "1.0.0", permissionClasses: ["read_only"] });
    const limited = await executeTool({ tools, request, authorizationContext: authorizationContextFromAuthority(allowed.authority!, ceiling) });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.failure.authorizationReasonCode).toBe("AGENT_PERMISSION_CEILING_EXCEEDED");
    expect(calls).toBe(0);
  });

  it.each(["external_side_effect", "destructive", "sensitive_data"] as PermissionClass[])("keeps %s unsupported after approval", async (permissionClass) => {
    const w = world(); const waiting = await w.start(); if (!waiting.ok) throw new Error("wait failed");
    expect(w.engine.approve(waiting.execution.wait!.referenceId, bob).status).toBe("approved");
    const tools = createToolRegistry(); let calls = 0;
    tools.register({ spec: { schemaVersion: 1, id: "local.unsupported", version: "1.0.0", name: "Unsupported", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: [permissionClass] }, handler: { async execute() { calls++; return { ok: true, output: {} }; } } });
    const result = await executeTool({ tools, request: { schemaVersion: 1, toolExecutionId: "tool.unsupported", toolRef: { id: "local.unsupported", version: "1.0.0" }, input: {} }, authorizationContext: { schemaVersion: 1, principal: alice, grantedPermissionClasses: [permissionClass] } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("TOOL_PERMISSION_UNSUPPORTED");
    expect(calls).toBe(0);
  });
});

describe("approval + runtime reliability (Sprint 13)", () => {
  const reliableYaml = yaml.replace("toolRef: { id: local.draft, version: \"1.0.0\" }", "toolRef: { id: local.lookup, version: \"1.0.0\" }");
  function reliableWorld(script: Array<{ ok: true; output: unknown } | { ok: false; code: string; retryable?: true }>, toolOptions: { permissionClasses?: PermissionClass[]; retrySafety?: "safe" } = {}) {
    const compiled = compileWorkflowSource(reliableYaml, "yaml");
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const runtimeClock = clock();
    const engine = createApprovalEngine({ governance, clock: runtimeClock });
    const tools = createToolRegistry();
    let toolCalls = 0;
    tools.register({ spec: { schemaVersion: 1, id: "local.lookup", version: "1.0.0", name: "Lookup", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: toolOptions.permissionClasses ?? ["read_only"] }, ...(toolOptions.retrySafety ? { retrySafety: toolOptions.retrySafety } : {}), handler: { async execute() { return script[Math.min(toolCalls++, script.length - 1)]! as never; } } });
    let proposalExecutions = 0;
    let approvalExecutions = 0;
    const approvalExecutor = createApprovalNodeExecutor(engine, () => alice);
    const registry = createNodeRegistry();
    registry.register({ kind: "deterministic", async execute() { proposalExecutions++; return { ok: true, statePatch: { proposal: { action: "lookup", target: "account-a" } } }; } });
    registry.register({ ...approvalExecutor, async execute(context) { approvalExecutions++; return approvalExecutor.execute(context); } });
    registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ["read_only", "write_draft", "external_side_effect"] }) }));
    registry.register(finalOutputExecutor);
    const delays: number[] = [];
    const options = { clock: runtimeClock, sleeper: { sleep: async (ms: number) => { delays.push(ms); } }, reliability: { policiesByNodeId: { draft: { maxAttempts: 3, retryDelayMs: 20 } } } };
    const runId = "run.approval.reliable";
    return { plan: compiled.plan, engine, registry, options, delays, counts: () => ({ toolCalls, proposalExecutions, approvalExecutions }), start: () => executeWorkflow({ runId, plan: compiled.plan, registry, initialState: { runId, revision: 0, values: {} }, options }) };
  }

  it("wait → approve → continue → Tool transient → Runtime retry → success; nothing upstream replays", async () => {
    const w = reliableWorld([{ ok: false, code: "DEPENDENCY_TEMPORARILY_UNAVAILABLE", retryable: true }, { ok: true, output: { found: true } }], { retrySafety: "safe" });
    const waiting = await w.start();
    if (!waiting.ok) throw new Error("wait failed");
    expect(waiting.execution.run.status).toBe("WAITING_FOR_APPROVAL");
    expect(w.counts()).toEqual({ toolCalls: 0, proposalExecutions: 1, approvalExecutions: 1 });
    w.engine.approve(waiting.execution.wait!.referenceId, bob);
    const completed = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: w.options });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(w.counts()).toEqual({ toolCalls: 2, proposalExecutions: 1, approvalExecutions: 1 });
    expect(w.delays).toEqual([20]);
    expect(completed.execution.run.status).toBe("COMPLETED");
    expect(completed.execution.state.revision).toBe(2);
    expect(completed.execution.history.map((record) => [record.nodeId, record.status, record.attemptCount])).toEqual([["proposal", "SUCCEEDED", 1], ["approval", "SUCCEEDED", 1], ["draft", "SUCCEEDED", 2], ["final", "SUCCEEDED", 1]]);
    expect(completed.execution.state.values.draftResult).toMatchObject({ output: { found: true } });
    const replay = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: w.options });
    expect(replay.ok).toBe(false);
    expect(w.counts()).toEqual({ toolCalls: 2, proposalExecutions: 1, approvalExecutions: 1 });
  });

  it("an Approval Node can never carry a retry policy, at start or at continuation; a bad continuation leaves the approval usable", async () => {
    const w = reliableWorld([{ ok: true, output: {} }], { retrySafety: "safe" });
    const bad = { ...w.options, reliability: { policiesByNodeId: { approval: { maxAttempts: 2 } } } };
    const rejected = await executeWorkflow({ runId: "run.approval.retry", plan: w.plan, registry: w.registry, initialState: { runId: "run.approval.retry", revision: 0, values: {} }, options: bad });
    expect(!rejected.ok && rejected.failure.code).toBe("INVALID_RUNTIME_INPUT");
    expect(w.counts().proposalExecutions).toBe(0);
    const waiting = await w.start();
    if (!waiting.ok) throw new Error("wait failed");
    w.engine.approve(waiting.execution.wait!.referenceId, bob);
    const badContinuation = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: bad });
    expect(!badContinuation.ok && badContinuation.failure.code).toBe("INVALID_RUNTIME_INPUT");
    expect(waiting.execution.run.status).toBe("WAITING_FOR_APPROVAL");
    const completed = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: w.options });
    expect(completed.ok).toBe(true);
    expect(w.counts()).toEqual({ toolCalls: 1, proposalExecutions: 1, approvalExecutions: 1 });
  });

  it("rejection is a terminal APPROVAL failure; downstream retry policy creates no execution", async () => {
    const w = reliableWorld([{ ok: true, output: {} }], { retrySafety: "safe" });
    const waiting = await w.start();
    if (!waiting.ok) throw new Error("wait failed");
    w.engine.reject(waiting.execution.wait!.referenceId, bob);
    const result = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution: waiting.execution, options: w.options });
    expect(!result.ok && result.failure).toMatchObject({ code: "APPROVAL_REJECTED", category: "APPROVAL", retryable: false });
    expect(w.counts().toolCalls).toBe(0);
  });

  it("approved workflow + external_side_effect Tool + maxAttempts 3 → unsupported, zero handler calls", async () => {
    const w = reliableWorld([{ ok: true, output: {} }], { permissionClasses: ["external_side_effect"] });
    const result = await w.start();
    expect(!result.ok && result.failure.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(JSON.stringify(!result.ok && result.failure)).toContain("TOOL_PERMISSION_UNSUPPORTED");
    expect(w.counts()).toEqual({ toolCalls: 0, proposalExecutions: 0, approvalExecutions: 0 });
  });
});
