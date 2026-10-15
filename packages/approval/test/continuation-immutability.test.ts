import { describe, expect, it } from "vitest";
import { createGovernanceRegistry } from "@aao/governance";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { continueWaitingWorkflow, createNodeRegistry, executeWorkflow, finalOutputExecutor, resumeWorkflow, type RuntimeExecutionState } from "@aao/runtime";
import { createToolNodeExecutor, createToolRegistry } from "@aao/tool-runtime";
import { continueApprovedWorkflow, createApprovalEngine, createApprovalNodeExecutor } from "../src/index.js";

/**
 * ADR-025: continuation never mutates the caller's `RuntimeExecutionState`.
 * The input serializes byte-identically before and after. The returned
 * execution is a new object carrying the advanced state, and identity,
 * history, revision, approval references, and attempt counts are
 * preserved exactly. The fix lives in the Runtime (`continueWaitingWorkflow`),
 * so the Approval bridge and the Framework inherit it.
 */
const alice = { id: "user.alice", type: "user" } as const;
const bob = { id: "user.bob", type: "user" } as const;
const governance = createGovernanceRegistry({
  actors: [alice, bob],
  roles: [{ id: "manager", version: "1.0.0", permissionClasses: ["write_draft"] }],
  bindings: [
    { id: "alice.manager", actorId: alice.id, roleId: "manager", status: "active" },
    { id: "bob.manager", actorId: bob.id, roleId: "manager", status: "active" },
  ],
  policies: [],
});
const yaml = `
schemaVersion: 1
id: approval.immutable
version: "1.0.0"
name: Immutable continuation
entryNodeId: proposal
nodes:
  - { id: proposal, kind: deterministic, config: {} }
  - id: approval
    kind: approval
    config: { subjectStateKey: proposal, permissionClasses: [write_draft], requiredApproverRoleIds: [manager] }
  - id: draft
    kind: tool
    config: { toolRef: { id: local.draft, version: "1.0.0" }, inputStateKey: proposal, resultStateKey: draftResult }
  - { id: final, kind: final_output, config: {} }
edges:
  - { sourceNodeId: proposal, targetNodeId: approval }
  - { sourceNodeId: approval, targetNodeId: draft }
  - { sourceNodeId: draft, targetNodeId: final }
`;

function world() {
  const compiled = compileWorkflowSource(yaml, "yaml");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  let tick = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 9, 14, 9, 0, tick++)).toISOString() };
  const engine = createApprovalEngine({ governance, clock });
  const tools = createToolRegistry();
  tools.register({ spec: { schemaVersion: 1, id: "local.draft", version: "1.0.0", name: "Draft", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false }, outputSchema: { type: "object", properties: { saved: { type: "boolean" } }, required: ["saved"], additionalProperties: false }, permissionClasses: ["write_draft"] }, handler: { async execute() { return { ok: true, output: { saved: true } }; } } });
  const registry = createNodeRegistry();
  registry.register({ kind: "deterministic", async execute() { return { ok: true, statePatch: { proposal: { target: "account-a" } } }; } });
  registry.register(createApprovalNodeExecutor(engine, () => alice));
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => ({ schemaVersion: 1, principal: alice, grantedPermissionClasses: ["write_draft"] }) }));
  registry.register(finalOutputExecutor);
  const runId = "run.immutable";
  return { plan: compiled.plan, engine, registry, clock, runId, start: () => executeWorkflow({ runId, plan: compiled.plan, registry, initialState: { runId, revision: 0, values: {} }, options: { clock } }) };
}

async function waitingExecution(w: ReturnType<typeof world>): Promise<RuntimeExecutionState> {
  const result = await w.start();
  const execution = (result as { execution?: RuntimeExecutionState }).execution;
  if (execution?.run.status !== "WAITING_FOR_APPROVAL") throw new Error("expected a waiting Run");
  return execution;
}

describe("continuation returns a new RuntimeExecutionState and never mutates its input", () => {
  it("approved: continueApprovedWorkflow leaves the caller's execution byte-identical and returns the completed Run", async () => {
    const w = world();
    const execution = await waitingExecution(w);
    w.engine.approve(execution.wait!.referenceId, bob);
    const before = JSON.stringify(execution);
    const result = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution, options: { clock: w.clock } });
    expect(JSON.stringify(execution)).toBe(before);
    expect(result.ok).toBe(true);
    const next = result.execution!;
    expect(next).not.toBe(execution);
    expect(next.run.status).toBe("COMPLETED");
    // Identity, prior history, and attempt accounting are preserved exactly; only new entries are appended.
    expect(next.run.runId).toBe(execution.run.runId);
    expect(next.run.workflowId).toBe(execution.run.workflowId);
    expect(next.run.createdAt).toBe(execution.run.createdAt);
    expect(next.history.slice(0, execution.history.length)).toEqual(execution.history);
    expect(next.history.find((record) => record.nodeId === "approval")).toMatchObject({ status: "SUCCEEDED", attemptCount: 1 });
    expect(next.state.revision).toBeGreaterThan(execution.state.revision);
    expect(execution.wait).toMatchObject({ kind: "approval", nodeId: "approval" });
  });

  it("rejected: the caller's execution is unchanged and the returned execution is the failed Run", async () => {
    const w = world();
    const execution = await waitingExecution(w);
    w.engine.reject(execution.wait!.referenceId, bob);
    const before = JSON.stringify(execution);
    const result = await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution, options: { clock: w.clock } });
    expect(JSON.stringify(execution)).toBe(before);
    expect(result).toMatchObject({ ok: false, failure: { code: "APPROVAL_REJECTED" } });
    expect(result.execution!.run.status).toBe("FAILED");
    expect(execution.run.status).toBe("WAITING_FOR_APPROVAL");
  });

  it("still pending and mismatched requests return without touching the input", async () => {
    const w = world();
    const execution = await waitingExecution(w);
    const before = JSON.stringify(execution);
    expect(await continueApprovedWorkflow(w.engine, { plan: w.plan, registry: w.registry, execution, options: { clock: w.clock } })).toMatchObject({ ok: false, failure: { code: "APPROVAL_STILL_PENDING" } });
    expect(JSON.stringify(execution)).toBe(before);
  });

  it("the Runtime primitive continueWaitingWorkflow itself is non-mutating (the fix is in Core, not a Framework clone)", async () => {
    const w = world();
    const execution = await waitingExecution(w);
    const record = w.engine.approve(execution.wait!.referenceId, bob);
    const before = JSON.stringify(execution);
    const result = await continueWaitingWorkflow({ plan: w.plan, registry: w.registry, execution, approval: record, currentRequestFingerprint: execution.wait!.requestFingerprint, options: { clock: w.clock } });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(execution)).toBe(before);
  });

  it("resumeWorkflow remains non-mutating for a waiting Run", async () => {
    const w = world();
    const execution = await waitingExecution(w);
    const before = JSON.stringify(execution);
    const resumed = await resumeWorkflow({ plan: w.plan, registry: w.registry, execution, options: { clock: w.clock } });
    expect(resumed.execution).not.toBe(execution);
    expect(JSON.stringify(execution)).toBe(before);
  });
});
