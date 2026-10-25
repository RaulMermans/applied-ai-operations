import {
  OperatorInspectionError,
  createCanonicalDemoInspectionSource,
  createOperatorInspectionService,
  formatApprovalsText,
  formatCompaniesText,
  formatEvaluationsText,
  formatOverviewText,
  formatPacksText,
  formatRunInspectionText,
  formatRunsText,
  formatWorkflowsText,
  type OperatorInspectionSource,
} from "@aao/operator-inspection";
import { formatOption, parseOptions } from "./args.js";
import { CliError, type CommandOutput } from "./output.js";

function toJsonOutput(value: unknown): CommandOutput {
  return {
    exitCode: 0,
    output: `${JSON.stringify(value, null, 2)}\n`,
  };
}

function toTextOutput(text: string): CommandOutput {
  return {
    exitCode: 0,
    output: text,
  };
}

function handleInspectionError(err: unknown): never {
  if (err instanceof CliError) {
    throw err;
  }
  if (err instanceof OperatorInspectionError) {
    throw new CliError(
      err.code === "INSPECTION_INVALID_REQUEST"
        ? "AAO_CLI_INVALID_OPTION"
        : "AAO_CLI_INTERNAL_ERROR",
      `${err.code}: ${err.message}`
    );
  }
  throw new CliError("AAO_CLI_INTERNAL_ERROR", "inspection command failed unexpectedly");
}

export async function runInspectCommand(
  args: readonly string[],
  customSource?: OperatorInspectionSource
): Promise<CommandOutput> {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    throw new CliError(
      "AAO_CLI_UNKNOWN_COMMAND",
      "missing inspect command (companies | packs | workflows | runs | run | evals | approvals | overview)"
    );
  }

  try {
    const source = customSource ?? (await createCanonicalDemoInspectionSource());
    const service = createOperatorInspectionService(source);

    if (sub === "companies") {
      const parsed = parseOptions(rest, { values: ["--format"] });
      const format = formatOption(parsed, ["text", "json"], "text");
      const companies = await service.listCompanies();
      return format === "json"
        ? toJsonOutput({ companies })
        : toTextOutput(formatCompaniesText(companies));
    }

    if (sub === "packs") {
      const parsed = parseOptions(rest, { values: ["--format", "--company"] });
      const format = formatOption(parsed, ["text", "json"], "text");
      const companyId = parsed.values["--company"];
      const result = await service.listCapabilityPacks(
        companyId !== undefined ? { companyId } : {}
      );
      return format === "json"
        ? toJsonOutput(result)
        : toTextOutput(formatPacksText(result));
    }

    if (sub === "workflows") {
      const parsed = parseOptions(rest, { values: ["--format"] });
      const format = formatOption(parsed, ["text", "json"], "text");
      const workflows = await service.listWorkflows();
      return format === "json"
        ? toJsonOutput({ workflows })
        : toTextOutput(formatWorkflowsText(workflows));
    }

    if (sub === "runs") {
      const parsed = parseOptions(rest, {
        values: ["--format", "--company", "--status", "--limit"],
      });
      const format = formatOption(parsed, ["text", "json"], "text");
      const query: Record<string, unknown> = {};
      if (parsed.values["--company"] !== undefined) {
        query.companyId = parsed.values["--company"];
      }
      if (parsed.values["--status"] !== undefined) {
        query.status = parsed.values["--status"];
      }
      if (parsed.values["--limit"] !== undefined) {
        query.limit = parsed.values["--limit"];
      }
      const runs = await service.listKnownRuns(query);
      return format === "json"
        ? toJsonOutput({ runs })
        : toTextOutput(formatRunsText(runs));
    }

    if (sub === "run") {
      const parsed = parseOptions(rest, { values: ["--format"], positionals: 1 });
      const format = formatOption(parsed, ["text", "json"], "text");
      const runId = parsed.positionals[0]!;
      const runInspection = await service.getRunInspection(runId);
      return format === "json"
        ? toJsonOutput(runInspection)
        : toTextOutput(formatRunInspectionText(runInspection));
    }

    if (sub === "evals") {
      const parsed = parseOptions(rest, {
        values: ["--format", "--company", "--pack", "--run"],
      });
      const format = formatOption(parsed, ["text", "json"], "text");
      const query: Record<string, unknown> = {};
      if (parsed.values["--company"] !== undefined) {
        query.companyId = parsed.values["--company"];
      }
      if (parsed.values["--pack"] !== undefined) {
        query.packIdentity = parsed.values["--pack"];
      }
      if (parsed.values["--run"] !== undefined) {
        query.runId = parsed.values["--run"];
      }
      const evaluations = await service.listKnownEvaluationResults(query);
      return format === "json"
        ? toJsonOutput({ evaluations })
        : toTextOutput(formatEvaluationsText(evaluations));
    }

    if (sub === "approvals") {
      const hasPositional = rest.some((token) => !token.startsWith("-"));
      const parsed = parseOptions(rest, {
        values: ["--format"],
        positionals: hasPositional ? 1 : 0,
      });
      const format = formatOption(parsed, ["text", "json"], "text");
      if (hasPositional) {
        const approval = await service.getApprovalSummary(parsed.positionals[0]!);
        return format === "json"
          ? toJsonOutput({ approval })
          : toTextOutput(formatApprovalsText([approval]));
      }
      const approvals = await service.listKnownApprovals();
      return format === "json"
        ? toJsonOutput({ approvals })
        : toTextOutput(formatApprovalsText(approvals));
    }

    if (sub === "overview") {
      const parsed = parseOptions(rest, { values: ["--format"] });
      const format = formatOption(parsed, ["text", "json"], "text");
      const overview = await service.getOverview();
      return format === "json"
        ? toJsonOutput(overview)
        : toTextOutput(formatOverviewText(overview));
    }
  } catch (err) {
    handleInspectionError(err);
  }

  throw new CliError("AAO_CLI_UNKNOWN_COMMAND", `unknown command "inspect ${sub}"`);
}
