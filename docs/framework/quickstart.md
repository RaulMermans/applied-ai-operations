# AAO framework quickstart

`@aao/framework` is the single import for building a governed workflow. You define who may do what, the Tools that exist, and the Workflow. You then create an app and run the Workflow. AAO Core enforces Governance, Authorization, Approval, and Tool safety on every Run.

> Local monorepo package (`packages/framework`); not published to npm yet. Run `pnpm install` and `pnpm build` in the repository first.

## 1. A governed Tool workflow

```ts
import { createAAO, defineGovernance, defineTool, defineWorkflow } from "@aao/framework";

// Who may do what. Identity itself comes from your host (step 4).
const governance = defineGovernance({
  actors: [{ id: "user.ana", type: "user" }],
  roles: [{ id: "analyst", version: "1.0.0", permissionClasses: ["read_only"] }],
  bindings: [{ id: "ana.analyst", actorId: "user.ana", roleId: "analyst", status: "active" }],
  policies: [],
});

// A Tool: a canonical, serializable ToolSpec plus your trusted handler.
const searchAccounts = defineTool({
  spec: {
    schemaVersion: 1, id: "crm.search-accounts", version: "1.0.0", name: "Search accounts",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    outputSchema: { type: "object", properties: { matches: { type: "array", items: { type: "string" } } }, required: ["matches"] },
    permissionClasses: ["read_only"],
  },
  handler: {
    async execute({ input }) {
      const { query } = input as { query: string };
      return { ok: true, output: { matches: [`${query} Ltd`] } };
    },
  },
});

// The Workflow: search → done.
const workflow = defineWorkflow({
  schemaVersion: 1, id: "accounts.lookup", version: "1.0.0", name: "Account lookup", entryNodeId: "search",
  nodes: [
    { id: "search", kind: "tool", config: { toolRef: { id: "crm.search-accounts", version: "1.0.0" }, inputStateKey: "request", resultStateKey: "accounts" } },
    { id: "done", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "search", targetNodeId: "done" }],
});

// The app. principalForRun is your host's authenticated user for that Run.
const app = createAAO({ governance, principalForRun: () => ({ id: "user.ana", type: "user" }), tools: [searchAccounts] });

const lookup = app.prepareWorkflow(workflow);
const result = await lookup.execute({ runId: "run-001", initialState: { runId: "run-001", revision: 0, values: { request: { query: "Acme" } } } });

console.log(result.ok, result.execution?.run.status); // true COMPLETED
```

What happened:

- **`defineGovernance` / `defineTool` / `defineWorkflow`** validated the canonical AAO contracts and returned frozen copies.
- **`createAAO`** composed the Governance registry, Tool Registry, Approval Engine, and Runtime Node Registry.
- **`prepareWorkflow`** compiled the Workflow with the canonical compiler.
- **`execute`** ran it through the Runtime. For the Tool, Ana's authority was resolved, then the Tool support gate, `authorize()`, the input schema, the handler, and the output schema ran in that order.
- **`result`** is the Runtime's canonical `WorkflowExecutionResult`.

If Ana lacked `read_only`, the handler would never run. The result would be `NODE_EXECUTION_FAILED` with `executorFailure.code === "TOOL_AUTHORIZATION_DENIED"`.

## 2. Human approval before a draft

AAO's differentiator: a Workflow pauses at an exact Approval request. Only an eligible human can let it continue.

```ts
import { createAAO, defineGovernance, defineTool, defineWorkflow, type Principal } from "@aao/framework";

const ana: Principal = { id: "user.ana", type: "user" }; // operator: starts the Run
const ben: Principal = { id: "user.ben", type: "user" }; // manager: approves

const governance = defineGovernance({
  actors: [ana, ben],
  roles: [
    { id: "operator", version: "1.0.0", permissionClasses: ["write_draft"] },
    { id: "manager", version: "1.0.0", permissionClasses: ["write_draft"] },
  ],
  bindings: [
    { id: "ana.operator", actorId: ana.id, roleId: "operator", status: "active" },
    { id: "ben.manager", actorId: ben.id, roleId: "manager", status: "active" },
  ],
  policies: [],
});

const draftUpdate = defineTool({
  spec: {
    schemaVersion: 1, id: "crm.draft-update", version: "1.0.0", name: "Draft an account update",
    inputSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] },
    outputSchema: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
    permissionClasses: ["write_draft"],
  },
  handler: { async execute({ input }) { return { ok: true, output: { draftId: `draft-${(input as { account: string }).account}` } }; } },
});

const workflow = defineWorkflow({
  schemaVersion: 1, id: "accounts.update", version: "1.0.0", name: "Approved update", entryNodeId: "approve",
  nodes: [
    { id: "approve", kind: "approval", config: { subjectStateKey: "proposal", permissionClasses: ["write_draft"], requiredApproverRoleIds: ["manager"] } },
    { id: "draft", kind: "tool", config: { toolRef: { id: "crm.draft-update", version: "1.0.0" }, inputStateKey: "proposal", resultStateKey: "draft" } },
    { id: "done", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "approve", targetNodeId: "draft" }, { sourceNodeId: "draft", targetNodeId: "done" }],
});

const sessions = new Map([["run-042", ana]]); // your host's record of who started each Run
const app = createAAO({ governance, principalForRun: ({ runId }) => sessions.get(runId)!, tools: [draftUpdate] });
const update = app.prepareWorkflow(workflow);

const first = await update.execute({ runId: "run-042", initialState: { runId: "run-042", revision: 0, values: { proposal: { account: "acme" } } } });
console.log(first.execution?.run.status); // WAITING_FOR_APPROVAL — the Tool has not run

const approvalId = first.execution!.wait!.referenceId;
app.approvals.approve(approvalId, ben); // Ana could not approve her own request (APPROVAL_RESOLVER_NOT_ELIGIBLE)

const final = await update.continue(first.execution!);
console.log(final.execution?.run.status); // COMPLETED — the draft ran exactly once
```

- **Rejection.** `app.approvals.reject(approvalId, ben)` followed by `continue` fails the Run with `APPROVAL_REJECTED`, and the Tool never runs.
- **Continuing too early.** Calling `continue` before anyone decides returns `APPROVAL_STILL_PENDING`.
- **Restarts.** Approvals live in this app's memory. For restart-safe waits, use the lower-level `@aao/durability`.

## What the framework does not do (yet)

- **Node kinds.** It runs `tool`, `approval`, and `final_output` nodes. `model`, `agent`, `deterministic`, and `evaluator` nodes are refused at `prepareWorkflow` with `FRAMEWORK_FEATURE_NOT_AVAILABLE`. Model and agent execution through the framework waits for the Sprint 20 adapter contract. Until then, use `@aao/model-runtime` and `@aao/agent-runtime` directly.
- **Tool permission classes.** Tools requiring `external_side_effect`, `destructive`, or `sensitive_data` stay unsupported, whatever the grants.
- **Identity.** It does not authenticate anyone. `principalForRun` is your host's identity boundary.
- **Secrets.** Keep credentials out of definitions. Your handlers own their own dependencies.

Next: the [CLI](cli.md) and the [framework surface](../architecture/framework-surface.md).
