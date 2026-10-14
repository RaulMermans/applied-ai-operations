import { CliError } from "./output.js";

export interface OptionSpec {
  /** Flags that take a value (`--format json`). */
  values?: readonly string[];
  /** Boolean flags (`--verbose`). */
  booleans?: readonly string[];
  /** Exact number of positional arguments. */
  positionals?: number;
}

export interface ParsedOptions {
  values: Record<string, string>;
  booleans: Set<string>;
  positionals: string[];
}

/**
 * A deliberately tiny, strict parser: every option must be declared by the
 * command, unknown options and surplus arguments are errors, and nothing is
 * read from the environment. Standalone `--` separators (as forwarded by
 * `pnpm <script> -- ...`) are ignored.
 */
export function parseOptions(args: readonly string[], spec: OptionSpec): ParsedOptions {
  const parsed: ParsedOptions = { values: {}, booleans: new Set(), positionals: [] };
  const tokens = args.filter((arg) => arg !== "--");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith("-")) {
      if (spec.values?.includes(token)) {
        const value = tokens[index + 1];
        if (value === undefined || value.startsWith("--")) throw new CliError("AAO_CLI_MISSING_ARGUMENT", `${token} requires a value`);
        parsed.values[token] = value;
        index += 1;
      } else if (spec.booleans?.includes(token)) parsed.booleans.add(token);
      else throw new CliError("AAO_CLI_UNKNOWN_OPTION", `unknown option ${token}`);
    } else parsed.positionals.push(token);
  }
  const expected = spec.positionals ?? 0;
  if (parsed.positionals.length < expected) throw new CliError("AAO_CLI_MISSING_ARGUMENT", "missing required argument");
  if (parsed.positionals.length > expected) throw new CliError("AAO_CLI_UNEXPECTED_ARGUMENT", `unexpected argument ${parsed.positionals[expected]}`);
  return parsed;
}

export function formatOption(parsed: ParsedOptions, allowed: readonly ("text" | "json")[], fallback: "text" | "json"): "text" | "json" {
  const format = parsed.values["--format"] ?? fallback;
  if (!(allowed as readonly string[]).includes(format)) throw new CliError("AAO_CLI_INVALID_OPTION", `--format must be ${allowed.join(" or ")}`);
  return format as "text" | "json";
}
