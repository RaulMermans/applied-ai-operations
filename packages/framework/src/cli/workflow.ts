// `aao workflow validate <file>` and `aao workflow compile <file>`.
//
// Both run the canonical Workflow DSL pipeline (`compileWorkflowSource`:
// parse → WorkflowSchema → semantic validation → compile). There is no CLI
// parser or compiler. A Workflow file is inert data: nothing here executes
// it, resolves Tools, or loads code — execution is the library API's job.
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { compileWorkflowSource, type WorkflowDiagnostic, type WorkflowSourceFormat } from "@aao/workflow-dsl";
import { CliError, safeLine, type CommandOutput } from "./output.js";

/** Workflow sources larger than this are refused before parsing. */
export const MAX_WORKFLOW_SOURCE_BYTES = 1024 * 1024;
const MAX_PRINTED_DIAGNOSTICS = 50;

const FORMATS: Record<string, WorkflowSourceFormat> = { ".yaml": "yaml", ".yml": "yaml", ".json": "json" };

function readWorkflowSource(cwd: string, file: string): { source: string; format: WorkflowSourceFormat } {
  const format = FORMATS[extname(file).toLowerCase()];
  if (format === undefined) throw new CliError("AAO_CLI_UNSUPPORTED_FILE_TYPE", "workflow files must be .yaml, .yml, or .json");
  const path = resolve(cwd, file);
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    throw new CliError("AAO_CLI_FILE_NOT_READABLE", `cannot read ${file}`);
  }
  if (size > MAX_WORKFLOW_SOURCE_BYTES) throw new CliError("AAO_CLI_FILE_TOO_LARGE", `${file} exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`);
  try {
    return { source: readFileSync(path, "utf8"), format };
  } catch {
    throw new CliError("AAO_CLI_FILE_NOT_READABLE", `cannot read ${file}`);
  }
}

/** Canonical diagnostics, bounded: single-line messages (a parser message can echo source text) and at most 50 entries. */
function boundedDiagnostics(diagnostics: readonly WorkflowDiagnostic[]): WorkflowDiagnostic[] {
  return diagnostics.slice(0, MAX_PRINTED_DIAGNOSTICS).map((diagnostic) => ({ ...diagnostic, message: safeLine(diagnostic.message) }));
}

function diagnosticLines(diagnostics: readonly WorkflowDiagnostic[]): string[] {
  const lines = boundedDiagnostics(diagnostics).map((entry) => {
    const anchor = [entry.nodeId !== undefined ? `node=${entry.nodeId}` : undefined, entry.edgeIndex !== undefined ? `edge=${entry.edgeIndex}` : undefined, entry.path !== undefined ? `path=${entry.path}` : undefined].filter(Boolean).join(" ");
    return `  ${entry.code}${anchor ? ` ${anchor}` : ""}: ${entry.message}`;
  });
  if (diagnostics.length > MAX_PRINTED_DIAGNOSTICS) lines.push(`  … ${diagnostics.length - MAX_PRINTED_DIAGNOSTICS} more`);
  return lines;
}

export function validateWorkflowFile(options: { cwd: string; file: string; format?: "text" | "json" }): CommandOutput {
  const { source, format } = readWorkflowSource(options.cwd, options.file);
  const compiled = compileWorkflowSource(source, format);
  if (options.format === "json") {
    const body = compiled.ok ? { valid: true, workflow: { id: compiled.plan.workflow.id, version: compiled.plan.workflow.version } } : { valid: false, diagnostics: boundedDiagnostics(compiled.diagnostics) };
    return { exitCode: compiled.ok ? 0 : 1, output: `${JSON.stringify(body, null, 2)}\n` };
  }
  if (compiled.ok) return { exitCode: 0, output: `VALID ${compiled.plan.workflow.id}@${compiled.plan.workflow.version}\n` };
  return { exitCode: 1, output: [`INVALID ${options.file}`, ...diagnosticLines(compiled.diagnostics), ""].join("\n") };
}

/** Prints the canonical compiled plan JSON to stdout (never a file). On failure, stdout stays empty and diagnostics go to stderr. */
export function compileWorkflowFile(options: { cwd: string; file: string }): { exitCode: 0 | 1; stdout: string; stderr: string } {
  const { source, format } = readWorkflowSource(options.cwd, options.file);
  const compiled = compileWorkflowSource(source, format);
  if (!compiled.ok) return { exitCode: 1, stdout: "", stderr: [`INVALID ${options.file}`, ...diagnosticLines(compiled.diagnostics), ""].join("\n") };
  return { exitCode: 0, stdout: `${JSON.stringify(compiled.plan, null, 2)}\n`, stderr: "" };
}
