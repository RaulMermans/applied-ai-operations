import { z } from "zod";
import { CaseExpectationVerdictSchema, EvalComparisonKeySchema, EvalDatasetRefSchema, EvalExpectedVerdictSchema, EvalVerdictSummarySchema, SemanticVerdictFingerprintSchema, identifierSchema, type EvalDataset } from "@aao/contracts";
import { caseExpectationVerdict } from "../analytics/expectation.js";
import { buildEvalComparisonKey, semanticVerdictFingerprint, verdictSummary } from "../analytics/fingerprints.js";
import { runEvalDataset, validateEvalDataset } from "../dataset.js";
import type { EvalEvidenceBundle } from "../evidence.js";
import type { EvaluatorRegistry } from "../registry.js";
import { ADAPTER_VERIFICATION_SCENARIOS, scenarioEvidenceRef, type AdapterKind, type AdapterVerificationScenario } from "./scenarios.js";

/**
 * A truthful, internal (test-owned) support declaration. `SUPPORTED` must
 * be backed by verifiable dataset cases; `UNSUPPORTED` is a real capability
 * gap; `NOT_APPLICABLE` means the substrate's port cannot express the
 * behavior at all. None of these is a public compatibility promise.
 */
export type ScenarioSupport = "SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE";

/**
 * Host-supplied substrate driver. Its implementation lives *with the
 * substrate being tested* and turns a canonical scenario into canonical
 * AAO evidence (Trace, execution state, Audit). The verifier judges that
 * evidence only; it never introspects framework internals, imports a
 * provider SDK, discovers drivers, or loads code dynamically.
 */
export interface AdapterVerificationDriver {
  readonly id: string;
  readonly kind: AdapterKind;
  readonly support: Readonly<Record<string, ScenarioSupport>>;
  /** Strings the driver seeded into provider/server responses that must never reach canonical evidence. */
  readonly sensitiveMarkers?: readonly string[];
  executeScenario(scenario: AdapterVerificationScenario): Promise<EvalEvidenceBundle>;
}

export const ADAPTER_VERIFICATION_CODES = ["ADAPTER_CONFORMANCE_FAILED", "ADAPTER_SCENARIO_UNSUPPORTED", "ADAPTER_EVIDENCE_LEAK", "ADAPTER_DRIVER_ERROR", "ADAPTER_SEMANTIC_DIVERGENCE"] as const;

export class AdapterVerificationError extends Error {
  constructor(readonly code: "ADAPTER_DECLARATION_INVALID" | "EVAL_DATASET_INVALID", readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "AdapterVerificationError";
  }
}

const SupportSchema = z.enum(["SUPPORTED", "UNSUPPORTED", "NOT_APPLICABLE"]);
const CaseSchema = z
  .object({
    caseId: identifierSchema.max(128),
    comparisonKey: EvalComparisonKeySchema,
    expected: EvalExpectedVerdictSchema,
    actual: EvalVerdictSummarySchema,
    expectation: CaseExpectationVerdictSchema,
    semanticVerdictFingerprint: SemanticVerdictFingerprintSchema,
  })
  .strict();
const FindingSchema = z.object({ code: z.enum(ADAPTER_VERIFICATION_CODES), scenarioId: identifierSchema.max(128), caseId: identifierSchema.max(128).optional() }).strict();

/** Deterministic, privacy-safe conformance report: identifiers, statuses, codes, and fingerprints only — never raw provider or MCP payloads. */
export const AdapterConformanceReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapter: z.object({ id: identifierSchema.max(128), kind: z.enum(["model", "tool", "orchestration"]) }).strict(),
    datasetRef: EvalDatasetRefSchema,
    scenariosTotal: z.number().int().nonnegative(),
    supported: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    notApplicable: z.number().int().nonnegative(),
    scenarios: z.array(z.object({ scenarioId: identifierSchema.max(128), support: SupportSchema, status: z.enum(["PASSED", "FAILED", "UNSUPPORTED", "NOT_APPLICABLE"]), cases: z.array(CaseSchema).max(64) }).strict()).max(64),
    findings: z.array(FindingSchema).max(256),
  })
  .strict();
export type AdapterConformanceReport = z.infer<typeof AdapterConformanceReportSchema>;

/**
 * Verify one substrate driver against the canonical scenarios of its kind
 * using the existing Evaluation Runtime: every SUPPORTED scenario is
 * executed once by the driver, and its dataset cases (evidence ref
 * `scenario://<id>`) are judged by the same versioned EvalDefinitions,
 * registry, and case-expectation semantics as any other dataset. A
 * SUPPORTED scenario that fails is a conformance failure; an UNSUPPORTED
 * scenario is reported as such, never as a pass.
 */
export async function verifyAdapter(params: { driver: AdapterVerificationDriver; dataset: EvalDataset; definitions: readonly unknown[]; registry: EvaluatorRegistry; scenarios?: readonly AdapterVerificationScenario[] }): Promise<AdapterConformanceReport> {
  const { driver } = params;
  const validation = validateEvalDataset({ dataset: params.dataset, definitions: params.definitions });
  if (!validation.ok) throw new AdapterVerificationError("EVAL_DATASET_INVALID", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  const dataset = validation.dataset;
  const scenarios = (params.scenarios ?? ADAPTER_VERIFICATION_SCENARIOS).filter((scenario) => scenario.kind === driver.kind);
  const declared = Object.keys(driver.support).sort();
  const expected = scenarios.map((scenario) => scenario.id).sort();
  if (declared.join("\n") !== expected.join("\n") || !Object.values(driver.support).every((value) => SupportSchema.safeParse(value).success)) throw new AdapterVerificationError("ADAPTER_DECLARATION_INVALID", `${driver.id} must declare exactly the ${driver.kind} scenarios`);

  const findings: AdapterConformanceReport["findings"] = [];
  const entries: AdapterConformanceReport["scenarios"] = [];
  for (const scenario of scenarios) {
    const support = driver.support[scenario.id]!;
    const cases = dataset.cases.filter((evalCase) => evalCase.evidenceRef === scenarioEvidenceRef(scenario.id));
    if (support !== "SUPPORTED") {
      if (support === "UNSUPPORTED") findings.push({ code: "ADAPTER_SCENARIO_UNSUPPORTED", scenarioId: scenario.id });
      entries.push({ scenarioId: scenario.id, support, status: support, cases: [] });
      continue;
    }
    if (cases.length === 0) throw new AdapterVerificationError("ADAPTER_DECLARATION_INVALID", `${driver.id} claims ${scenario.id} but the dataset has no verifiable case for it`);

    let evidence: EvalEvidenceBundle | undefined;
    try {
      evidence = await driver.executeScenario(scenario);
    } catch {
      evidence = undefined;
    }
    if (evidence === undefined) {
      findings.push({ code: "ADAPTER_DRIVER_ERROR", scenarioId: scenario.id });
      entries.push({ scenarioId: scenario.id, support, status: "FAILED", cases: [] });
      continue;
    }
    const serialized = JSON.stringify(evidence);
    const leaked = (driver.sensitiveMarkers ?? []).some((marker) => marker.length > 0 && serialized.includes(marker));
    if (leaked) findings.push({ code: "ADAPTER_EVIDENCE_LEAK", scenarioId: scenario.id });

    const ref = scenarioEvidenceRef(scenario.id);
    const run = await runEvalDataset({ dataset: { ...dataset, cases }, definitions: params.definitions, registry: params.registry, evidenceResolver: { resolve: (reference) => (reference === ref ? evidence : undefined) } });
    if (!run.ok) throw new AdapterVerificationError("EVAL_DATASET_INVALID", "scenario subset is invalid");
    const judged = run.run.cases.map((entry) => {
      const evalCase = cases.find((candidate) => candidate.id === entry.caseId)!;
      const expectation = caseExpectationVerdict(evalCase.expected, entry.result);
      if (expectation !== "MATCHED") findings.push({ code: "ADAPTER_CONFORMANCE_FAILED", scenarioId: scenario.id, caseId: entry.caseId });
      return { caseId: entry.caseId, comparisonKey: buildEvalComparisonKey(entry.result), expected: evalCase.expected, actual: verdictSummary(entry.result), expectation, semanticVerdictFingerprint: semanticVerdictFingerprint(entry.result) };
    });
    entries.push({ scenarioId: scenario.id, support, status: !leaked && judged.every((entry) => entry.expectation === "MATCHED") ? "PASSED" : "FAILED", cases: judged });
  }

  const count = (predicate: (entry: (typeof entries)[number]) => boolean) => entries.filter(predicate).length;
  return AdapterConformanceReportSchema.parse({
    schemaVersion: 1,
    adapter: { id: driver.id, kind: driver.kind },
    datasetRef: { id: dataset.id, version: dataset.version },
    scenariosTotal: entries.length,
    supported: count((entry) => entry.support === "SUPPORTED"),
    passed: count((entry) => entry.status === "PASSED"),
    failed: count((entry) => entry.status === "FAILED"),
    unsupported: count((entry) => entry.status === "UNSUPPORTED"),
    notApplicable: count((entry) => entry.status === "NOT_APPLICABLE"),
    scenarios: entries,
    findings,
  });
}

export interface AdapterPortabilityResult {
  consistent: boolean;
  cases: Array<{ caseId: string; comparisonKey: string; adapters: Array<{ id: string; semanticVerdictFingerprint: string; matchesReference: boolean }> }>;
  findings: Array<{ code: "ADAPTER_SEMANTIC_DIVERGENCE"; scenarioId: string; caseId: string; adapterId: string }>;
}

/**
 * Semantic conformance against the native AAO reference: for every case
 * both the reference and a candidate actually executed, the candidate must
 * produce the *same semantic verdict fingerprint* (same comparison key,
 * same normalized judgment). This is not byte-for-byte Trace equality —
 * evidence fingerprints legitimately differ across substrates.
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
