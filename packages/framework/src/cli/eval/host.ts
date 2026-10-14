// Host side of the AAO Eval commands (Sprint 18, ADR-023; the canonical
// TypeScript implementation since Sprint 19, ADR-024).
//
// The Evaluation Runtime never touches the filesystem; this host does, and
// only to *read* version-controlled assets under evals/: definitions,
// datasets, fixtures, the approved baseline, and the gate policy. It never
// writes a baseline, a dataset, a fixture, or a fingerprint. Canonical
// operational Metrics are aggregated here with @aao/observability, so
// Evaluation itself never derives Metrics.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EvalBaseline, EvalComparisonReport, EvalDataset, EvalDefinition, EvalGateDecision, EvalGatePolicy, EvalReportMetadata, EvalSuiteReport, RunMetrics } from "@aao/contracts";
import {
  buildEvalSuiteReport,
  createEvaluatorRegistry,
  createStaticEvidenceResolver,
  deterministicGraders,
  evaluateEvalGate,
  parseEvalBaseline,
  parseEvalDataset,
  parseEvalDefinitions,
  parseEvalGatePolicy,
  runEvalDataset,
  verifyDatasetEvidence,
  type EvalEvidenceBundle,
} from "@aao/evaluation";
import { aggregateRunMetrics } from "@aao/observability";

/** The canonical default gate: runtime-foundation under foundation-ci, relative to the eval root. */
export const FOUNDATION = Object.freeze({
  definitions: "evals/definitions/runtime-foundation.v1.yaml",
  dataset: "evals/datasets/runtime-foundation.v2.yaml",
  fixtures: "evals/fixtures",
  policy: "evals/gates/foundation-ci.v1.yaml",
  baseline: "evals/baselines/runtime-foundation.v1.json",
});
export type FoundationPaths = typeof FOUNDATION;

export class EvalHostError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly mismatches?: unknown[],
  ) {
    super(`${code}: ${detail}`);
    this.name = "EvalHostError";
  }
}

export interface FoundationInputs {
  definitions: EvalDefinition[];
  dataset: EvalDataset;
  fixtures: Map<string, EvalEvidenceBundle>;
  policy: EvalGatePolicy;
  baseline: EvalBaseline;
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");

/** Every `*.json` fixture under `dir`, keyed `fixture://<name>`, in sorted order. */
export function loadFixtures(root: string, dir: string): Map<string, EvalEvidenceBundle> {
  return new Map(
    readdirSync(join(root, dir))
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => [`fixture://${file.slice(0, -5)}`, JSON.parse(read(root, join(dir, file))) as EvalEvidenceBundle]),
  );
}

/** Read every foundation input. Each parse failure is a configuration error with its own code. */
export function loadFoundationInputs(root: string, paths: FoundationPaths = FOUNDATION): FoundationInputs {
  const definitions = parseEvalDefinitions(read(root, paths.definitions), "yaml");
  if (!definitions.ok) throw new EvalHostError(definitions.code, `definitions: ${JSON.stringify(definitions.issues)}`);
  const dataset = parseEvalDataset(read(root, paths.dataset), "yaml");
  if (!dataset.ok) throw new EvalHostError(dataset.code, `dataset: ${JSON.stringify(dataset.issues)}`);
  const fixtures = loadFixtures(root, paths.fixtures);
  const policy = parseEvalGatePolicy(read(root, paths.policy), "yaml");
  if (!policy.ok) throw new EvalHostError(policy.code, `policy: ${JSON.stringify(policy.issues)}`);
  const baseline = parseEvalBaseline(read(root, paths.baseline));
  if (!baseline.ok) throw new EvalHostError(baseline.code, `baseline: ${JSON.stringify(baseline.issues)}`);
  return { definitions: definitions.value, dataset: dataset.value, fixtures, policy: policy.value, baseline: baseline.value };
}

/**
 * Canonical AggregateMetrics over the distinct Runs whose evidence (with
 * RunMetrics) the executed cases referenced, in dataset order. The same
 * Run referenced twice must carry identical Metrics.
 */
export function operationalAggregate(cases: EvalDataset["cases"], fixtures: Map<string, EvalEvidenceBundle>): unknown {
  const byRun = new Map<string, RunMetrics>();
  for (const evalCase of cases) {
    const metrics = fixtures.get(evalCase.evidenceRef)?.metrics as RunMetrics | null | undefined;
    if (metrics === undefined || metrics === null) continue;
    const prior = byRun.get(metrics.runId);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(metrics)) throw new EvalHostError("EVAL_GATE_INCOMPLETE_EVIDENCE", `conflicting RunMetrics for ${metrics.runId}`);
    byRun.set(metrics.runId, metrics);
  }
  const aggregate = aggregateRunMetrics({ runs: [...byRun.values()] });
  if (!aggregate.ok) throw new EvalHostError("EVAL_GATE_INCOMPLETE_EVIDENCE", `operational metrics: ${aggregate.code}`);
  return aggregate.metrics;
}

/**
 * Deterministic candidate suite: verify pinned fixture fingerprints (no
 * evaluation on mismatch), run the dataset (optionally only `caseIds`, as a
 * candidate that skipped cases would), and build the EvalSuiteReport.
 */
export async function runFoundationSuite(params: { definitions: readonly unknown[]; dataset: EvalDataset; fixtures: Map<string, EvalEvidenceBundle>; caseIds?: readonly string[]; metadata?: EvalReportMetadata }): Promise<EvalSuiteReport> {
  const { definitions, dataset, fixtures, caseIds, metadata } = params;
  const resolver = createStaticEvidenceResolver([...fixtures.entries()]);
  const pins = await verifyDatasetEvidence({ dataset, evidenceResolver: resolver });
  if (!pins.ok) {
    const detail = `${pins.mismatches.length} fixture(s) changed without a re-pinned dataset: ${pins.mismatches.map((entry) => `${entry.caseId} (${entry.evidenceRef}) expected ${entry.expectedFingerprint} actual ${entry.actualFingerprint ?? "none"}`).join("; ")}`;
    throw new EvalHostError("EVAL_FIXTURE_FINGERPRINT_MISMATCH", detail, pins.mismatches);
  }
  const executed = caseIds === undefined ? dataset : { ...dataset, cases: dataset.cases.filter((evalCase) => caseIds.includes(evalCase.id)) };
  const registry = createEvaluatorRegistry(deterministicGraders());
  const run = await runEvalDataset({ dataset: executed, definitions, registry, evidenceResolver: resolver });
  if (!run.ok) throw new EvalHostError(run.code, JSON.stringify(run.issues));
  return buildEvalSuiteReport({ dataset, definitions, run: run.run, operational: operationalAggregate(executed.cases, fixtures), ...(metadata ? { metadata } : {}) });
}

export type GatePipelineOutcome =
  | { ok: true; suite: EvalSuiteReport; decision: EvalGateDecision; comparison: EvalComparisonReport }
  | { ok: false; error: { code: string; detail: string }; suite?: EvalSuiteReport };

/**
 * The whole gate pipeline over already-loaded inputs. The candidate report
 * is always built here from evidence — never accepted from a caller — and
 * the gate re-validates its integrity. Errors are returned, never thrown,
 * and never reported as a regression.
 */
export async function runGatePipeline(inputs: FoundationInputs & { caseIds?: readonly string[]; metadata?: EvalReportMetadata }): Promise<GatePipelineOutcome> {
  try {
    const suite = await runFoundationSuite(inputs);
    const gate = evaluateEvalGate({ policy: inputs.policy, baseline: inputs.baseline, candidate: suite, ...(inputs.metadata ? { metadata: inputs.metadata } : {}) });
    if (!gate.ok) return { ok: false, error: gate.error, suite };
    return { ok: true, suite, decision: gate.decision, comparison: gate.comparison };
  } catch (error) {
    if (error instanceof EvalHostError) return { ok: false, error: { code: error.code, detail: error.detail } };
    return { ok: false, error: { code: "EVAL_GATE_INCOMPLETE_EVIDENCE", detail: "the evaluation pipeline failed unexpectedly" } };
  }
}
