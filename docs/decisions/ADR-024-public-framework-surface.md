# ADR-024: Public framework surface

Status: accepted

## Context

By Sprint 18 AAO had strong internal packages: contracts, the Workflow DSL and compiler, the Runtime, the Model, Agent, and Tool runtimes, Governance, Authorization, the Approval Engine, durability, observability, and evaluation. Using them meant composing them by hand. A host had to wire a Governance registry, a Tool Registry, an Authorization Context resolver, an Approval Engine and Approval executor, a Node Registry, and the compiler before it could run one Workflow. Each step had to be correct, because each one carries a guarantee: identity from the host only, support gate before Authorization, exact-request Approval, and canonical Runtime failures.

Sprint 18 also left two open items:

- The developer-facing Eval commands were a plain-JavaScript internal host (`packages/evaluation/cli/*.mjs`) that needed a manual `pnpm build` first.
- A caller-supplied `EvalSuiteReport` could self-attest summary counts that its own cases contradicted.

A public surface must not freeze what Sprint 20 owns: adapter manifests, a universal adapter interface, capability compatibility, the conformance vocabulary, and the model/MCP/LangGraph adapter APIs.

## Decision

### A façade, not a second implementation

- **`@aao/framework` is the recommended consumer entry point.** It sits on top of AAO Core: `@aao/framework → Core`, never the reverse. No Core package or app depends on or imports it, and a static test enforces this.
- **Core packages stay authoritative.** The framework defines no Workflow, Tool, Agent, Eval, Run state, Node Registry, compiler, retry engine, allow/deny decision, Approval logic, durability, Trace, Audit, or Eval analytics. Static tests check that it calls `compileWorkflow`, `executeWorkflow`, `continueApprovedWorkflow`, `createToolRegistry`, `createToolNodeExecutor`, `createGovernanceRegistry`, `resolveAuthority`, `authorizationContextFromAuthority`, `createApprovalEngine`, and `createApprovalNodeExecutor`, and that it re-implements none of them.
- **Explicit exports only.** The root has no `export *`. It exports exactly 9 values — `AAO_FRAMEWORK_API_VERSION`, `AAOFrameworkError`, `createAAO`, `defineWorkflow`, `defineTool`, `defineGovernance`, `defineEval`, `defineAgent`, `defineModelPolicy` — plus an explicit list of types. Canonical contract types are re-exported by name, type-only. An exact snapshot test pins both lists.
- **`AAO_FRAMEWORK_API_VERSION = 1`.** This is the framework-surface contract version. It is not package semver and not a Workflow `schemaVersion`. A breaking change to the root needs an ADR or migration note, and a version bump.

### Definitions

- **`define*` helpers validate the canonical schemas and return the canonical types**, as detached, deep-frozen copies:
  - `defineWorkflow` uses `WorkflowSchema`, through the DSL's own parser, so diagnostics are canonical `WorkflowDiagnostic`s;
  - `defineGovernance` uses `GovernanceConfigurationSchema` plus the Governance registry's referential checks;
  - `defineEval` uses `EvalDefinitionSchema`;
  - `defineAgent` uses `AgentSpecSchema`;
  - `defineModelPolicy` uses `ModelPolicySpecSchema`;
  - `defineTool` uses `ToolSpecSchema` plus a throwaway canonical Tool Registry registration.

  The framework has no schema library of its own. Definitions must be JSON-safe, which is checked before copying. Only a Tool handler is executable host code, and it never enters `ToolSpec`.
- **`defineAgent` and `defineModelPolicy` are declarative only.** They validate data and execute nothing.

### The application host

- **`createAAO({ governance, principalForRun, tools?, clock? })` is one isolated, explicitly constructed application.** It validates Governance and registers Tools at construction. A duplicate `id@version` fails there, never silently replaced. It then composes a Governance registry, a Tool Registry, an Approval Engine, and a Node Registry with the canonical Tool, Approval, and `final_output` executors.
- **There is no global registry or singleton**, and no environment, filesystem, or project discovery. There is no plugin or dynamic module loading, and no registration after construction. The caller's arrays and objects are copied or frozen, so mutating them later changes nothing.
- **The trusted host owns identity.** `principalForRun({ runId })` is required (`FRAMEWORK_PRINCIPAL_UNAVAILABLE` otherwise), and it receives only a frozen Run id. It is the only principal source for both Tool Authorization and Approval requests. Workflow state, node config, Tool input, model output, and MCP metadata cannot reach it.
- **Authorization follows the canonical path.** For each Tool Node, the host principal goes through `resolveAuthority` to `authorizationContextFromAuthority`, then to the Tool Runtime's `executeTool`. That path runs the support gate first, then `authorize()`, then schemas, then the handler. An unregistered principal yields no context and fails closed.
- **Approval uses the canonical engine.** The Approval executor, `app.approvals.get/approve/reject`, and `prepared.continue` → `continueApprovedWorkflow` are all the existing engine. Eligibility, self-approval, fingerprinting, revalidation, and source-time Audit are unchanged, and the engine's own `ApprovalError` codes surface unchanged.
- **`app.prepareWorkflow` compiles with the canonical compiler.** It returns an immutable `PreparedWorkflow { workflow, planFingerprint, execute, continue }`, which holds no Run state. `RuntimeExecutionState` remains authoritative.

### Errors and scope

- **Framework errors cover preparation and composition only.** `AAOFrameworkError` has five codes:
  - `FRAMEWORK_INVALID_DEFINITION`;
  - `FRAMEWORK_WORKFLOW_COMPILE_FAILED`, which carries the compiler's exact diagnostics;
  - `FRAMEWORK_INVALID_CONFIGURATION`;
  - `FRAMEWORK_PRINCIPAL_UNAVAILABLE`;
  - `FRAMEWORK_FEATURE_NOT_AVAILABLE`.

  Errors carry bounded diagnostics and no stack.
- **Runtime failures stay canonical.** Once execution begins, the result is the Runtime's `WorkflowExecutionResult`. It is never rewrapped: `NODE_EXECUTION_FAILED` keeps its `executorFailure`, preflight failures keep their issues, and Approval failures keep their codes. A test proves the framework path and a hand-composed lower-level path produce deep-equal results across seven scenarios.
- **Framework V1 has a truthful execution scope.** It executes `tool`, `approval`, and `final_output` nodes. A Workflow with `model`, `agent`, `deterministic`, or `evaluator` nodes is refused at preparation with `FRAMEWORK_FEATURE_NOT_AVAILABLE`, rather than failing later or being faked. `external_side_effect`, `destructive`, and `sensitive_data` Tools remain unsupported through the framework exactly as below it.
- **In-memory only.** The framework adds no persistence. `createDurableRuntimeHost` remains the advanced lower-level durable API. A thin wrapper would have to choose a store and expose durable-host result semantics, and both belong to a deliberate later decision, not to a convenience flag. There is no `createAAO({ durability: true })`.
- **No Trace or Audit pass-through in V1.** Using either needs lower-level recorders, so the framework does not accept them yet. It defines no Framework Trace or Audit contract.

### Adapter boundary (Sprint 20)

- **Adapter interfaces stay deferred.** The root exports no `ModelAdapter`, adapter manifest, verification driver, capability matrix, conformance vocabulary, or `define/registerAdapter`.
- **No vendor or framework SDK types are public.** The framework's own source imports no vendor or framework SDK, and its manifest declares only `@aao/*` packages.
- **The root's import graph is limited.** It reaches only `@aao/approval`, `@aao/authorization`, `@aao/contracts`, `@aao/governance`, `@aao/runtime`, `@aao/tool-runtime`, `@aao/workflow-dsl`, and `node:crypto`. The CLI is a separate entry.
- **LangGraph remains a deferred research substrate.**

### One canonical CLI

- **The public `aao` CLI lives with the framework.** It is TypeScript in `packages/framework/src/cli/` and compiles to `dist/cli/main.js`, the package `bin`. Its commands are:
  - `workflow validate <file>` and `workflow compile <file>`, through the canonical `compileWorkflowSource`;
  - `eval ci`, `eval adapters`, and `eval baseline propose`.
- **The old JavaScript host is deleted.** `packages/evaluation/cli/*.mjs` held host logic that was migrated (`host.mjs`, `eval-ci.mjs`, `eval-adapters.mjs`, `eval-baseline-propose.mjs`, `network-guard.mjs`). Their `.d.mts` declarations are deleted, and no shim remains. `pnpm eval:ci`, `pnpm eval:adapters`, and `pnpm eval:baseline:propose` remain as aliases.
- **No manual prior build.** Each alias first builds `@aao/framework` and its dependency closure (`pnpm --filter "@aao/framework..." run build`), then runs the compiled CLI. It can never execute stale or missing `dist/`, and a smoke deletes those `dist/` folders to prove it. `pnpm check` builds once and then calls the built CLI.
- **Output and guards are unchanged.** Gate, adapter, and baseline-proposal output is byte-identical to Sprint 18. The offline network guard covers every Eval command.
- **No file runner and no generator.** There is no `aao run <file>`, because a Workflow file carries no trusted Tool code and resolving one would need dynamic loading. There is no `aao init`. Execution goes through the library API.

### Proof-layer integrity

- **Self-attested reports are rejected.** `validateEvalSuiteReportIntegrity` recomputes every derivable field of a report from its own cases, and the gate, comparison, baseline proposal, and multi-run analytics enforce it. This was committed separately before the framework (see [eval analytics & CI](../architecture/eval-analytics-ci.md#report-integrity-sprint-19)).
- **The framework accepts no caller-supplied report.** No public framework API takes an `EvalSuiteReport`; the CLI builds candidates from evidence.

### Packaging

- **The package is shaped as if it could be published.** Its `exports` has only `"."` (types from `dist/*.d.ts`, never `src/`), plus `bin.aao` and a `files` allowlist of compiled `.js`/`.d.ts` and the README.
- **It stays `private`.** `pnpm pack` contains only those files. Nothing is published.

## Consequences

- A developer can define Governance, a Tool, and a Workflow, create an app, prepare, execute, approve, and continue, all from one import. Every existing guarantee still holds, and tests prove it: Authorization denial, rejection, unsupported classes, forged executions, identity injection through state, input, or metadata, two-app isolation, and post-construction mutation.
- New users see a small surface. Advanced users keep every lower-level package: model, agent, MCP, durability, and observability.
- The framework's public surface is a reviewed contract. Adding a symbol is a deliberate snapshot change.
- The framework package depends on `@aao/evaluation`, `@aao/observability`, `@aao/mcp-connector`, and `@aao/model-runtime`, but only for the CLI's Eval and adapter-verification commands. The CLI loads the test-owned substrate drivers by relative path from the sibling packages, the same convention Sprint 18 used, and no package exports them. As a result, `aao eval adapters` is a repository verification command that needs those sibling packages and the `evals/` assets.
- The Runtime's in-place update of the `execution` passed to a continuation is visible through `prepared.continue`, exactly as through `continueWaitingWorkflow`. The framework does not hide it, because hiding it would make its semantics differ from Core's.

## Not decided here

The following are Sprint 20 questions; see [framework surface § Sprint 20 handoff](../architecture/framework-surface.md#sprint-20-handoff):

- the final `AdapterManifest` and the adapter kind taxonomy;
- capability declaration and the compatibility matrix;
- whether the conformance vocabulary becomes public;
- `ModelAdapter` cancellation (`AbortSignal`);
- MCP retry safety;
- framework-level model, agent, and adapter registration.

Durable execution through the framework, Trace and Audit ports on `createAAO`, host executors for `deterministic` nodes, a Toolbox, capability packs, a Control Center, and package publication are also not decided here.
