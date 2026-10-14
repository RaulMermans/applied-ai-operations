// `aao eval ci` (alias: `pnpm eval:ci`) — the deterministic AAO Eval CI
// quality gate (Sprint 18, ADR-023; canonical CLI since Sprint 19).
//
// Loads the Eval definitions and the foundation dataset, verifies pinned
// fixture fingerprints, runs the deterministic dataset, builds the suite
// report, loads the approved baseline and gate policy, compares, applies
// the policy, and prints a concise report. Offline: no network, no
// credentials, no model judge. It reads the baseline and never writes it.
//
// Exit codes: 0 = PASS or WARN (warnings alone pass); 1 = hard failure or a
// configuration/infrastructure error (a distinct GATE ERROR diagnostic with
// no regression wording).
import { formatGateDecisionText, formatGateErrorText, gateDecisionJson } from "@aao/evaluation";
import type { CommandOutput } from "../output.js";
import { EvalHostError, loadFoundationInputs, runGatePipeline, type GatePipelineOutcome } from "./host.js";

export interface EvalCiOptions {
  root: string;
  format?: "text" | "json";
  verbose?: boolean;
  gitSha?: string;
}

/** Render a pipeline outcome. Pure: the same outcome always renders the same bytes. */
export function renderGateOutcome(outcome: GatePipelineOutcome, options: { format: "text" | "json"; verbose?: boolean }): CommandOutput {
  if (!outcome.ok) {
    const output = options.format === "json" ? `${JSON.stringify({ gate: { passed: false, outcome: "ERROR" }, error: outcome.error }, null, 2)}\n` : formatGateErrorText(outcome.error as Parameters<typeof formatGateErrorText>[0]); // host codes (e.g. fixture pins) share the gate error shape
    return { exitCode: 1, output };
  }
  const output = options.format === "json" ? `${JSON.stringify(gateDecisionJson(outcome.decision, outcome.comparison), null, 2)}\n` : formatGateDecisionText(outcome.decision, { verbose: options.verbose ?? false, comparison: outcome.comparison });
  return { exitCode: outcome.decision.passed ? 0 : 1, output };
}

/** The full gate over the committed assets under `root`. Host-supplied release metadata never influences the verdict. */
export async function runEvalCi(options: EvalCiOptions): Promise<CommandOutput> {
  const format = options.format ?? "text";
  try {
    const inputs = loadFoundationInputs(options.root);
    const metadata = options.gitSha !== undefined ? { gitSha: options.gitSha } : undefined;
    return renderGateOutcome(await runGatePipeline({ ...inputs, ...(metadata ? { metadata } : {}) }), { format, verbose: options.verbose ?? false });
  } catch (error) {
    const known = error instanceof EvalHostError ? { code: error.code, detail: error.detail } : { code: "EVAL_GATE_INCOMPLETE_EVIDENCE", detail: "eval inputs could not be loaded" };
    return renderGateOutcome({ ok: false, error: known }, { format });
  }
}
