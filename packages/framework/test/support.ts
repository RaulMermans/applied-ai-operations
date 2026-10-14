import type { GovernanceConfiguration, PermissionClass, Principal, RunState, ToolSpec, Workflow } from "@aao/contracts";
import type { ToolDefinitionInput } from "../src/index.js";

export const alice: Principal = { id: "user.alice", type: "user" };
export const bob: Principal = { id: "user.bob", type: "user" };
export const mallory: Principal = { id: "user.mallory", type: "user" };
export const robot: Principal = { id: "svc.robot", type: "service" };

/** A fresh object every call, so mutation tests never share state. */
export function governanceInput(): GovernanceConfiguration {
  return {
    actors: [alice, bob, mallory, robot],
    roles: [
      { id: "operator", version: "1.0.0", permissionClasses: ["read_only", "write_draft", "external_side_effect", "destructive", "sensitive_data"] },
      { id: "manager", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
      { id: "viewer", version: "1.0.0", permissionClasses: ["read_only"] },
    ],
    bindings: [
      { id: "alice.operator", actorId: alice.id, roleId: "operator", status: "active" },
      { id: "bob.manager", actorId: bob.id, roleId: "manager", status: "active" },
      { id: "mallory.viewer", actorId: mallory.id, roleId: "viewer", status: "active" },
      { id: "robot.manager", actorId: robot.id, roleId: "manager", status: "active" },
    ],
    policies: [],
  };
}

export function toolSpec(id: string, permissionClasses: PermissionClass[] = ["write_draft"]): ToolSpec {
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    name: `Tool ${id}`,
    inputSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] },
    outputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    permissionClasses,
  };
}

/** A counting Tool input; `result` lets a test make the handler fail. */
export function countingTool(id: string, permissionClasses: PermissionClass[] = ["write_draft"], result?: () => { ok: false; code: string }): ToolDefinitionInput & { calls: () => number; inputs: unknown[] } {
  let count = 0;
  const inputs: unknown[] = [];
  return {
    spec: toolSpec(id, permissionClasses),
    handler: {
      async execute({ input }) {
        count += 1;
        inputs.push(input);
        if (result) return result();
        return { ok: true, output: { id: `${id}:${(input as { account: string }).account}` } };
      },
    },
    calls: () => count,
    inputs,
  };
}

/** approve → tool → final. */
export function approvalWorkflowInput(toolId = "crm.draft", id = "test.approval-flow"): Workflow {
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    name: "Approval flow",
    entryNodeId: "approve",
    nodes: [
      { id: "approve", kind: "approval", config: { subjectStateKey: "proposal", permissionClasses: ["write_draft"], requiredApproverRoleIds: ["manager"] } },
      { id: "draft", kind: "tool", config: { toolRef: { id: toolId, version: "1.0.0" }, inputStateKey: "proposal", resultStateKey: "draft" } },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [
      { sourceNodeId: "approve", targetNodeId: "draft" },
      { sourceNodeId: "draft", targetNodeId: "final" },
    ],
  };
}

/** tool → final. */
export function toolWorkflowInput(toolId = "crm.draft", id = "test.tool-flow"): Workflow {
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    name: "Tool flow",
    entryNodeId: "draft",
    nodes: [
      { id: "draft", kind: "tool", config: { toolRef: { id: toolId, version: "1.0.0" }, inputStateKey: "proposal", resultStateKey: "draft" } },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "draft", targetNodeId: "final" }],
  };
}

export const initialState = (runId: string, values: RunState["values"] = { proposal: { account: "acme" } }): RunState => ({ runId, revision: 0, values });

/** A deterministic clock: every instance yields the same timestamp sequence. */
export function testClock() {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, tick++)).toISOString() };
}

/** A host session table — the only identity source a test app trusts. */
export function sessions(entries: Record<string, Principal> = {}) {
  const table = new Map(Object.entries(entries));
  const seen: unknown[] = [];
  return {
    table,
    seen,
    principalForRun: (context: { readonly runId: string }) => {
      seen.push(context);
      const principal = table.get(context.runId);
      if (principal === undefined) throw new Error("no session");
      return principal;
    },
  };
}
