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
  formatIntegrationDiagnosticsText,
  formatAdvancedRunInspectionNodesText,
  formatAdvancedRunInspectionTimelineText,
  type OperatorInspectionSource,
  type OperatorSourceProvenance,
} from "@aao/operator-inspection";
import { formatOption, parseOptions } from "./args.js";
import { CliError, type CommandOutput } from "./output.js";

function toJsonOutput(value: unknown, provenance: OperatorSourceProvenance): CommandOutput {
  const payload =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? { source: provenance, ...value }
      : { source: provenance, data: value };
  return {
    exitCode: 0,
    output: `${JSON.stringify(payload, null, 2)}\n`,
  };
}

function toTextOutput(text: string, provenance: OperatorSourceProvenance): CommandOutput {
  const alreadyPrefixed = text.startsWith("AAO Operator Inspection");
  const prefix = alreadyPrefixed ? "" : `AAO Operator Inspection\nSource: ${provenance.label}\n\n`;
  return {
    exitCode: 0,
    output: `${prefix}${text}`,
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
      "missing inspect command (companies | packs | workflows | runs | run | evals | approvals | overview | readiness)"
    );
  }

  try {
    const source = customSource ?? (await createCanonicalDemoInspectionSource());
    const service = createOperatorInspectionService(source);
    const provenance = await service.getProvenance();

    if (sub === "companies") {
      const parsed = parseOptions(rest, { values: ["--format"] });
      const format = formatOption(parsed, ["text", "json"], "text");
      const companies = await service.listCompanies();
      return format === "json"
        ? toJsonOutput({ companies }, provenance)
        : toTextOutput(formatCompaniesText(companies), provenance);
    }

    if (sub === "packs") {
      const parsed = parseOptions(rest, { values: ["--format", "--company"] });
      const format = formatOption(parsed, ["text", "json"], "text");
      const companyId = parsed.values["--company"];
      const result = await service.listCapabilityPacks(
        companyId !== undefined ? { companyId } : {}
      );
      return format === "json"
        ? toJsonOutput(result, provenance)
        : toTextOutput(formatPacksText(result), provenance);
    }

    if (sub === "workflows") {
      const parsed = parseOptions(rest, { values: ["--format"] });
      const format = formatOption(parsed, ["text", "json"], "text");
      const workflows = await service.listWorkflows();
      return format === "json"
        ? toJsonOutput({ workflows }, provenance)
        : toTextOutput(formatWorkflowsText(workflows), provenance);
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
        ? toJsonOutput({ runs }, provenance)
        : toTextOutput(formatRunsText(runs), provenance);
    }

    if (sub === "run") {
      const parsed = parseOptions(rest, {
        values: ["--format", "--view"],
        positionals: 1,
      });
      const format = formatOption(parsed, ["text", "json"], "text");
      const view = parsed.values["--view"] ?? "default";
      if (view !== "default" && view !== "nodes" && view !== "timeline") {
        throw new CliError("AAO_CLI_INVALID_OPTION", "--view must be default, nodes, or timeline");
      }
      const runId = parsed.positionals[0]!;
      if (view === "nodes" || view === "timeline") {
        const advanced = await service.getAdvancedRunInspection(runId);
        if (format === "json") {
          return toJsonOutput(advanced, provenance);
        }
        return view === "nodes"
          ? toTextOutput(formatAdvancedRunInspectionNodesText(advanced), provenance)
          : toTextOutput(formatAdvancedRunInspectionTimelineText(advanced), provenance);
      }
      const runInspection = await service.getRunInspection(runId);
      return format === "json"
        ? toJsonOutput(runInspection, provenance)
        : toTextOutput(formatRunInspectionText(runInspection), provenance);
    }

    if (sub === "readiness") {
      const parsed = parseOptions(rest, {
        values: ["--format", "--company", "--pack"],
      });
      const format = formatOption(parsed, ["text", "json"], "text");
      const companyId = parsed.values["--company"];
      const packRef = parsed.values["--pack"];
      if (!companyId) {
        throw new CliError("AAO_CLI_MISSING_ARGUMENT", "missing required option --company");
      }
      if (!packRef) {
        throw new CliError("AAO_CLI_MISSING_ARGUMENT", "missing required option --pack");
      }
      const report = await service.getIntegrationDiagnostics(companyId, packRef);
      return format === "json"
        ? toJsonOutput(report, provenance)
        : toTextOutput(formatIntegrationDiagnosticsText(report), provenance);
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
        ? toJsonOutput({ evaluations }, provenance)
        : toTextOutput(formatEvaluationsText(evaluations), provenance);
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
          ? toJsonOutput({ approval }, provenance)
          : toTextOutput(formatApprovalsText([approval]), provenance);
      }
      const approvals = await service.listKnownApprovals();
      return format === "json"
        ? toJsonOutput({ approvals }, provenance)
        : toTextOutput(formatApprovalsText(approvals), provenance);
    }

    if (sub === "overview") {
      const parsed = parseOptions(rest, { values: ["--format"] });
      const format = formatOption(parsed, ["text", "json"], "text");
      const overview = await service.getOverview();
      return format === "json"
        ? toJsonOutput(overview, provenance)
        : toTextOutput(formatOverviewText(overview), provenance);
    }
  } catch (err) {
    handleInspectionError(err);
  }

  throw new CliError("AAO_CLI_UNKNOWN_COMMAND", `unknown command "inspect ${sub}"`);
}
