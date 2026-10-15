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

## 3. A model step through an explicit adapter

Models plug in through the adapter contract ([ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md)). An adapter is the canonical `ModelAdapter` port plus a manifest that claims only what it implements. A binding names the adapter by exact version. The Workflow references only a model policy.

```ts
import { createAAO, defineAdapterManifest, defineGovernance, defineModelAdapter, defineModelPolicy, defineWorkflow, type ModelAdapter } from "@aao/framework";

// 1. The adapter: the canonical port. Forward `signal` to your provider so a Runtime timeout really stops the call.
const rulesClassifier: ModelAdapter = {
  async invoke(request, { signal }) {
    if (signal.aborted) return { status: "failed", reason: "provider_error" };
    const text = request.messages.map((message) => message.content).join(" ");
    return { status: "succeeded", output: { category: /market|study/i.test(text) ? "research" : "support" }, finishReason: "stop" };
  },
};

// 2. Its manifest: a claim, never authority. Every capability is declared, and conformance verifies the claims.
const classifier = defineModelAdapter({
  manifest: defineAdapterManifest({
    id: "example.rules-classifier", version: "1.0.0", kind: "model",
    capabilities: [
      { capability: "model.text_generation", support: "supported" },
      { capability: "model.structured_output", support: "supported" },
      { capability: "model.usage", support: "unsupported" },
      { capability: "model.cancellation", support: "supported" },
      { capability: "model.tool_call_response", support: "unsupported" },
    ],
  }),
  adapter: rulesClassifier,
});

// 3. Host configuration: the binding names the exact adapter. The Workflow below never does.
const app = createAAO({
  governance: defineGovernance({ actors: [{ id: "svc.intake", type: "service" }], roles: [], bindings: [], policies: [] }),
  principalForRun: () => ({ id: "svc.intake", type: "service" }),
  modelAdapters: [classifier],
  modelBindings: [{ id: "classifier", priority: 1, capabilities: ["model.text_generation", "model.structured_output"], adapterRef: { id: "example.rules-classifier", version: "1.0.0" } }],
  modelPolicies: [defineModelPolicy({ schemaVersion: 1, id: "policy.classify", version: "1.0.0", name: "Classify requests" })],
});

const workflow = defineWorkflow({
  schemaVersion: 1, id: "requests.classify", version: "1.0.0", name: "Classify a request", entryNodeId: "classify",
  nodes: [
    { id: "classify", kind: "model", config: { modelPolicyRef: "policy.classify", requestStateKey: "request", resultStateKey: "classification" } },
    { id: "done", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "classify", targetNodeId: "done" }],
});

const request = {
  schemaVersion: 1, invocationId: "inv-1",
  messages: [{ role: "user", content: "Classify: quarterly market study." }],
  output: { kind: "structured", schema: { type: "object", properties: { category: { type: "string" } }, required: ["category"] } },
};
const classified = await app.prepareWorkflow(workflow).execute({ runId: "run-classify-1", initialState: { runId: "run-classify-1", revision: 0, values: { request } } });

console.log(classified.ok && (classified.execution.state.values.classification as { output: unknown }).output); // { category: "research" }
```

To use the Vercel AI SDK instead, change only host configuration. Import the concrete adapter from its own package, never from `@aao/framework`. The Workflow and policy stay the same:

```typescript
import { defineVercelAiModelAdapter } from "@aao/model-runtime/vercel-ai";

modelAdapters: [defineVercelAiModelAdapter({ model: yourLanguageModel })],
modelBindings: [{ ..., adapterRef: { id: "aao.vercel-ai-sdk", version: "1.0.0" } }],
```

What the adapter contract guarantees:

- **Bounded construction failures.** A missing or wrong-version adapter, a wrong kind, or a binding capability the manifest does not claim fails `createAAO` before any provider call.
- **One cancellation lineage.** The adapter receives the Runtime attempt's `AbortSignal`. A model call that outlives its attempt timeout cannot commit a late result.
- **Canonical failures.** A provider failure stays the canonical `MODEL_INVOCATION_FAILED`.
- **Agents.** `agent` nodes use the same adapters through the native bounded Agent Runtime (`agents: [{ spec, instructions, limits }]`).
- **Deterministic steps.** Trusted host executors run `deterministic` nodes (`deterministicExecutors`, by exact `executorRef`).
- **Tool providers.** MCP Tools are bound in `@aao/mcp-connector` with host-owned permission and retry safety, then registered with `defineTool`. Server metadata never grants either.

## What the framework does not do (yet)

- **Node kinds.** It runs `tool`, `approval`, `model`, `agent`, `deterministic`, and `final_output` nodes. `evaluator` nodes are refused at `prepareWorkflow` with `FRAMEWORK_FEATURE_NOT_AVAILABLE`.
- **Adapters.** There is no LangGraph or other `agent_runtime` adapter, no adapter discovery or module loading, and no concrete adapter exported from `@aao/framework`. Verify your own adapter with `@aao/framework/conformance` ([adapter contract](../architecture/adapter-contract.md)).
- **Tool permission classes.** Tools requiring `external_side_effect`, `destructive`, or `sensitive_data` stay unsupported, whatever the grants or an adapter's claims.
- **Identity.** It does not authenticate anyone. `principalForRun` is your host's identity boundary.
- **Secrets.** Keep credentials out of definitions and manifests. Your handlers and adapters own their own dependencies.

Next: the [CLI](cli.md), the [framework surface](../architecture/framework-surface.md), and the [compatibility matrix](adapter-compatibility.md).
