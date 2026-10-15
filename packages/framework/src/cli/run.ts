// The canonical `aao` CLI (Sprint 19, ADR-024; docs/framework/cli.md).
// One TypeScript implementation; `pnpm eval:*` are aliases to it. Every
// command is explicit and offline-safe: no project config, no plugin or
// module loading, no environment discovery, and no generic workflow runner
// (a Workflow file carries no trusted Tool code — execution is the library
// API's job).
import { AAO_FRAMEWORK_API_VERSION } from "../version.js";
import { formatOption, parseOptions } from "./args.js";
import { runAdaptersMatrix, runEvalAdapters } from "./eval/adapters.js";
import { proposeBaseline } from "./eval/baseline.js";
import { runEvalCi } from "./eval/ci.js";
import { installNetworkGuard } from "./eval/network-guard.js";
import { CliError, cliErrorResult, type CliResult, type CommandOutput } from "./output.js";
import { compileWorkflowFile, validateWorkflowFile } from "./workflow.js";

export const HELP = `aao — Applied AI Operations CLI (framework API v${AAO_FRAMEWORK_API_VERSION})

Usage:
  aao workflow validate <file> [--format text|json]
  aao workflow compile <file> [--format json]
  aao eval ci [--format text|json] [--verbose] [--git-sha <sha>] [--root <dir>]
  aao eval adapters [--format text|json]
  aao eval baseline propose --id <baseline-id> --version <version> [--root <dir>]
  aao adapters matrix [--format json|markdown]
  aao --help

Workflow files are .yaml, .yml, or .json; they are validated and compiled, never executed.
eval ci and eval baseline read evals/ under --root (default: the current directory).
eval adapters and adapters matrix verify the official adapters against the canonical
conformance suite shipped with @aao/adapters, so they read no project files.
Every Eval and adapter command runs offline and never writes files.

Exit codes: 0 success (eval ci: PASS or WARN); 1 invalid workflow, gate failure, or error.
`;

export interface CliContext {
  /** Base for relative workflow paths and the default eval root. */
  cwd: string;
}

const ok = (output: CommandOutput): CliResult => ({ exitCode: output.exitCode, stdout: output.output, stderr: "" });
const isHelp = (args: readonly string[]) => args.includes("--help") || args.includes("-h");

/** Eval commands run under the offline guard: any network attempt fails the command, whatever it printed. */
async function offline(command: () => Promise<CommandOutput>): Promise<CliResult> {
  const guard = installNetworkGuard();
  try {
    const result = ok(await command());
    const attempts = guard.attempts();
    return attempts.length > 0 ? { exitCode: 1, stdout: result.stdout, stderr: `AAO_EVAL_NETWORK_FORBIDDEN: ${attempts.join(", ")}\n` } : result;
  } finally {
    guard.uninstall();
  }
}

async function workflowCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  const [sub, ...rest] = args;
  if (sub === "validate") {
    const parsed = parseOptions(rest, { values: ["--format"], positionals: 1 });
    return ok(validateWorkflowFile({ cwd: context.cwd, file: parsed.positionals[0]!, format: formatOption(parsed, ["text", "json"], "text") }));
  }
  if (sub === "compile") {
    const parsed = parseOptions(rest, { values: ["--format"], positionals: 1 });
    formatOption(parsed, ["json"], "json");
    return compileWorkflowFile({ cwd: context.cwd, file: parsed.positionals[0]! });
  }
  throw new CliError("AAO_CLI_UNKNOWN_COMMAND", sub === undefined ? "missing workflow command (validate | compile)" : `unknown command "workflow ${sub}"`);
}

async function evalCommand(args: readonly string[], context: CliContext): Promise<CliResult> {
  const [sub, ...rest] = args;
  if (sub === "ci") {
    const parsed = parseOptions(rest, { values: ["--format", "--git-sha", "--root"], booleans: ["--verbose"] });
    const format = formatOption(parsed, ["text", "json"], "text");
    const root = parsed.values["--root"] ?? context.cwd;
    const gitSha = parsed.values["--git-sha"];
    return offline(() => runEvalCi({ root, format, verbose: parsed.booleans.has("--verbose"), ...(gitSha !== undefined ? { gitSha } : {}) }));
  }
  if (sub === "adapters") {
    const parsed = parseOptions(rest, { values: ["--format"] });
    const format = formatOption(parsed, ["text", "json"], "text");
    return offline(() => runEvalAdapters({ format }));
  }
  if (sub === "baseline") {
    const [action, ...options] = rest;
    if (action !== "propose") throw new CliError("AAO_CLI_UNKNOWN_COMMAND", action === undefined ? "missing baseline command (propose)" : `unknown command "eval baseline ${action}"`);
    const parsed = parseOptions(options, { values: ["--id", "--version", "--root"] });
    const id = parsed.values["--id"];
    const version = parsed.values["--version"];
    if (id === undefined || version === undefined) throw new CliError("AAO_CLI_MISSING_ARGUMENT", "eval baseline propose requires --id <baseline-id> --version <version>");
    return offline(() => proposeBaseline({ root: parsed.values["--root"] ?? context.cwd, id, version }));
  }
  throw new CliError("AAO_CLI_UNKNOWN_COMMAND", sub === undefined ? "missing eval command (ci | adapters | baseline propose)" : `unknown command "eval ${sub}"`);
}

/** `aao adapters matrix`: renders the generated compatibility matrix. It loads no adapter from the command line. */
async function adaptersCommand(args: readonly string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  if (sub !== "matrix") throw new CliError("AAO_CLI_UNKNOWN_COMMAND", sub === undefined ? "missing adapters command (matrix)" : `unknown command "adapters ${sub}"`);
  const parsed = parseOptions(rest, { values: ["--format"] });
  const format = parsed.values["--format"] ?? "json";
  if (format !== "json" && format !== "markdown") throw new CliError("AAO_CLI_INVALID_OPTION", "--format must be json or markdown");
  return offline(() => runAdaptersMatrix({ format }));
}

/**
 * Runs one CLI invocation and returns what to print. Never throws: usage
 * errors become `ERROR <code>` on stderr with exit 1, and an unexpected
 * failure becomes `AAO_CLI_INTERNAL_ERROR` — never a stack trace, secret,
 * or raw provider error.
 */
export async function runCli(argv: readonly string[], context: CliContext): Promise<CliResult> {
  const args = argv.filter((arg) => arg !== "--");
  try {
    if (args.length === 0) return { exitCode: 1, stdout: "", stderr: HELP };
    if (isHelp(args)) return { exitCode: 0, stdout: HELP, stderr: "" };
    const [group, ...rest] = args;
    if (group === "workflow") return await workflowCommand(rest, context);
    if (group === "eval") return await evalCommand(rest, context);
    if (group === "adapters") return await adaptersCommand(rest);
    if (group?.startsWith("-")) throw new CliError("AAO_CLI_UNKNOWN_OPTION", `unknown option ${group}`);
    throw new CliError("AAO_CLI_UNKNOWN_COMMAND", `unknown command "${group}"`);
  } catch (error) {
    if (error instanceof CliError) return cliErrorResult(error);
    return cliErrorResult(new CliError("AAO_CLI_INTERNAL_ERROR", "the command failed unexpectedly"));
  }
}
