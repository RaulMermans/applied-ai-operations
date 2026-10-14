/** What one CLI command produced. The bin entry writes it; tests assert it. No stack trace ever enters it. */
export interface CliResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

/** A command's primary output (stdout) and exit code. */
export interface CommandOutput {
  exitCode: 0 | 1;
  output: string;
}

export type CliErrorCode =
  | "AAO_CLI_UNKNOWN_COMMAND"
  | "AAO_CLI_UNKNOWN_OPTION"
  | "AAO_CLI_INVALID_OPTION"
  | "AAO_CLI_MISSING_ARGUMENT"
  | "AAO_CLI_UNEXPECTED_ARGUMENT"
  | "AAO_CLI_UNSUPPORTED_FILE_TYPE"
  | "AAO_CLI_FILE_NOT_READABLE"
  | "AAO_CLI_FILE_TOO_LARGE"
  | "AAO_CLI_INTERNAL_ERROR";

/** A usage or host error: exit 1, a safe code, a concise message on stderr. */
export class CliError extends Error {
  constructor(readonly code: CliErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "CliError";
  }
}

const MAX_LINE = 300;

/** One line, bounded: multi-line parser messages can echo source text, so only the first line is ever printed. */
export function safeLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

export const cliErrorResult = (error: CliError): CliResult => ({ exitCode: 1, stdout: "", stderr: `ERROR ${error.code}: ${safeLine(error.detail)}\nRun "aao --help" for usage.\n` });
