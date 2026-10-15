import {
  ADAPTER_CONFORMANCE_SUITE,
  buildAdapterConformanceReport,
  conformanceScenarioEvidenceRef,
  conformanceScenariosForKind,
  scenarioClaim,
  validateAdapterManifest,
  type AdapterConformanceReport,
  type AdapterConformanceScenario,
  type AdapterConformanceSuite,
  type ConformanceCase,
  type ConformanceFinding,
} from "@aao/adapters";
import { caseExpectationVerdict } from "../analytics/expectation.js";
import { buildEvalComparisonKey, semanticVerdictFingerprint, verdictSummary } from "../analytics/fingerprints.js";
import { runEvalDataset, validateEvalDataset } from "../dataset.js";
import type { EvalEvidenceBundle } from "../evidence.js";
import type { EvaluatorRegistry } from "../registry.js";

/**
 * What a conformance driver returns for one scenario: canonical AAO
 * evidence (Trace, execution state, Audit) from a real AAO Run, plus what
 * the subject observed at its own provider boundary. Both are untrusted
 * input. The evidence is validated against `EvalEvidenceBundleSchema`
 * before any grader sees it.
 */
export interface AdapterScenarioExecution {
  evidence: EvalEvidenceBundle;
  boundary?: { cancellationObserved?: boolean };
}

/**
 * The host-side executor of scenarios. It runs the canonical AAO workflow
 * with the adapter under test and returns evidence. This module never
 * executes anything itself. It does not introspect adapter internals,
 * import a provider SDK, discover drivers, or load code. Support is not
 * part of the driver. The manifest declares it, and conformance verifies it.
 */
export interface AdapterConformanceDriver {
  /** Strings the subject seeded into provider/server responses that must never reach canonical evidence. */
  readonly sensitiveMarkers?: readonly string[];
  executeScenario(scenario: AdapterConformanceScenario): Promise<AdapterScenarioExecution>;
}

export class AdapterConformanceError extends Error {
  constructor(readonly code: "ADAPTER_MANIFEST_INVALID" | "ADAPTER_CONTRACT_VERSION_UNSUPPORTED" | "ADAPTER_CONFORMANCE_SUITE_INVALID", readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "AdapterConformanceError";
  }
}

/**
 * Judges one adapter against the canonical conformance suite with the
 * existing Evaluation Runtime. The same EvalDefinitions, Evaluator
 * Registry, and case-expectation semantics apply as for any dataset.
 *
 * - Selection comes from the *manifest* (`scenarioClaim`). A scenario of the
 *   adapter's kind runs if it is a base invariant or if every capability it
 *   requires is declared `supported`. A declared-`unsupported` requirement
 *   makes it UNSUPPORTED, and conformance never infers support.
 * - A running scenario passes only when every case is MATCHED, no seeded
 *   sensitive marker appears in the evidence, and any required boundary
 *   observation (cancellation reaching the provider) was made. A false
 *   support claim is therefore FAILED, never downgraded.
 * - The report's outcomes, summary, and fingerprint are derived by
 *   `buildAdapterConformanceReport`, never supplied.
 */
export async function evaluateAdapterConformance(params: { manifest: unknown; driver: AdapterConformanceDriver; registry: EvaluatorRegistry; suite?: AdapterConformanceSuite; scenarios?: readonly AdapterConformanceScenario[] }): Promise<AdapterConformanceReport> {
  const validated = validateAdapterManifest(params.manifest);
  if (!validated.ok) throw new AdapterConformanceError(validated.code, validated.issues.join("; "));
  const manifest = validated.manifest;
  const suite = params.suite ?? ADAPTER_CONFORMANCE_SUITE;
  const definitions = suite.definitions as readonly unknown[];
  const validation = validateEvalDataset({ dataset: suite.dataset, definitions });
  if (!validation.ok) throw new AdapterConformanceError("ADAPTER_CONFORMANCE_SUITE_INVALID", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  const dataset = validation.dataset;
  const scenarios = params.scenarios ?? conformanceScenariosForKind(manifest.kind);

  const findings: ConformanceFinding[] = [];
  const entries: Array<{ scenarioId: string; requires: readonly string[]; claim: ReturnType<typeof scenarioClaim>; cases: ConformanceCase[] }> = [];
  for (const scenario of scenarios) {
    const claim = scenarioClaim(manifest, scenario);
    if (claim === "not_applicable" || claim === "unsupported") {
      if (claim === "unsupported") findings.push({ code: "ADAPTER_SCENARIO_UNSUPPORTED", scenarioId: scenario.id });
      entries.push({ scenarioId: scenario.id, requires: scenario.requires, claim, cases: [] });
      continue;
    }
    const ref = conformanceScenarioEvidenceRef(scenario.id);
    const cases = dataset.cases.filter((evalCase) => evalCase.evidenceRef === ref);
    if (cases.length === 0) throw new AdapterConformanceError("ADAPTER_CONFORMANCE_SUITE_INVALID", `scenario ${scenario.id} has no verifiable case in the suite`);

    let execution: AdapterScenarioExecution | undefined;
    try {
      execution = await params.driver.executeScenario(scenario);
    } catch {
      execution = undefined;
    }
    if (execution === undefined || execution === null || typeof execution !== "object") {
      findings.push({ code: "ADAPTER_DRIVER_ERROR", scenarioId: scenario.id });
      entries.push({ scenarioId: scenario.id, requires: scenario.requires, claim, cases: [] });
      continue;
    }
    const evidence = execution.evidence;
    const serialized = JSON.stringify(execution);
    if ((params.driver.sensitiveMarkers ?? []).some((marker) => marker.length > 0 && serialized.includes(marker))) findings.push({ code: "ADAPTER_EVIDENCE_LEAK", scenarioId: scenario.id });
    if (scenario.boundary?.cancellationObserved === true && execution.boundary?.cancellationObserved !== true) findings.push({ code: "ADAPTER_BOUNDARY_UNOBSERVED", scenarioId: scenario.id });

    const run = await runEvalDataset({ dataset: { ...dataset, cases }, definitions, registry: params.registry, evidenceResolver: { resolve: (reference) => (reference === ref ? evidence : undefined) } });
    if (!run.ok) throw new AdapterConformanceError("ADAPTER_CONFORMANCE_SUITE_INVALID", `scenario ${scenario.id} cases are invalid`);
    const judged = run.run.cases.map((entry) => {
      const evalCase = cases.find((candidate) => candidate.id === entry.caseId)!;
      const expectation = caseExpectationVerdict(evalCase.expected, entry.result);
      if (expectation !== "MATCHED") findings.push({ code: "ADAPTER_CONFORMANCE_FAILED", scenarioId: scenario.id, caseId: entry.caseId });
      return { caseId: entry.caseId, comparisonKey: buildEvalComparisonKey(entry.result), expected: evalCase.expected, actual: verdictSummary(entry.result), expectation, semanticVerdictFingerprint: semanticVerdictFingerprint(entry.result) };
    });
    entries.push({ scenarioId: scenario.id, requires: scenario.requires, claim, cases: judged });
  }
  return buildAdapterConformanceReport({ manifest, datasetRef: { id: dataset.id, version: dataset.version }, scenarios: entries, findings });
}

export interface AdapterPortabilityResult {
  consistent: boolean;
  cases: Array<{ caseId: string; comparisonKey: string; adapters: Array<{ id: string; semanticVerdictFingerprint: string; matchesReference: boolean }> }>;
  findings: Array<{ code: "ADAPTER_SEMANTIC_DIVERGENCE"; scenarioId: string; caseId: string; adapterId: string }>;
}

/**
 * Semantic portability against the native AAO reference. For every case
 * both the reference and a same-kind candidate actually executed, the
 * candidate must produce the same comparison key and the same semantic
 * verdict fingerprint. This is not byte equality of Trace: evidence
 * fingerprints legitimately differ across substrates.
 */
export function compareAdapterConformance(params: { reference: AdapterConformanceReport; candidates: readonly AdapterConformanceReport[] }): AdapterPortabilityResult {
  const referenceCases = new Map(params.reference.scenarios.flatMap((scenario) => scenario.cases.map((entry) => [entry.caseId, { scenarioId: scenario.scenarioId, entry }] as const)));
  const cases: AdapterPortabilityResult["cases"] = [];
  const findings: AdapterPortabilityResult["findings"] = [];
  for (const [caseId, { scenarioId, entry }] of referenceCases) {
    const adapters: AdapterPortabilityResult["cases"][number]["adapters"] = [{ id: params.reference.adapter.id, semanticVerdictFingerprint: entry.semanticVerdictFingerprint, matchesReference: true }];
    for (const candidate of params.candidates) {
      if (candidate.adapter.kind !== params.reference.adapter.kind) continue;
      const other = candidate.scenarios.flatMap((scenario) => scenario.cases).find((candidateCase) => candidateCase.caseId === caseId);
      if (!other) continue;
      const matchesReference = other.comparisonKey === entry.comparisonKey && other.semanticVerdictFingerprint === entry.semanticVerdictFingerprint;
      if (!matchesReference) findings.push({ code: "ADAPTER_SEMANTIC_DIVERGENCE", scenarioId, caseId, adapterId: candidate.adapter.id });
      adapters.push({ id: candidate.adapter.id, semanticVerdictFingerprint: other.semanticVerdictFingerprint, matchesReference });
    }
    if (adapters.length > 1) cases.push({ caseId, comparisonKey: entry.comparisonKey, adapters });
  }
  return { consistent: findings.length === 0, cases, findings };
}
