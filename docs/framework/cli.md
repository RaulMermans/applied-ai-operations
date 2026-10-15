# The `aao` CLI

`aao` is the single, canonical command line for AAO. It is TypeScript in `packages/framework/src/cli/`, compiled to `packages/framework/dist/cli/main.js`, which is the `@aao/framework` package `bin`. There is one implementation; the repository's `pnpm eval:*` scripts are aliases to it. See [ADR-024](../decisions/ADR-024-public-framework-surface.md).

## Command tree

```text
aao
├── workflow
│   ├── validate <file> [--format text|json]
│   └── compile  <file> [--format json]
├── eval
│   ├── ci        [--format text|json] [--verbose] [--git-sha <sha>] [--root <dir>]
│   ├── adapters  [--format text|json]
│   └── baseline
│       └── propose --id <baseline-id> --version <version> [--root <dir>]
├── adapters
│   └── matrix    [--format json|markdown]
└── --help
```

`aao --help` lists exactly these commands. There is no `aao run`, `aao init`, plugin flag, or project config. Every option is declared per command; an unknown option or surplus argument is an error.

## Installation and local use

The package is not published. In the repository:

```sh
pnpm install --frozen-lockfile
pnpm aao --help                                   # builds the framework closure, then runs the CLI
pnpm aao workflow validate path/to/workflow.yaml  # relative to the repository root

pnpm build                                        # or build once, then call the compiled CLI directly
node packages/framework/dist/cli/main.js --help
```

## Workflow commands

Both commands run the canonical Workflow DSL pipeline, `compileWorkflowSource`: parse, then `WorkflowSchema`, then semantic validation, then compile. The CLI has no parser of its own.

- **Files are inert data.** A Workflow file is validated and compiled, never executed. It carries no trusted Tool code, so the CLI resolves no Tools.
- **Accepted files.** Files must be `.yaml`, `.yml`, or `.json`, at most 1 MiB.

```text
$ aao workflow validate approved-update.yaml
VALID cli.approved-update@1.0.0

$ aao workflow validate broken.yaml
INVALID broken.yaml
  DUPLICATE_NODE_ID node=start: Node id "start" is used by more than one node.
  UNREACHABLE_NODE node=orphan: Node "orphan" is not reachable from entryNodeId "start".
```

Diagnostics are the compiler's canonical `WorkflowDiagnostic`s: code, then `node=` / `edge=` / `path=` anchors, then the message. Each is one line, because a parser message can echo source text, so only its first line is printed. At most 50 are shown. `--format json` prints `{ "valid": true, "workflow": { "id", "version" } }` or `{ "valid": false, "diagnostics": [...] }`.

`aao workflow compile <file>` prints the canonical `CompiledWorkflowPlan` as JSON on stdout and writes no file. Redirect it if you want one. On failure stdout stays empty and the diagnostics go to stderr.

## Eval commands

`eval ci` and `eval baseline propose` read the committed assets under `<root>/evals/`. `--root` defaults to the current directory, so run them from the repository root. `eval adapters` reads no project files. The canonical adapter conformance suite ships with `@aao/adapters`, and the official subjects come from explicit package exports, so it runs from any directory. No command writes a file.

| Command | Alias | Does |
| --- | --- | --- |
| `aao eval ci` | `pnpm eval:ci` | The deterministic quality gate: verify fixture pins → run the foundation dataset → suite report → compare with the approved baseline → apply the `foundation-ci` policy ([eval analytics & CI](../architecture/eval-analytics-ci.md)) |
| `aao eval adapters` | `pnpm eval:adapters` | [Adapter conformance](../architecture/adapter-contract.md) (contract v1, conformance v1) of the native references, the MCP connector, and the Vercel AI SDK adapter through the public `verifyAdapterConformance`, plus semantic portability. LangGraph is listed only as deferred. It is not an adapter |
| `aao adapters matrix [--format json\|markdown]` | — | Prints the generated [compatibility matrix](adapter-compatibility.md) from manifests and fresh conformance reports. The committed `docs/generated/adapter-compatibility.json` and `docs/framework/adapter-compatibility.md` are this output, and a test fails on drift. It never loads an adapter from the command line |
| `aao eval baseline propose --id <id> --version <v>` | `pnpm eval:baseline:propose -- --id <id> --version <v>` | Print a baseline *proposal*. A human reviews it, commits it as a new baseline version, and re-pins the policy |

- **The candidate is always built from evidence.** No command accepts a caller-supplied suite report, and the gate re-checks [report integrity](../architecture/eval-analytics-ci.md#report-integrity-sprint-19).
- **Offline.** A guard refuses `fetch`, socket connections, and DNS lookups for the whole command. Any attempt prints `AAO_EVAL_NETWORK_FORBIDDEN` and exits 1. No API key, OAuth, provider, remote MCP server, or model judge is involved. The MCP verification server is a local stdio child process, which is not network access.
- **Output.** `aao eval ci` and baseline proposals are unchanged from Sprint 18. Since Sprint 20, `aao eval adapters` reports public `AdapterConformanceReport` v1 outcomes (`PASSED`, `FAILED`, `UNSUPPORTED`, `NOT_APPLICABLE`) per `id@version`.

## No manual prior build

From a fresh checkout with dependencies installed, `pnpm eval:ci`, `pnpm eval:adapters`, `pnpm eval:baseline:propose`, and `pnpm aao` work without running `pnpm build` first. Each alias runs `pnpm --filter "@aao/framework..." run build` before invoking `dist/cli/main.js`. That builds the framework and every workspace package it depends on, with build output sent to stderr. The CLI therefore never executes stale or missing compiled output. `pnpm --filter @aao/framework smoke:no-build` deletes those `dist/` folders and proves both aliases still pass. `pnpm check` builds once and then calls the compiled CLI directly.

## Exit codes and errors

| Exit | Meaning |
| --- | --- |
| `0` | Success: `VALID`, a compiled plan, gate `PASS` or `WARN`, adapters `PASS`, a proposal printed, or `--help` |
| `1` | Invalid workflow, gate hard failure (`FAIL`), gate error (`GATE ERROR …`, no trustworthy comparison), adapter failure, network attempt, or CLI error |

CLI usage and host errors go to stderr as `ERROR <code>: <message>` with one help hint. There is no stack trace, secret, or raw provider error:

- `AAO_CLI_UNKNOWN_COMMAND`, `AAO_CLI_UNKNOWN_OPTION`, `AAO_CLI_INVALID_OPTION`;
- `AAO_CLI_MISSING_ARGUMENT`, `AAO_CLI_UNEXPECTED_ARGUMENT`;
- `AAO_CLI_UNSUPPORTED_FILE_TYPE`, `AAO_CLI_FILE_NOT_READABLE`, `AAO_CLI_FILE_TOO_LARGE`;
- `AAO_CLI_INTERNAL_ERROR`.

Running with no arguments prints the usage to stderr and exits 1.

## Not provided

- **No generic Workflow execution CLI** (`aao run <file>`). Running a Workflow needs trusted Tool handlers and a host identity boundary. Those are code, so execution goes through the library API ([quickstart](quickstart.md)). The CLI does no dynamic loading to make a file runner possible.
- **No arbitrary adapter loading** (`aao adapters verify ./module.js`). A third-party adapter is verified through the library API (`@aao/framework/conformance`), which the developer imports explicitly.
- **No other commands.** There is no project scaffolding (`aao init`, `create-aao`), plugin loading, environment discovery, publishing, or deployment.
