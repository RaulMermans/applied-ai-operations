# Framework surface

`@aao/framework` (`packages/framework`, Sprint 19, [ADR-024](../decisions/ADR-024-public-framework-surface.md)) is the recommended way for an application to use AAO. It is a façade over AAO Core. It is not a second Runtime, compiler, policy engine, or source of truth.

```text
Developer
   │
   ▼
@aao/framework
   │
   ├── definitions        defineWorkflow / defineTool / defineGovernance / defineEval / defineAgent / defineModelPolicy
   ├── application host   createAAO → prepareWorkflow → execute / continue, approvals
   └── CLI                aao workflow validate|compile, aao eval ci|adapters|baseline propose
   │
   ▼
existing AAO Core
   ├── @aao/contracts, @aao/workflow-dsl             canonical contracts, compiler
   ├── @aao/runtime                                  Run/Node lifecycle, Node Registry
   ├── @aao/tool-runtime, @aao/authorization         support gate, authorize(), schemas, handler
   ├── @aao/governance, @aao/approval                authority, Approval Engine
   └── @aao/evaluation, @aao/observability (CLI)     Eval gate, adapter verification
```

- **Framework ≠ Runtime.** Execution is the Runtime's `executeWorkflow` / `continueApprovedWorkflow`, and its `WorkflowExecutionResult` is returned unchanged.
- **Framework ≠ Adapter.** There is no model, MCP, or LangGraph adapter API. That is [Sprint 20](#sprint-20-handoff).
- **Framework ≠ Toolbox.** There is no reusable Tool catalog. That is Sprint 21.

The dependency direction is `@aao/framework → Core`, never the reverse. No Core package or app imports or depends on it, and a static test enforces this. Core never needs the façade: it is the authority the façade calls.

## Stable public root

Anything exported from the `@aao/framework` root is intentional consumer API:

- **Explicit exports only.** There is no `export *`.
- **Changes are deliberate.** Adding or removing a symbol requires updating the snapshot in `packages/framework/test/public-api.test.ts`.
- **Breaking changes are announced.** A breaking change needs an ADR or migration note and a new `AAO_FRAMEWORK_API_VERSION`.

Lower-level packages evolve under their own contracts.

| Export | Kind | Purpose |
| --- | --- | --- |
| `AAO_FRAMEWORK_API_VERSION` | `1` | Framework-surface contract version (not semver, not Workflow `schemaVersion`) |
| `AAOFrameworkError` | class | Preparation/composition errors: `code`, bounded `diagnostics` |
| `createAAO` | function | The application host |
| `defineWorkflow`, `defineTool`, `defineGovernance`, `defineEval`, `defineAgent`, `defineModelPolicy` | functions | Canonical definition validators |

Types: `AAOApp`, `AAOApprovals`, `AAOClock`, `AAOOptions`, `AAOFrameworkDiagnostic`, `AAOFrameworkErrorCode`, `ExecuteWorkflowInput`, `PreparedWorkflow`, `PrincipalForRun`, `ToolDefinition`, and `ToolDefinitionInput`. The canonical Core types are re-exported by name, type-only: `Workflow`, `ToolSpec`, `ToolHandler`, `ToolHandlerContext`, `ToolHandlerResult`, `GovernanceConfiguration`, `Principal`, `PermissionClass`, `RetrySafety`, `ToolIdempotency`, `RunState`, `JsonValue`, `JsonObject`, `EvalDefinition`, `AgentSpec`, `ModelPolicySpec`, `ApprovalRecord`, `WorkflowExecutionResult`, `RuntimeExecutionState`, `RuntimeFailure`, and `WorkflowDiagnostic`. They are the Core types themselves, not copies.

No public type contains a Vercel AI SDK, MCP SDK, LangGraph, provider SDK, or HTTP-framework type. The root's import graph reaches only `@aao/approval`, `@aao/authorization`, `@aao/contracts`, `@aao/governance`, `@aao/runtime`, `@aao/tool-runtime`, `@aao/workflow-dsl`, and `node:crypto`.

## Public vs internal

| Concept | Framework root | Lower-level package | Status |
| --- | --- | --- | --- |
| Workflow definition | ✅ `defineWorkflow` | ✅ `@aao/contracts`, `@aao/workflow-dsl` | Stable |
| Workflow compile | ✅ `app.prepareWorkflow`, `aao workflow compile` | ✅ `compileWorkflow` | Stable |
| Tool definition | ✅ `defineTool` | ✅ `RegisteredTool` | Stable |
| Tool execution | via app | ✅ `executeTool`, Tool node | Stable |
| Governance | via app (`defineGovernance`) | ✅ `@aao/governance`, `@aao/authorization` | Stable |
| Approval | via app (`app.approvals`, `prepared.continue`) | ✅ `@aao/approval` | Stable |
| Eval definitions | ✅ `defineEval` | ✅ `@aao/evaluation` | Stable |
| Eval CLI | ✅ `aao eval …` | ✅ internals | Stable |
| Agent / model policy specs | ✅ declarative only | ✅ `@aao/agent-runtime`, `@aao/model-runtime` | Declarative |
| Model / agent execution | ❌ refused at preparation | ✅ | Await Sprint 20 |
| Model adapter | ❌ | ✅ `ModelAdapter`, Vercel AI SDK adapter | Await Sprint 20 |
| MCP adapter API | ❌ | ✅ `@aao/mcp-connector` | Await Sprint 20 |
| Durable execution | ❌ | ✅ `createDurableRuntimeHost` | Advanced, lower-level |
| Trace / Metrics / Audit | ❌ | ✅ `@aao/observability` | Advanced, lower-level |
| LangGraph | ❌ | research spike only | Deferred |
| Toolbox | ❌ | ❌ | Sprint 21 |

## Declarative helpers

Each helper validates against the canonical contract that owns the concept and returns that contract's type:

| Helper | Validation |
| --- | --- |
| `defineWorkflow` | `WorkflowSchema`, through `parseWorkflowSource` (canonical `WorkflowDiagnostic`s) |
| `defineTool` | `ToolSpecSchema`, then a throwaway canonical `ToolRegistry.register`: strict JSON Schema compilation, `retrySafety` (`"safe"` only for `read_only`), `idempotency`, a callable `handler.execute` |
| `defineGovernance` | `GovernanceConfigurationSchema`, then `createGovernanceRegistry` (unique ids, known actor/role references) |
| `defineEval` | `EvalDefinitionSchema` |
| `defineAgent` | `AgentSpecSchema` |
| `defineModelPolicy` | `ModelPolicySpecSchema` |

Every helper returns a detached, deep-frozen copy, so mutating the input afterwards changes nothing. A non-JSON-safe value (a function, symbol, class instance, or cycle) is refused before copying, so it cannot be silently dropped. Helpers never compile, register, execute, read files, or read the environment. Graph semantics (reachability, cycles, duplicate ids) belong to the compiler, so `defineWorkflow` accepts a schema-valid graph that `prepareWorkflow` will reject.

A Tool's `handler` is trusted executable host code. It stays outside `ToolSpec`, which remains serializable. `defineTool` captures `handler.execute` once, and defining a Tool grants nothing: registered ≠ supported ≠ authorized.

**No secrets in definitions.** The canonical schemas are strict, so credential fields (`apiKey`, `credentials`, `token`, …) are rejected wherever a contract does not declare them. Opaque JSON fields (node `config`, `ModelPolicySpec.constraints`) must not carry credentials either. Host integrations own secrets, outside AAO definitions.

## Application host

```ts
const app = createAAO({
  governance,            // canonical GovernanceConfiguration
  principalForRun,       // required: ({ runId }) => Principal, from the host's own session/identity layer
  tools: [searchTool],   // ToolDefinition[], registered once at construction
  clock,                 // optional { now(): string }; default system clock
});
```

`createAAO` validates and composes existing Core, then freezes:

- `createGovernanceRegistry(governance)`;
- `createToolRegistry()`, plus `register` for every Tool (a duplicate `id@version` fails construction);
- `createApprovalEngine({ governance, clock })`;
- `createNodeRegistry()` with `createToolNodeExecutor`, `createApprovalNodeExecutor`, and `finalOutputExecutor`.

There is no global registry, no singleton, and no registration after construction. There is no environment, filesystem, project, or MCP-server discovery, and no plugin or `import()` loading. Two apps share nothing: Tools, Approvals, and Governance are per instance. Construction is deterministic, and no random registration id exists. Run ids stay caller-owned.

`app.prepareWorkflow(workflow)` does three things:

1. It re-validates the Workflow, because a hand-built object gets the same check.
2. It compiles with `compileWorkflow`. A compile failure is `FRAMEWORK_WORKFLOW_COMPILE_FAILED` carrying the compiler's exact diagnostics.
3. It checks the [execution scope](#framework-v1-execution-scope).

The result is a frozen `PreparedWorkflow`:

```ts
interface PreparedWorkflow {
  readonly workflow: Workflow;
  readonly planFingerprint: string;   // SHA-256 of the canonical compiled plan
  execute(input: { runId: string; initialState: RunState }): Promise<WorkflowExecutionResult>;
  continue(execution: RuntimeExecutionState): Promise<WorkflowExecutionResult>;
}
```

It holds no Run state; the plan is private to it. `execute` calls `executeWorkflow`, and `continue` calls `continueApprovedWorkflow`. Both return the canonical result. As with `continueWaitingWorkflow` itself, a resolved continuation advances the `execution` object it is given.

## Identity ownership

```text
host session/identity layer ──► principalForRun({ runId }) ──► Principal
                                                      │
                     ┌────────────────────────────────┴──────────────────────────┐
                     ▼                                                           ▼
   Tool Node: resolveAuthority(governance, principal, spec.permissionClasses)    Approval Node: requestedBy
              → authorizationContextFromAuthority(authority)                      (Approval Engine checks the
              → executeTool: support gate → authorize() → schemas → handler        requester's authority)
```

- `principalForRun` is required. Without it, construction fails with `FRAMEWORK_PRINCIPAL_UNAVAILABLE`, and there is no default identity.
- The callback receives only a frozen `{ runId }`. Workflow state, node config, Tool input or output, model output, and MCP metadata never reach it, so none of them can establish identity. Tests try each channel.
- A missing session (the callback throws) or an unregistered principal yields no Authorization Context. The Tool Runtime fails closed with `TOOL_AUTHORIZATION_REQUIRED`, and the handler is never called.
- Approvers are host-attested too. `app.approvals.approve(id, principal)` takes the human principal from the host.

## Approval flow

```text
execute ──► Approval Node requests (requester = host principal) ──► WAITING_FOR_APPROVAL, Tool PENDING
        app.approvals.get(id)        immutable ApprovalRecord
        app.approvals.approve(id, approver) | reject(id, approver)    ← Approval Engine eligibility + self-approval rules
prepared.continue(execution) ──► continueApprovedWorkflow ──► Tool runs (approved) | APPROVAL_REJECTED, Tool never runs
```

- **Continuing while pending is refused.** It returns the canonical `APPROVAL_STILL_PENDING`, with no polling, implicit success, or auto-approval.
- **Approval rules are the engine's.** Eligibility (a registered human in a required role) and the self-approval rule are enforced by the Approval Engine. Its `ApprovalError` is thrown unchanged, with `code`, for example `APPROVAL_RESOLVER_NOT_ELIGIBLE`, `APPROVAL_HUMAN_REQUIRED`, or `APPROVAL_NOT_FOUND`.
- **Forged executions fail canonically.** A forged reference is `INVALID_APPROVAL_CONTEXT`, and a changed subject is `APPROVAL_REQUEST_MISMATCH`. In both cases the Tool never runs.
- **Approvals are in memory.** They live in the app's memory and do not survive a restart. Restart-safe Approval waits use `@aao/durability`.

## Framework V1 execution scope

Framework V1 executes `tool`, `approval`, and `final_output` nodes through the existing Runtime, and nothing else.

- **Other node kinds are refused at preparation.** `model`, `agent`, `deterministic`, and `evaluator` nodes produce `FRAMEWORK_FEATURE_NOT_AVAILABLE`, with one diagnostic per node. Model and agent execution need the model adapter contract (Sprint 20). Deterministic and evaluator nodes need host executors the public surface does not expose. Nothing is faked: there is no framework model adapter and no stub executor.
- **Unsupported permission classes stay unsupported.** `external_side_effect`, `destructive`, and `sensitive_data` Tools fail Runtime preflight with `TOOL_PERMISSION_UNSUPPORTED`, and the handler never runs, whatever the grants.
- **Execution is in memory only.** For durable Runs, use `createDurableRuntimeHost` from `@aao/durability`.

## Errors

| Code | When |
| --- | --- |
| `FRAMEWORK_INVALID_DEFINITION` | A `define*` input violates its canonical schema or registration rules |
| `FRAMEWORK_WORKFLOW_COMPILE_FAILED` | `prepareWorkflow` compile failure; `diagnostics` are the compiler's canonical `WorkflowDiagnostic`s |
| `FRAMEWORK_INVALID_CONFIGURATION` | `createAAO` options: Governance, Tools (including duplicates), clock |
| `FRAMEWORK_PRINCIPAL_UNAVAILABLE` | No `principalForRun` |
| `FRAMEWORK_FEATURE_NOT_AVAILABLE` | A node kind outside the V1 scope |

Errors are bounded: messages are capped, at most 50 diagnostics are kept, and no stack is included. Framework errors are for preparation and composition only. Once execution begins, Runtime, Tool, Authorization, and Approval failures are returned as the canonical `WorkflowExecutionResult`, never rewrapped. For example, `NODE_EXECUTION_FAILED` keeps `executorFailure: { namespace: "tool", code }`.

## Equivalence

`packages/framework/test/equivalence.test.ts` runs the same seven scenarios through a hand-composed lower-level host and through `@aao/framework`:

- approved;
- rejected;
- plain Tool;
- Authorization denied;
- unauthorized requester;
- unsupported class;
- handler failure.

It requires deep-equal results: Run status, state revision and values, node statuses, history, snapshots, failures, Approval records, and Tool call counts.

## Non-goals

The framework surface does not include:

- a second Runtime, compiler, policy engine, Approval engine, retry engine, or Run state;
- adapter APIs, manifests, capability or compatibility matrices, or a public conformance vocabulary;
- LangGraph support;
- `aao run <file>` (a Workflow file carries no trusted Tool code), `aao init`, or `create-aao`;
- plugin loading or environment discovery;
- Toolbox, capability packs, Control Center, or UI;
- publication or deployment;
- new autonomy: no autonomous approval, self-registration, dynamic Tool discovery, self-modifying workflows, or Eval-driven repair.

See [CLI](../framework/cli.md) and the [quickstart](../framework/quickstart.md).

## Sprint 20 handoff

These questions surfaced while building the surface. Sprint 19 deliberately leaves them open; they belong to the Adapter & Portability Contract.

- **AdapterManifest.** What a substrate declares (identity, kind, version, supported AAO contract versions, capabilities), and whether the framework root ever accepts one.
- **Adapter kind taxonomy.** Today the internal verification kinds are `tool` and `model`. MCP is a Tool *source* bound into `RegisteredTool`s, not a kind of its own. Sprint 20 must decide where MCP, agent orchestrators (LangGraph), and future workflow substrates sit.
- **Capability declaration.** How an adapter states what it can do (structured output, tool calls, cancellation, retry safety), and how that relates to `ModelPolicySpec.requiredCapabilities` and the Tool support gate.
- **Conformance vocabulary.** Whether `SUPPORTED` / `UNSUPPORTED` / `NOT_APPLICABLE` / `FAILED` becomes a public compatibility contract.
- **`ModelAdapter` cancellation.** The port has no `AbortSignal`, so a Runtime attempt timeout cannot cancel provider work. Changing the port is a contract change.
- **MCP retry safety.** MCP-backed Tools declare no retry or recovery safety, so they are never retried or recovery-replayed. Should a binding be able to declare it, and who attests it?
- **Framework-level model registration.** The minimal public way to register a model route or adapter so `model` and `agent` nodes can run through `createAAO`, without exposing provider SDK types.
- **Compatibility matrix.** Whether the adapter verification report becomes a published, versioned compatibility artifact.
- **Host executors for `deterministic` nodes.** These are not adapters, but they also need a public executor shape. Decide whether that belongs with Sprint 20's port interfaces.
- **Continuation input mutation.** `continueWaitingWorkflow` advances the caller's `execution` object in place. The framework passes it through unchanged to stay equivalent. Decide whether Core should copy instead, which would be a Runtime change for both paths.
