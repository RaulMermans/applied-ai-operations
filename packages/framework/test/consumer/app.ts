// A consumer application of AAO. It imports ONLY the public `@aao/framework`
// package — no deep imports, no relative repository imports, no lower-level
// @aao/* package. The vitest E2E runs it against source; the compiled smoke
// compiles it with tsc against the package's dist declarations and runs it
// on dist JavaScript.
import { createAAO, defineGovernance, defineTool, defineWorkflow, type AAOApp, type Principal, type WorkflowExecutionResult } from "@aao/framework";

export const alice: Principal = { id: "user.alice", type: "user" }; // operator: requests work
export const bob: Principal = { id: "user.bob", type: "user" }; // manager: approves
export const mallory: Principal = { id: "user.mallory", type: "user" }; // viewer: read-only

export const governance = defineGovernance({
  actors: [alice, bob, mallory],
  roles: [
    { id: "operator", version: "1.0.0", permissionClasses: ["read_only", "write_draft", "external_side_effect"] },
    { id: "manager", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
    { id: "viewer", version: "1.0.0", permissionClasses: ["read_only"] },
  ],
  bindings: [
    { id: "alice.operator", actorId: alice.id, roleId: "operator", status: "active" },
    { id: "bob.manager", actorId: bob.id, roleId: "manager", status: "active" },
    { id: "mallory.viewer", actorId: mallory.id, roleId: "viewer", status: "active" },
  ],
  policies: [],
});

/** Handler invocations per Tool — what the E2E asserts. */
export const calls = { draft: 0, email: 0 };

export const draftTool = defineTool({
  spec: {
    schemaVersion: 1,
    id: "crm.draft-update",
    version: "1.0.0",
    name: "Draft a CRM account update",
    inputSchema: { type: "object", properties: { account: { type: "string" }, change: { type: "string" } }, required: ["account", "change"], additionalProperties: false },
    outputSchema: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"], additionalProperties: false },
    permissionClasses: ["write_draft"],
  },
  handler: {
    async execute({ input }) {
      calls.draft += 1;
      const { account } = input as { account: string };
      return { ok: true, output: { draftId: `draft-${account}` } };
    },
  },
});

/** Refused by the Tool Runtime V1 support gate whatever the grants: external side effects are unsupported. */
export const emailTool = defineTool({
  spec: {
    schemaVersion: 1,
    id: "crm.send-email",
    version: "1.0.0",
    name: "Send an email",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    permissionClasses: ["external_side_effect"],
  },
  handler: {
    async execute() {
      calls.email += 1;
      return { ok: true, output: { sent: true } };
    },
  },
});

/** Approval → Tool → final_output: the manager approves the exact proposal before the draft is written. */
export const approvedUpdate = defineWorkflow({
  schemaVersion: 1,
  id: "consumer.account-update",
  version: "1.0.0",
  name: "Approved account update",
  entryNodeId: "approve",
  nodes: [
    { id: "approve", kind: "approval", config: { subjectStateKey: "proposal", permissionClasses: ["write_draft"], requiredApproverRoleIds: ["manager"] } },
    { id: "draft", kind: "tool", config: { toolRef: { id: "crm.draft-update", version: "1.0.0" }, inputStateKey: "proposal", resultStateKey: "draft" } },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [
    { sourceNodeId: "approve", targetNodeId: "draft" },
    { sourceNodeId: "draft", targetNodeId: "final" },
  ],
});

export const directDraft = defineWorkflow({
  schemaVersion: 1,
  id: "consumer.direct-draft",
  version: "1.0.0",
  name: "Direct draft",
  entryNodeId: "draft",
  nodes: [
    { id: "draft", kind: "tool", config: { toolRef: { id: "crm.draft-update", version: "1.0.0" }, inputStateKey: "proposal", resultStateKey: "draft" } },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "draft", targetNodeId: "final" }],
});

export const sendEmail = defineWorkflow({
  schemaVersion: 1,
  id: "consumer.send-email",
  version: "1.0.0",
  name: "Send email",
  entryNodeId: "send",
  nodes: [
    { id: "send", kind: "tool", config: { toolRef: { id: "crm.send-email", version: "1.0.0" }, inputStateKey: "message", resultStateKey: "sent" } },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "send", targetNodeId: "final" }],
});

/**
 * The trusted host's session table: which human started which Run. AAO
 * asks `principalForRun` — it never reads identity from workflow state,
 * Tool input, or anything a model produced.
 */
export const sessions = new Map<string, Principal>();

let tick = 0;
export function createConsumerApp(): AAOApp {
  return createAAO({
    governance,
    principalForRun: ({ runId }) => {
      const principal = sessions.get(runId);
      if (principal === undefined) throw new Error("no authenticated session for this Run");
      return principal;
    },
    tools: [draftTool, emailTool],
    clock: { now: () => new Date(Date.UTC(2026, 9, 14, 9, 0, tick++)).toISOString() },
  });
}

const proposal = { account: "acme", change: "update billing contact" };
const summary = (result: WorkflowExecutionResult) => JSON.parse(JSON.stringify({
  ok: result.ok,
  status: result.execution?.run.status,
  failure: result.ok ? undefined : result.failure.code,
  executorFailure: result.ok ? undefined : result.failure.executorFailure?.code,
  details: result.ok ? undefined : result.failure.details,
  revision: result.execution?.state.revision,
  nodes: result.execution?.nodeStatusesById,
})) as { ok: boolean; status?: string; failure?: string; executorFailure?: string; details?: Record<string, unknown>; revision?: number; nodes?: Record<string, string> };

/** Every consumer scenario through the public API only. */
export async function runConsumerScenarios() {
  const app = createConsumerApp();
  const update = app.prepareWorkflow(approvedUpdate);

  // 1. Approval → approve → continue → Tool → COMPLETED.
  sessions.set("run-approved", alice);
  const waiting = await update.execute({ runId: "run-approved", initialState: { runId: "run-approved", revision: 0, values: { proposal } } });
  if (waiting.execution === undefined) throw new Error("the Run did not start");
  // Summaries are captured immediately: the Runtime's continuation advances the execution object it is given.
  const waitingSummary = summary(waiting);
  const approvalId = waiting.execution.wait?.referenceId ?? "";
  const pendingContinue = summary(await update.continue(waiting.execution));
  const draftCallsWhileWaiting = calls.draft;
  let selfApproval = "allowed";
  try {
    app.approvals.approve(approvalId, alice);
  } catch (error) {
    selfApproval = (error as { code?: string }).code ?? "error";
  }
  const record = app.approvals.approve(approvalId, bob);
  const completed = await update.continue(waiting.execution);
  const approved = { waiting: waitingSummary, pendingContinue, approvalId, draftCallsWhileWaiting, selfApproval, requestedBy: record.requestedBy, resolvedBy: record.resolvedBy, completed: summary(completed), output: completed.ok ? completed.execution.state.values.draft : undefined, draftCalls: calls.draft };

  // 2. Approval → reject → continue: canonical rejection, no Tool call.
  const before = calls.draft;
  sessions.set("run-rejected", alice);
  const toReject = await update.execute({ runId: "run-rejected", initialState: { runId: "run-rejected", revision: 0, values: { proposal } } });
  if (toReject.execution === undefined) throw new Error("the Run did not start");
  app.approvals.reject(toReject.execution.wait?.referenceId ?? "", bob);
  const rejected = { result: summary(await update.continue(toReject.execution)), draftCalls: calls.draft - before };

  // 3. Authorization: a read-only principal cannot run a write_draft Tool.
  const beforeDenied = calls.draft;
  sessions.set("run-denied", mallory);
  const denied = { result: summary(await app.prepareWorkflow(directDraft).execute({ runId: "run-denied", initialState: { runId: "run-denied", revision: 0, values: { proposal } } })), draftCalls: calls.draft - beforeDenied };

  // 4. Unsupported permission class: blocked although alice holds the grant.
  sessions.set("run-email", alice);
  const unsupported = { result: summary(await app.prepareWorkflow(sendEmail).execute({ runId: "run-email", initialState: { runId: "run-email", revision: 0, values: { message: { to: "x" } } } })), emailCalls: calls.email };

  return { approved, rejected, denied, unsupported };
}
