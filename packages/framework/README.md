# @aao/framework

The developer entry point to Applied AI Operations (AAO): define governed workflows with canonical AAO contracts, run them through AAO Core, and use the `aao` CLI.

```ts
import { createAAO, defineGovernance, defineTool, defineWorkflow } from "@aao/framework";
```

- `define*` helpers validate canonical contracts: `defineWorkflow`, `defineTool`, `defineGovernance`, `defineEval`, `defineAgent`, `defineModelPolicy`.
- `createAAO({ governance, principalForRun, tools, modelAdapters, modelBindings, modelPolicies, agents, deterministicExecutors, trace })` composes the existing Runtime, Tool, Model, and Agent runtimes, Governance, Authorization, and Approval Engine. Identity comes only from your host's `principalForRun`.
- `app.prepareWorkflow(workflow)` compiles. The prepared workflow's `execute` and `continue` return the canonical `WorkflowExecutionResult`, and `continue` never mutates its input.
- It executes `tool`, `approval`, `model`, `agent`, `deterministic`, and `final_output` nodes. Model adapters register through the adapter contract (`defineModelAdapter`, an exact `adapterRef`). Concrete adapters come from their own packages, never from this root.
- `@aao/framework/conformance` verifies an adapter against the canonical conformance suite v1 (`verifyAdapterConformance`).

CLI:

```text
aao workflow validate <file>
aao workflow compile <file>
aao eval ci
aao eval adapters
aao eval baseline propose --id <id> --version <version>
aao adapters matrix [--format json|markdown]
```

Status: local monorepo package, not published. See `docs/framework/quickstart.md`, `docs/framework/cli.md`, `docs/architecture/framework-surface.md`, and `docs/architecture/adapter-contract.md` in the repository.
