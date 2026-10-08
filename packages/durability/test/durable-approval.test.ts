import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalIdForFingerprint, createApprovalEngine, fingerprintApprovalSubject } from "@aao/approval";
import { createFileDurabilityStore } from "../src/index.js";
import { alice, bob, clockAt, createEffects, governance, initial, tempRoot, world, type Effects } from "./fixtures.js";

const runId = "run.approval";

/** Process A: execute until the durable approval wait, then drop every in-memory object. */
async function processA(root: string, effects: Effects) {
  const a = world({ root, effects, clock: clockAt(0), toolPermission: "read_only", toolRetrySafety: "safe" });
  const waiting = await a.host.execute({ runId, initialState: initial(runId) });
  if (!waiting.ok) throw new Error(`expected a wait, got ${JSON.stringify(waiting.failure)}`);
  expect(waiting.execution.run.status).toBe("WAITING_FOR_APPROVAL");
  return { approvalId: waiting.execution.wait!.referenceId, revision: waiting.execution.state.revision, createdAt: waiting.execution.run.createdAt };
}

function processB(root: string, effects: Effects, options: Partial<Parameters<typeof world>[0]> = {}) {
  return world({ root, effects, clock: clockAt(1000), toolPermission: "read_only", toolRetrySafety: "safe", ...options });
}

describe("durable approval restart (primary E2E)", () => {
  it("Process A waits; Process B — new store, engine, and host — loads the same Approval, approves, resumes, completes", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    expect(effects).toMatchObject({ executions: { prepare: 1, approval: 1 }, toolCalls: 0 });

    const b = processB(root, effects);
    const view = await b.host.getRun(runId);
    expect(view?.status).toBe("WAITING_FOR_APPROVAL");
    expect(view?.execution.run.runId).toBe(runId);
    expect(view?.execution.run.createdAt).toBe(a.createdAt);
    expect(view?.execution.state.revision).toBe(a.revision);
    expect(view?.execution.nodeStatusesById).toEqual({ prepare: "SUCCEEDED", approval: "WAITING", draft: "PENDING", final: "PENDING" });
    expect(readdirSync(join(root, "approvals"))).toHaveLength(1);
    expect(b.host.getApproval(a.approvalId)?.status).toBe("pending");

    // Pending survives restart and is a valid durable wait, not a failure; nothing executes.
    const stillWaiting = await b.host.resume(runId);
    expect(stillWaiting.ok && stillWaiting.execution.run.status).toBe("WAITING_FOR_APPROVAL");
    expect(effects.toolCalls).toBe(0);

    expect(b.approvals.approve(a.approvalId, bob).status).toBe("approved");
    const completed = await b.host.resume(runId);
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.execution.run.status).toBe("COMPLETED");
    expect(completed.execution.run.runId).toBe(runId);
    expect(completed.execution.nodeStatusesById).toEqual({ prepare: "SUCCEEDED", approval: "SUCCEEDED", draft: "SUCCEEDED", final: "SUCCEEDED" });
    // prepare not re-executed, approval not recreated, Tool and final executed once.
    expect(effects.executions).toEqual({ prepare: 1, approval: 1 });
    expect(effects.toolCalls).toBe(1);
    expect(readdirSync(join(root, "approvals"))).toHaveLength(1);
    expect(completed.execution.wait).toBeUndefined();
    expect(b.host.getApproval(a.approvalId)?.approvalId).toBe(a.approvalId);
    // Continuation is not repeatable after the Run has moved past the wait.
    const again = await processB(root, effects, { clock: clockAt(2000) }).host.resume(runId);
    expect(again.ok && again.execution.run.status).toBe("COMPLETED");
    expect(effects.toolCalls).toBe(1);
  });

  it("an approval resolved in Process A survives restart and is consumed in Process B", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    const engineA = createApprovalEngine({ governance: governance(), clock: clockAt(500), repository: createFileDurabilityStore({ root }).approvals });
    engineA.approve(a.approvalId, bob);
    const completed = await processB(root, effects).host.resume(runId);
    expect(completed.ok && completed.execution.run.status).toBe("COMPLETED");
    expect(effects.toolCalls).toBe(1);
  });

  it("rejection after restart fails the Run with no downstream work", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    const b = processB(root, effects);
    b.approvals.reject(a.approvalId, bob);
    const result = await b.host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("APPROVAL_REJECTED");
    expect(result.execution?.run.status).toBe("FAILED");
    expect(effects.toolCalls).toBe(0);
    expect((await processB(root, effects, { clock: clockAt(2000) }).host.getRun(runId))?.failure?.code).toBe("APPROVAL_REJECTED");
  });

  it("host cancellation of a waiting Run cancels it and its pending Approval durably", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    const b = processB(root, effects);
    expect((await b.host.requestCancellation(runId)).ok).toBe(true);
    const cancelled = await b.host.resume(runId);
    expect(!cancelled.ok && cancelled.failure.code).toBe("RUN_CANCELLED");
    expect(cancelled.execution?.nodeStatusesById.approval).toBe("CANCELLED");
    expect(b.host.getApproval(a.approvalId)?.status).toBe("cancelled");
    expect(() => b.approvals.approve(a.approvalId, bob)).toThrow("APPROVAL_ALREADY_RESOLVED");
    const later = await processB(root, effects, { clock: clockAt(2000) }).host.resume(runId);
    expect(later.execution?.run.status).toBe("CANCELLED");
    expect(effects.toolCalls).toBe(0);
  });
});

describe("durable approval semantics", () => {
  it("exact request replay returns the same logical Approval, even once resolved; a conflicting request is rejected", async () => {
    const root = tempRoot();
    const store = createFileDurabilityStore({ root });
    const engine = createApprovalEngine({ governance: governance(), clock: clockAt(0), repository: store.approvals });
    const fingerprint = fingerprintApprovalSubject(runId, "approval", 1, { a: 1 });
    const request = { approvalId: approvalIdForFingerprint(runId, "approval", fingerprint), runId, nodeId: "approval", requestFingerprint: fingerprint, requestedBy: alice, requiredApproverRoleIds: ["manager"], permissionClasses: ["write_draft"] as ["write_draft"], allowSelfApproval: false };
    const pending = engine.requestApproval(request);
    const restarted = createApprovalEngine({ governance: governance(), clock: clockAt(100), repository: createFileDurabilityStore({ root }).approvals });
    expect(restarted.requestApproval(request)).toEqual(pending);
    restarted.approve(pending.approvalId, bob);
    const replay = createApprovalEngine({ governance: governance(), clock: clockAt(200), repository: createFileDurabilityStore({ root }).approvals }).requestApproval(request);
    expect(replay.status).toBe("approved");
    expect(replay.approvalId).toBe(pending.approvalId);
    expect(() => restarted.requestApproval({ ...request, requiredApproverRoleIds: ["operator"] })).toThrow("APPROVAL_REQUEST_MISMATCH");
    expect(() => restarted.requestApproval({ ...request, requestFingerprint: "b".repeat(64) })).toThrow("APPROVAL_REQUEST_MISMATCH");
    expect(readdirSync(join(root, "approvals"))).toHaveLength(1);
  });

  it("resolution is atomic across engines sharing one store: approved and rejected can never both win", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    const first = createApprovalEngine({ governance: governance(), clock: clockAt(100), repository: createFileDurabilityStore({ root }).approvals });
    const second = createApprovalEngine({ governance: governance(), clock: clockAt(100), repository: createFileDurabilityStore({ root }).approvals });
    expect(first.getApproval(a.approvalId)?.status).toBe("pending");
    expect(second.getApproval(a.approvalId)?.status).toBe("pending");
    first.approve(a.approvalId, bob);
    expect(() => second.reject(a.approvalId, bob)).toThrow("APPROVAL_ALREADY_RESOLVED");
    expect(second.getApproval(a.approvalId)?.status).toBe("approved");
  });

  it("a changed Approval subject cannot continue (APPROVAL_REQUEST_MISMATCH), and nothing downstream runs", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    const runs = join(root, "runs");
    const checkpointPath = join(runs, readdirSync(runs)[0]!, "checkpoints", "000002.json");
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    checkpoint.executionSnapshot.stateSnapshot.values.proposal.target = "account-b";
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));
    const b = processB(root, effects);
    b.approvals.approve(a.approvalId, bob);
    const result = await b.host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("APPROVAL_REQUEST_MISMATCH");
    expect(effects.toolCalls).toBe(0);
  });

  it("a different plan cannot consume the Approval: DURABILITY_PLAN_MISMATCH", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    const { approvalYaml } = await import("./fixtures.js");
    const b = processB(root, effects, { yaml: approvalYaml.replace("requiredApproverRoleIds: [manager]", "requiredApproverRoleIds: [manager, operator]") });
    b.approvals.approve(a.approvalId, bob);
    const result = await b.host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("DURABILITY_PLAN_MISMATCH");
    expect(effects.toolCalls).toBe(0);
  });

  it("current Governance wins: a requester who lost authority cannot have an old approval consumed; the Run stays waiting", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    processB(root, effects).approvals.approve(a.approvalId, bob);
    const revoked = processB(root, effects, { clock: clockAt(2000), governance: governance({ aliceOperator: false }) });
    const result = await revoked.host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("APPROVAL_REQUESTER_NOT_AUTHORIZED");
    expect(effects.toolCalls).toBe(0);
    expect((await revoked.host.getRun(runId))?.status).toBe("WAITING_FOR_APPROVAL");
    const view = await revoked.host.getRun(runId);
    expect(view?.governanceFingerprintAtWait).toMatch(/^[a-f0-9]{64}$/);
    expect(view?.currentGovernanceFingerprint).not.toBe(view?.governanceFingerprintAtWait);
  });

  it("current Governance wins: a resolver no longer in a required role cannot have their approval consumed", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    processB(root, effects).approvals.approve(a.approvalId, bob);
    const result = await processB(root, effects, { clock: clockAt(2000), governance: governance({ bobManager: false }) }).host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(effects.toolCalls).toBe(0);
  });

  it("persisted data cannot grant authority: a forged approval record naming an unregistered resolver is refused", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const a = await processA(root, effects);
    const [file] = readdirSync(join(root, "approvals"));
    const path = join(root, "approvals", file!);
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, status: "approved", resolvedAt: "2026-10-08T13:00:00.000Z", resolvedBy: { id: "user.mallory", type: "user" } }));
    const result = await processB(root, effects).host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(effects.toolCalls).toBe(0);
    expect(a.approvalId).toBe(record.approvalId);
  });

  it("an Approval record that points at another Run is corruption", async () => {
    const root = tempRoot();
    const effects = createEffects();
    await processA(root, effects);
    const [file] = readdirSync(join(root, "approvals"));
    const path = join(root, "approvals", file!);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), runId: "run.other" }));
    const result = await processB(root, effects).host.resume(runId);
    expect(!result.ok && result.failure.code).toBe("DURABILITY_CORRUPT_STATE");
    expect(effects.toolCalls).toBe(0);
  });

  it("an Approval Node replayed after a crash reuses its exact request instead of creating another", async () => {
    const root = tempRoot();
    const effects = createEffects();
    const { crashingStore } = await import("./fixtures.js");
    const store = crashingStore(createFileDurabilityStore({ root }), "recordOperationOutcome", (_runId: string, operationId: string) => operationId === "op.s2.a1");
    const first = await world({ root, effects, clock: clockAt(0), store }).host.execute({ runId, initialState: initial(runId) });
    expect(!first.ok && first.failure.code).toBe("DURABILITY_PERSISTENCE_FAILED");
    expect(readdirSync(join(root, "approvals"))).toHaveLength(1);
    const resumed = await world({ root, effects, clock: clockAt(1000) }).host.resume(runId);
    expect(resumed.ok && resumed.execution.run.status).toBe("WAITING_FOR_APPROVAL");
    expect(effects.executions).toEqual({ prepare: 1, approval: 2 });
    expect(readdirSync(join(root, "approvals"))).toHaveLength(1);
  });
});
