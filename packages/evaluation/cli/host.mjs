// Host side of the AAO Eval CI commands (Sprint 18, ADR-023).
//
// The Evaluation Runtime never touches the filesystem; this host does, and
// only to *read* version-controlled assets under evals/: definitions,
// datasets, fixtures, the approved baseline, and the gate policy. It never
// writes a baseline, a dataset, a fixture, or a fingerprint. Canonical
// operational Metrics are aggregated here with @aao/observability, so
// Evaluation itself never derives Metrics.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from '@aao/evaluation';
import { aggregateRunMetrics } from '@aao/observability';

export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The canonical default gate: runtime-foundation under foundation-ci. */
export const FOUNDATION = Object.freeze({
  definitions: 'evals/definitions/runtime-foundation.v1.yaml',
  dataset: 'evals/datasets/runtime-foundation.v2.yaml',
  fixtures: 'evals/fixtures',
  policy: 'evals/gates/foundation-ci.v1.yaml',
  baseline: 'evals/baselines/runtime-foundation.v1.json',
});

export class EvalHostError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'EvalHostError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

const read = (root, path) => readFileSync(join(root, path), 'utf8');

/** Read every foundation input. Each parse failure is a configuration error with its own code. */
export function loadFoundationInputs(root = repositoryRoot, paths = FOUNDATION) {
  const definitions = parseEvalDefinitions(read(root, paths.definitions), 'yaml');
  if (!definitions.ok) throw new EvalHostError(definitions.code, `definitions: ${JSON.stringify(definitions.issues)}`);
  const dataset = parseEvalDataset(read(root, paths.dataset), 'yaml');
  if (!dataset.ok) throw new EvalHostError(dataset.code, `dataset: ${JSON.stringify(dataset.issues)}`);
  const fixtures = new Map(readdirSync(join(root, paths.fixtures)).filter((file) => file.endsWith('.json')).sort().map((file) => [`fixture://${file.slice(0, -5)}`, JSON.parse(read(root, join(paths.fixtures, file)))]));
  const policy = parseEvalGatePolicy(read(root, paths.policy), 'yaml');
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
export function operationalAggregate(cases, fixtures) {
  const byRun = new Map();
  for (const evalCase of cases) {
    const metrics = fixtures.get(evalCase.evidenceRef)?.metrics;
    if (metrics === undefined || metrics === null) continue;
    const prior = byRun.get(metrics.runId);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(metrics)) throw new EvalHostError('EVAL_GATE_INCOMPLETE_EVIDENCE', `conflicting RunMetrics for ${metrics.runId}`);
    byRun.set(metrics.runId, metrics);
  }
  const aggregate = aggregateRunMetrics({ runs: [...byRun.values()] });
  if (!aggregate.ok) throw new EvalHostError('EVAL_GATE_INCOMPLETE_EVIDENCE', `operational metrics: ${aggregate.code}`);
  return aggregate.metrics;
}

/**
 * Deterministic candidate suite: verify pinned fixture fingerprints (no
 * evaluation on mismatch), run the dataset (optionally only `caseIds`, as a
 * candidate that skipped cases would), and build the EvalSuiteReport.
 */
export async function runFoundationSuite({ definitions, dataset, fixtures, caseIds, metadata }) {
  const resolver = createStaticEvidenceResolver([...fixtures.entries()]);
  const pins = await verifyDatasetEvidence({ dataset, evidenceResolver: resolver });
  if (!pins.ok) throw new EvalHostError('EVAL_FIXTURE_FINGERPRINT_MISMATCH', `${pins.mismatches.length} fixture(s) changed without a re-pinned dataset: ${pins.mismatches.map((entry) => `${entry.caseId} (${entry.evidenceRef}) expected ${entry.expectedFingerprint} actual ${entry.actualFingerprint ?? 'none'}`).join('; ')}`, { mismatches: pins.mismatches });
  const executed = caseIds === undefined ? dataset : { ...dataset, cases: dataset.cases.filter((evalCase) => caseIds.includes(evalCase.id)) };
  const registry = createEvaluatorRegistry(deterministicGraders());
  const run = await runEvalDataset({ dataset: executed, definitions, registry, evidenceResolver: resolver });
  if (!run.ok) throw new EvalHostError(run.code, JSON.stringify(run.issues));
  return buildEvalSuiteReport({ dataset, definitions, run: run.run, operational: operationalAggregate(executed.cases, fixtures), ...(metadata ? { metadata } : {}) });
}

/** The whole gate pipeline over already-loaded inputs. Errors are returned, never thrown, and never reported as a regression. */
export async function runGatePipeline(inputs) {
  try {
    const suite = await runFoundationSuite(inputs);
    const gate = evaluateEvalGate({ policy: inputs.policy, baseline: inputs.baseline, candidate: suite, ...(inputs.metadata ? { metadata: inputs.metadata } : {}) });
    if (!gate.ok) return { ok: false, error: gate.error, suite };
    return { ok: true, suite, decision: gate.decision, comparison: gate.comparison };
  } catch (error) {
    if (error instanceof EvalHostError) return { ok: false, error: { code: error.code, detail: error.detail } };
    return { ok: false, error: { code: 'EVAL_GATE_INCOMPLETE_EVIDENCE', detail: 'the evaluation pipeline failed unexpectedly' } };
  }
}
