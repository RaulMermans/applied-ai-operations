# @aao/framework

The developer entry point to Applied AI Operations (AAO): define governed workflows with canonical AAO contracts, run them through AAO Core, and use the `aao` CLI.

```ts
import { createAAO, defineGovernance, defineTool, defineWorkflow } from "@aao/framework";
```

- `define*` helpers validate canonical contracts: `defineWorkflow`, `defineTool`, `defineGovernance`, `defineEval`, `defineAgent`, `defineModelPolicy`.
- `createAAO({ governance, principalForRun, tools })` composes the existing Runtime, Tool Runtime, Governance, Authorization, and Approval Engine. Identity comes only from your host's `principalForRun`.
- `app.prepareWorkflow(workflow)` compiles. The prepared workflow's `execute` and `continue` return the canonical `WorkflowExecutionResult`.
- Framework V1 executes `tool`, `approval`, and `final_output` nodes. Model and agent execution through this package waits for the Sprint 20 adapter contract.

CLI:

```text
aao workflow validate <file>
aao workflow compile <file>
aao eval ci
aao eval adapters
aao eval baseline propose --id <id> --version <version>
```

Status: local monorepo package, not published. See `docs/framework/quickstart.md`, `docs/framework/cli.md`, and `docs/architecture/framework-surface.md` in the repository.
