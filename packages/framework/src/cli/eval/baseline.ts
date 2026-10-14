// `aao eval baseline propose --id <id> --version <version>` (alias:
// `pnpm eval:baseline:propose`; Sprint 18, ADR-023).
//
// Prints a baseline PROPOSAL generated from the current deterministic suite
// to stdout. It writes no file and never touches evals/baselines/: a human
// reviews the proposal, commits it as a new baseline version, and re-pins
// the gate policy's baselineRef deliberately. There is no accept-everything
// flag, and a proposal is never a way to lower expectations after a
// regression — review the gate findings first.
import { evalBaselineFingerprint, parseEvalDataset, parseEvalDefinitions, proposeEvalBaseline } from "@aao/evaluation";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandOutput } from "../output.js";
import { EvalHostError, FOUNDATION, loadFixtures, runFoundationSuite } from "./host.js";

export async function proposeBaseline(options: { root: string; id: string; version: string }): Promise<CommandOutput> {
  const { root, id, version } = options;
  try {
    const definitions = parseEvalDefinitions(readFileSync(join(root, FOUNDATION.definitions), "utf8"), "yaml");
    const dataset = parseEvalDataset(readFileSync(join(root, FOUNDATION.dataset), "utf8"), "yaml");
    if (!definitions.ok || !dataset.ok) throw new EvalHostError("EVAL_DATASET_INVALID", "definitions or dataset are invalid");
    const suite = await runFoundationSuite({ definitions: definitions.value, dataset: dataset.value, fixtures: loadFixtures(root, FOUNDATION.fixtures) });
    const baseline = proposeEvalBaseline({ suite, id, version, description: `Accepted evaluation state of ${suite.datasetRef.id}@${suite.datasetRef.version}.` });
    const proposal = {
      kind: "aao.eval-baseline-proposal",
      notice: "PROPOSAL ONLY — nothing was written. Review every case (especially any not MATCHED), commit `baseline` as a NEW file under evals/baselines/, and update the gate policy baselineRef (id, version, fingerprint) and policy version in the same reviewed change.",
      unmatchedCases: suite.cases.filter((entry) => entry.expectation !== "MATCHED").map((entry) => entry.caseId),
      baselineRef: { id, version, fingerprint: evalBaselineFingerprint(baseline) },
      baseline,
    };
    return { exitCode: 0, output: `${JSON.stringify(proposal, null, 2)}\n` };
  } catch (error) {
    const { code, detail } = (error ?? {}) as { code?: unknown; detail?: unknown };
    return { exitCode: 1, output: `GATE ERROR ${typeof code === "string" ? code : "EVAL_DATASET_INVALID"}: ${typeof detail === "string" ? detail : "proposal failed"}\n` };
  }
}
