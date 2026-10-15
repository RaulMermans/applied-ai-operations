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
- **Framework ≠ Adapter.** The Framework exports the stable adapter *contract* (Sprint 20, [ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md)), never a concrete adapter. Hosts import the Vercel AI SDK adapter or the MCP connector from their own packages.
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
| `AAO_ADAPTER_CONTRACT_VERSION` | `1` | Adapter-contract version (Sprint 20), from `@aao/adapters` |
| `defineAdapterManifest`, `checkAdapterCompatibility`, `AdapterContractError` | function / function / class | The manifest claim, pure compatibility, and adapter-contract errors, from `@aao/adapters` |
| `defineModelAdapter` | function | Pairs a manifest with the canonical `ModelAdapter` port, from `@aao/model-runtime` |

Types: `AAOApp`, `AAOApprovals`, `AAOClock`, `AAOOptions`, `AAOFrameworkDiagnostic`, `AAOFrameworkErrorCode`, `ExecuteWorkflowInput`, `PreparedWorkflow`, `PrepareWorkflowOptions`, `PrincipalForRun`, `ToolDefinition`, `ToolDefinitionInput`, `ModelBindingDefinition`, and `AgentDefinition`. The canonical Core types are re-exported by name, type-only:

- Workflow and state: `Workflow`, `RunState`, `JsonValue`, `JsonObject`, `WorkflowDiagnostic`.
- Tools: `ToolSpec`, `ToolHandler`, `ToolHandlerContext`, `ToolHandlerResult`, `RetrySafety`, `ToolIdempotency`.
- Governance and Approval: `GovernanceConfiguration`, `Principal`, `PermissionClass`, `ApprovalRecord`.
- Execution: `WorkflowExecutionResult`, `RuntimeExecutionState`, `RuntimeFailure`, `RuntimeTracePort`, `ReliabilityPolicy`, `DeterministicExecutor`, `DeterministicExecutorContext`, `DeterministicExecutorResult`.
- Definitions: `EvalDefinition`, `AgentSpec`, `ModelPolicySpec`.
- Adapter contract: `AdapterManifest`, `AdapterManifestInput`, `AdapterKind`, `AdapterCapability`, `AdapterRef`, `AdapterCompatibilityResult`, `AdapterConformanceReport`.
- Model port: `ModelAdapter`, `ModelAdapterContext`, `ModelAdapterRequest`, `ModelAdapterResult`, `ModelAdapterDefinition`, `ModelRequest`, `ModelResult`.

They are the Core types themselves, not copies.

No public type contains a Vercel AI SDK, MCP SDK, LangGraph, provider SDK, or HTTP-framework type. The root's import graph reaches only `@aao/adapters`, `@aao/agent-runtime`, `@aao/approval`, `@aao/authorization`, `@aao/contracts`, `@aao/governance`, `@aao/model-runtime` (root only, never `/vercel-ai`), `@aao/runtime`, `@aao/tool-runtime`, `@aao/workflow-dsl`, and `node:crypto`. Conformance verification is the separate, explicit `@aao/framework/conformance` subpath.

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
| Agent / model policy specs | ✅ `defineAgent`, `defineModelPolicy` | ✅ `@aao/agent-runtime`, `@aao/model-runtime` | Stable |
| Model / agent execution | ✅ `modelAdapters`, `modelBindings`, `modelPolicies`, `agents` | ✅ | Stable (Sprint 20) |
| Model adapter contract | ✅ `defineModelAdapter`, `ModelAdapter`, manifest types | ✅ `@aao/model-runtime`, `@aao/adapters` | Stable (Sprint 20) |
| Concrete adapters | ❌ never from the root | ✅ `@aao/model-runtime/vercel-ai`, `@aao/mcp-connector` | Stable |
| MCP Tools | via `defineTool(createMcpToolBinding(...))` | ✅ `@aao/mcp-connector` | Stable; no general Tool-provider port |
| Deterministic nodes | ✅ `deterministicExecutors` | ✅ `createDeterministicNodeExecutor` | Stable (Sprint 20) |
| Adapter conformance | ✅ `@aao/framework/conformance` subpath | ✅ `@aao/evaluation`, `@aao/adapters` | Stable (Sprint 20) |
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

## Execution scope

The Framework executes `tool`, `approval`, `model`, `agent`, `deterministic`, and `final_output` nodes through the existing Runtime (Sprint 19 V1, extended in Sprint 20).

- **Model nodes** run through Model Policy → Model Binding (exact `adapterRef`) → canonical Model Runtime → the registered `ModelAdapter`. The adapter receives the Runtime attempt's `AbortSignal`. The Framework never calls a provider SDK.
- **Agent nodes** run through the native bounded Agent Runtime only. Max iterations, stopping rules, and model-call bounds are unchanged, and Agents get no Tool use.
- **Deterministic nodes** run trusted host executors referenced by exact `config.executorRef`. These are not adapters.
- **Construction-time checks.** A missing adapter, wrong version, wrong kind, or missing capability fails construction with `FRAMEWORK_INVALID_CONFIGURATION`, whose diagnostic code is the adapter-contract code (for example `ADAPTER_NOT_FOUND`), before any provider call.
- **`evaluator` nodes are refused at preparation** with `FRAMEWORK_FEATURE_NOT_AVAILABLE`. Nothing is faked.
- **Reliability.** `prepareWorkflow(workflow, { reliability: { policiesByNodeId } })` passes trusted per-node retry and timeout policy to the Runtime, which validates it.
- **Trace.** `createAAO({ trace })` accepts an emit-only Trace port (an `@aao/observability` recorder). It is observational and never changes an outcome.
- **Continuation is non-mutating.** `prepared.continue(execution)` returns a new execution and leaves its input unchanged, inherited from the Core fix.
- **Unsupported permission classes stay unsupported.** `external_side_effect`, `destructive`, and `sensitive_data` Tools fail Runtime preflight with `TOOL_PERMISSION_UNSUPPORTED`, and the handler never runs, whatever the grants.
- **Execution is in memory only.** For durable Runs, use `createDurableRuntimeHost` from `@aao/durability`.

## Errors

| Code | When |
| --- | --- |
| `FRAMEWORK_INVALID_DEFINITION` | A `define*` input violates its canonical schema or registration rules |
| `FRAMEWORK_WORKFLOW_COMPILE_FAILED` | `prepareWorkflow` compile failure; `diagnostics` are the compiler's canonical `WorkflowDiagnostic`s |
| `FRAMEWORK_INVALID_CONFIGURATION` | `createAAO` options: Governance, Tools (including duplicates), model adapters and bindings (diagnostic codes `ADAPTER_NOT_FOUND`, `ADAPTER_KIND_MISMATCH`, `ADAPTER_CAPABILITY_UNSUPPORTED`, `ADAPTER_DUPLICATE`, `ADAPTER_MANIFEST_INVALID`, `ADAPTER_CONTRACT_VERSION_UNSUPPORTED`), policies, Agents, deterministic executors, trace, clock |
| `FRAMEWORK_PRINCIPAL_UNAVAILABLE` | No `principalForRun` |
| `FRAMEWORK_FEATURE_NOT_AVAILABLE` | An `evaluator` node |

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
- concrete adapters, a general Tool-provider port, adapter discovery or module loading, or a global adapter registry;
- LangGraph support;
- `aao run <file>` (a Workflow file carries no trusted Tool code), `aao init`, or `create-aao`;
- plugin loading or environment discovery;
- Toolbox, capability packs, Control Center, or UI;
- publication or deployment;
- new autonomy: no autonomous approval, self-registration, dynamic Tool discovery, self-modifying workflows, or Eval-driven repair.

See [CLI](../framework/cli.md) and the [quickstart](../framework/quickstart.md).

## Sprint 20 handoff (resolved)

Every question Sprint 19 left open was decided by [ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md):

- **AdapterManifest and kinds.** `AdapterManifest` V1 lives in `@aao/adapters`, with the kinds `model`, `tool_provider` (MCP), and `agent_runtime` (none implemented; LangGraph deferred).
- **Capabilities and conformance.** There is a canonical capability catalog. A binding's capabilities must be declared supported by its adapter. The public conformance vocabulary is `PASSED`, `FAILED`, `UNSUPPORTED`, and `NOT_APPLICABLE`, and there is a generated compatibility matrix.
- **Cancellation.** `ModelAdapter` v1 carries `{ signal }` from the Runtime attempt to the provider.
- **MCP retry safety.** It is host-owned only, and recovery safety stays the Tool Runtime's canonical derivation.
- **Framework registration.** The Framework registers model adapters, bindings, policies, Agents, and deterministic executors.
- **Continuation.** It is non-mutating in Core.

## Sprint 21 handoff

The Toolbox can rely on:

- a stable Framework and a stable Tool-provider boundary (host-bound canonical `ToolSpec`, Tool Runtime execution, host-owned retry safety);
- stable adapter manifests and a stable conformance contract.

Toolbox capabilities are AAO-native and need not know whether execution uses a local handler, MCP, REST, or a future provider.
