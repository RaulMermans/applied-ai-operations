import { z } from "zod";
import { CaseExpectationVerdictSchema, EvalComparisonKeySchema, EvalDatasetRefSchema, EvalExpectedVerdictSchema, EvalVerdictSummarySchema, SemanticVerdictFingerprintSchema, identifierSchema } from "@aao/contracts";
import { AdapterCapabilitySchema, AdapterKindSchema } from "../capabilities.js";
import { deepFreeze, jsonClone, sha256Hex } from "../json.js";
import { AdapterIdSchema, AdapterVersionSchema, adapterManifestFingerprint, declaredSupport, type AdapterManifest } from "../manifest.js";
import { AAO_ADAPTER_CONFORMANCE_VERSION, AAO_ADAPTER_CONTRACT_VERSION } from "../version.js";
import type { AdapterContractErrorCode } from "../errors.js";
import { conformanceScenarioEvidenceRef, conformanceScenariosForKind, type AdapterConformanceScenario } from "./scenarios.js";
import { ADAPTER_CONFORMANCE_SUITE } from "./suite.js";

/**
 * The public conformance vocabulary (conformance v1):
 *
 * - `PASSED`: the scenario ran because the adapter claimed what it requires
 *   (or it is a base invariant), and every canonical case matched.
 * - `FAILED`: it ran and did not conform. A false support claim is FAILED,
 *   never quietly downgraded to UNSUPPORTED.
 * - `UNSUPPORTED`: the manifest declares a required capability `unsupported`.
 *   This is a truthful gap, never a pass.
 * - `NOT_APPLICABLE`: the scenario belongs to another adapter kind. It is not
 *   support.
 *
 * There is deliberately no `SUPPORTED` outcome. "Supported" is a manifest
 * claim, and only `PASSED` is verification.
 */
export const CONFORMANCE_OUTCOMES = ["PASSED", "FAILED", "UNSUPPORTED", "NOT_APPLICABLE"] as const;
export const ConformanceOutcomeSchema = z.enum(CONFORMANCE_OUTCOMES);
export type ConformanceOutcome = z.infer<typeof ConformanceOutcomeSchema>;

/** Why a scenario ran or did not: the manifest's claim, as resolved by `scenarioClaim`. */
export const SCENARIO_CLAIMS = ["supported", "base_invariant", "unsupported", "not_applicable"] as const;
export const ScenarioClaimSchema = z.enum(SCENARIO_CLAIMS);
export type ScenarioClaim = z.infer<typeof ScenarioClaimSchema>;

export const CONFORMANCE_FINDING_CODES = ["ADAPTER_CONFORMANCE_FAILED", "ADAPTER_SCENARIO_UNSUPPORTED", "ADAPTER_EVIDENCE_LEAK", "ADAPTER_DRIVER_ERROR", "ADAPTER_BOUNDARY_UNOBSERVED"] as const;
export type ConformanceFindingCode = (typeof CONFORMANCE_FINDING_CODES)[number];
/** Findings that make a scenario FAILED. `ADAPTER_SCENARIO_UNSUPPORTED` is informational. */
const FAILING_FINDINGS: ReadonlySet<string> = new Set(["ADAPTER_CONFORMANCE_FAILED", "ADAPTER_EVIDENCE_LEAK", "ADAPTER_DRIVER_ERROR", "ADAPTER_BOUNDARY_UNOBSERVED"]);

/**
 * The single claim → selection rule. A scenario of another kind does not
 * apply. One that requires nothing is a base invariant and always runs.
 * Otherwise it runs only if every required capability is declared
 * `supported`, and any `unsupported` declaration makes it UNSUPPORTED.
 * Conformance never infers support. A conservative under-claim is allowed
 * and simply skips the scenario.
 */
export function scenarioClaim(manifest: AdapterManifest, scenario: Pick<AdapterConformanceScenario, "kind" | "requires">): ScenarioClaim {
  if (scenario.kind !== manifest.kind) return "not_applicable";
  if (scenario.requires.length === 0) return "base_invariant";
  return scenario.requires.every((capability) => declaredSupport(manifest, capability) === "supported") ? "supported" : "unsupported";
}

const ScenarioIdSchema = identifierSchema.max(128);
const Hex64Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ConformanceCaseSchema = z
  .object({
    caseId: identifierSchema.max(128),
    comparisonKey: EvalComparisonKeySchema,
    expected: EvalExpectedVerdictSchema,
    actual: EvalVerdictSummarySchema,
    expectation: CaseExpectationVerdictSchema,
    semanticVerdictFingerprint: SemanticVerdictFingerprintSchema,
  })
  .strict();
export type ConformanceCase = z.infer<typeof ConformanceCaseSchema>;

export const ConformanceFindingSchema = z.object({ code: z.enum(CONFORMANCE_FINDING_CODES), scenarioId: ScenarioIdSchema, caseId: identifierSchema.max(128).optional() }).strict();
export type ConformanceFinding = z.infer<typeof ConformanceFindingSchema>;

export const AdapterScenarioResultSchema = z
  .object({
    scenarioId: ScenarioIdSchema,
    requires: z.array(AdapterCapabilitySchema).max(8),
    claim: ScenarioClaimSchema,
    status: ConformanceOutcomeSchema,
    cases: z.array(ConformanceCaseSchema).max(64),
  })
  .strict();
export type AdapterScenarioResult = z.infer<typeof AdapterScenarioResultSchema>;

const SummarySchema = z.object({ total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative(), notApplicable: z.number().int().nonnegative() }).strict();

/**
 * AdapterConformanceReport V1: deterministic, privacy-safe verification
 * evidence. It holds identifiers, claims, outcomes, codes, and fingerprints
 * only. It never holds provider payloads, secrets, or authority. A
 * serialized report never self-attests: consumers check it with
 * `validateAdapterConformanceReportIntegrity`, which recomputes every
 * derivable field.
 */
export const AdapterConformanceReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    conformanceVersion: z.literal(AAO_ADAPTER_CONFORMANCE_VERSION),
    adapter: z.object({ id: AdapterIdSchema, version: AdapterVersionSchema, kind: AdapterKindSchema, adapterContractVersion: z.literal(AAO_ADAPTER_CONTRACT_VERSION) }).strict(),
    manifestFingerprint: Hex64Schema,
    datasetRef: EvalDatasetRefSchema,
    scenarios: z.array(AdapterScenarioResultSchema).max(64),
    findings: z.array(ConformanceFindingSchema).max(256),
    summary: SummarySchema,
    fingerprint: Hex64Schema,
  })
  .strict();
export type AdapterConformanceReport = z.infer<typeof AdapterConformanceReportSchema>;

export interface AdapterConformanceReportInput {
  manifest: AdapterManifest;
  datasetRef: { id: string; version: string };
  scenarios: ReadonlyArray<{ scenarioId: string; requires: readonly string[]; claim: ScenarioClaim; cases: readonly ConformanceCase[] }>;
  findings: readonly ConformanceFinding[];
}

/**
 * Builds a report from judged scenarios. The outcome of every scenario,
 * the summary, and the fingerprint are *derived* here, never supplied. A
 * claimed or base scenario is PASSED only with at least one case, every
 * case MATCHED, and no failing finding.
 *
 * Building a valid report does not imply complete conformance. The input
 * may be any scenario subset (a development run), so the result is only
 * intact. Full conformance is `validateCompleteAdapterConformanceReport`,
 * and a PASS is `adapterConformancePassed`.
 */
export function buildAdapterConformanceReport(input: AdapterConformanceReportInput): AdapterConformanceReport {
  const { manifest } = input;
  const scenarios = input.scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    requires: [...scenario.requires],
    claim: scenario.claim,
    status: deriveStatus(scenario.claim, scenario.cases, input.findings.filter((finding) => finding.scenarioId === scenario.scenarioId)),
    cases: scenario.cases.map((entry) => jsonClone(entry)),
  }));
  const body = {
    schemaVersion: 1 as const,
    conformanceVersion: AAO_ADAPTER_CONFORMANCE_VERSION,
    adapter: { id: manifest.id, version: manifest.version, kind: manifest.kind, adapterContractVersion: AAO_ADAPTER_CONTRACT_VERSION },
    manifestFingerprint: adapterManifestFingerprint(manifest),
    datasetRef: { id: input.datasetRef.id, version: input.datasetRef.version },
    scenarios,
    findings: input.findings.map((finding) => ({ ...finding })),
    summary: summarize(scenarios),
  };
  const report = AdapterConformanceReportSchema.parse({ ...body, fingerprint: sha256Hex(body) });
  return deepFreeze(report);
}

export type AdapterConformanceReportIntegrity = { ok: true; report: AdapterConformanceReport } | { ok: false; issues: string[] };

/**
 * Rejects a self-attesting report. It recomputes the outcome of every
 * scenario from its claim, cases, and findings, the summary counts, and the
 * fingerprint, and checks that claims and cases agree. With `manifest`, it
 * also checks that the report is about exactly that manifest (identity and
 * manifest fingerprint).
 *
 * Internal report consistency does not prove complete AAO conformance.
 * Integrity says nothing about which scenarios were run.
 */
export function validateAdapterConformanceReportIntegrity(input: unknown, manifest?: AdapterManifest): AdapterConformanceReportIntegrity {
  const parsed = AdapterConformanceReportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(report)"}: ${issue.message}`) };
  const report = parsed.data;
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const scenario of report.scenarios) {
    if (ids.has(scenario.scenarioId)) issues.push(`scenarios: ${scenario.scenarioId} appears more than once`);
    ids.add(scenario.scenarioId);
    const findings = report.findings.filter((finding) => finding.scenarioId === scenario.scenarioId);
    const expected = deriveStatus(scenario.claim, scenario.cases, findings);
    if (scenario.status !== expected) issues.push(`scenarios.${scenario.scenarioId}.status: ${scenario.status} contradicts its claim, cases, and findings (expected ${expected})`);
    if ((scenario.claim === "unsupported" || scenario.claim === "not_applicable") && scenario.cases.length > 0) issues.push(`scenarios.${scenario.scenarioId}.cases: a scenario that did not run has no cases`);
    if (scenario.claim === "base_invariant" && scenario.requires.length > 0) issues.push(`scenarios.${scenario.scenarioId}.claim: a base invariant requires no capability`);
    if ((scenario.claim === "supported" || scenario.claim === "unsupported") && scenario.requires.length === 0) issues.push(`scenarios.${scenario.scenarioId}.claim: a ${scenario.claim} claim needs required capabilities`);
  }
  for (const finding of report.findings) if (!ids.has(finding.scenarioId)) issues.push(`findings: ${finding.code} names unknown scenario ${finding.scenarioId}`);
  const summary = summarize(report.scenarios);
  for (const key of Object.keys(summary) as Array<keyof typeof summary>) {
    if (report.summary[key] !== summary[key]) issues.push(`summary.${key}: ${report.summary[key]} does not match the scenarios (${summary[key]})`);
  }
  const { fingerprint, ...body } = report;
  if (fingerprint !== sha256Hex(body)) issues.push("fingerprint: does not match the report content");
  if (manifest !== undefined) {
    if (report.adapter.id !== manifest.id || report.adapter.version !== manifest.version || report.adapter.kind !== manifest.kind) issues.push("adapter: report identity does not match the manifest");
    if (report.manifestFingerprint !== adapterManifestFingerprint(manifest)) issues.push("manifestFingerprint: report was not produced for this manifest");
  }
  return issues.length === 0 ? { ok: true, report } : { ok: false, issues };
}

export type AdapterConformanceCompletenessCode = Extract<
  AdapterContractErrorCode,
  "ADAPTER_CONFORMANCE_REPORT_INVALID" | "ADAPTER_CONFORMANCE_INCOMPLETE" | "ADAPTER_CONFORMANCE_DATASET_MISMATCH" | "ADAPTER_CONFORMANCE_SCENARIO_MISSING" | "ADAPTER_CONFORMANCE_SCENARIO_UNEXPECTED" | "ADAPTER_CONFORMANCE_SCENARIO_MISMATCH" | "ADAPTER_CONFORMANCE_CLAIM_MISMATCH"
>;
export type AdapterConformanceCompleteness = { ok: true; report: AdapterConformanceReport } | { ok: false; codes: AdapterConformanceCompletenessCode[]; issues: string[] };

/**
 * Full conformance, distinct from integrity. Integrity proves a report is
 * internally consistent. It does not prove the report covers the suite: an
 * intact report with no scenarios has `failed = 0`. This check requires, for
 * exactly this manifest:
 *
 * - integrity (`ADAPTER_CONFORMANCE_REPORT_INVALID`);
 * - the canonical dataset id and version (`ADAPTER_CONFORMANCE_DATASET_MISMATCH`);
 * - every canonical scenario of the manifest's kind (`ADAPTER_CONFORMANCE_SCENARIO_MISSING`)
 *   and no other (`ADAPTER_CONFORMANCE_SCENARIO_UNEXPECTED`). A kind with no
 *   canonical scenario cannot be complete (`ADAPTER_CONFORMANCE_INCOMPLETE`);
 * - each scenario's `requires` and, for one that ran with cases, its exact
 *   canonical case ids and expectations (`ADAPTER_CONFORMANCE_SCENARIO_MISMATCH`);
 * - each claim equal to `scenarioClaim(manifest, canonical scenario)`, so a
 *   report can neither downgrade nor upgrade what the manifest declares
 *   (`ADAPTER_CONFORMANCE_CLAIM_MISMATCH`).
 *
 * A partial report (a scenario subset, as development runs produce) stays
 * a valid, intact report for inspection. It is never complete.
 */
export function validateCompleteAdapterConformanceReport(input: unknown, manifest: AdapterManifest): AdapterConformanceCompleteness {
  const integrity = validateAdapterConformanceReportIntegrity(input, manifest);
  if (!integrity.ok) return { ok: false, codes: ["ADAPTER_CONFORMANCE_REPORT_INVALID"], issues: integrity.issues };
  const report = integrity.report;
  const failures: Array<{ code: AdapterConformanceCompletenessCode; issue: string }> = [];
  const fail = (code: AdapterConformanceCompletenessCode, issue: string) => failures.push({ code, issue });

  const dataset = ADAPTER_CONFORMANCE_SUITE.dataset;
  if (report.datasetRef.id !== dataset.id || report.datasetRef.version !== dataset.version) fail("ADAPTER_CONFORMANCE_DATASET_MISMATCH", `datasetRef: ${report.datasetRef.id}@${report.datasetRef.version} is not the canonical ${dataset.id}@${dataset.version}`);

  const canonical = conformanceScenariosForKind(manifest.kind);
  if (canonical.length === 0) fail("ADAPTER_CONFORMANCE_INCOMPLETE", `kind ${manifest.kind} has no canonical conformance scenario, so nothing can be fully verified`);
  const reported = new Map(report.scenarios.map((scenario) => [scenario.scenarioId, scenario] as const));
  for (const scenario of canonical) if (!reported.has(scenario.id)) fail("ADAPTER_CONFORMANCE_SCENARIO_MISSING", `scenarios: canonical scenario ${scenario.id} is missing`);
  const expectedIds = new Set(canonical.map((scenario) => scenario.id));
  for (const scenario of report.scenarios) if (!expectedIds.has(scenario.scenarioId)) fail("ADAPTER_CONFORMANCE_SCENARIO_UNEXPECTED", `scenarios: ${scenario.scenarioId} is not a canonical ${manifest.kind} scenario`);

  for (const scenario of canonical) {
    const entry = reported.get(scenario.id);
    if (entry === undefined) continue;
    if (entry.requires.length !== scenario.requires.length || entry.requires.some((capability, index) => capability !== scenario.requires[index])) fail("ADAPTER_CONFORMANCE_SCENARIO_MISMATCH", `scenarios.${scenario.id}.requires: does not match the canonical scenario`);
    const claim = scenarioClaim(manifest, scenario);
    if (entry.claim !== claim) fail("ADAPTER_CONFORMANCE_CLAIM_MISMATCH", `scenarios.${scenario.id}.claim: ${entry.claim} is not the manifest-derived ${claim}`);
    // A scenario that ran either has no cases (a driver error, already FAILED) or exactly the canonical cases.
    if (entry.cases.length === 0) continue;
    const ref = conformanceScenarioEvidenceRef(scenario.id);
    const canonicalCases = dataset.cases.filter((evalCase) => evalCase.evidenceRef === ref);
    const sameCases = entry.cases.length === canonicalCases.length && canonicalCases.every((evalCase) => entry.cases.some((judged) => judged.caseId === evalCase.id && sha256Hex(judged.expected) === sha256Hex(evalCase.expected)));
    if (!sameCases) fail("ADAPTER_CONFORMANCE_SCENARIO_MISMATCH", `scenarios.${scenario.id}.cases: do not match the canonical cases`);
  }
  if (failures.length > 0) return { ok: false, codes: [...new Set(failures.map((failure) => failure.code))], issues: failures.map((failure) => `${failure.code}: ${failure.issue}`) };
  return { ok: true, report };
}

/**
 * "AAO conformance v1 PASS": a complete report for exactly this manifest
 * (`validateCompleteAdapterConformanceReport`) with no FAILED scenario and
 * at least one PASSED scenario. An intact report is not enough: an empty or
 * partial report never passes, and neither does one that verified nothing.
 * UNSUPPORTED and NOT_APPLICABLE never count as passes.
 */
export function adapterConformancePassed(report: unknown, manifest: AdapterManifest): boolean {
  const complete = validateCompleteAdapterConformanceReport(report, manifest);
  return complete.ok && complete.report.conformanceVersion === AAO_ADAPTER_CONFORMANCE_VERSION && complete.report.summary.failed === 0 && complete.report.summary.passed > 0;
}

function deriveStatus(claim: ScenarioClaim, cases: readonly ConformanceCase[], findings: readonly ConformanceFinding[]): ConformanceOutcome {
  if (claim === "not_applicable") return "NOT_APPLICABLE";
  if (claim === "unsupported") return "UNSUPPORTED";
  const failing = findings.some((finding) => FAILING_FINDINGS.has(finding.code));
  return cases.length > 0 && cases.every((entry) => entry.expectation === "MATCHED") && !failing ? "PASSED" : "FAILED";
}

function summarize(scenarios: ReadonlyArray<{ status: ConformanceOutcome }>) {
  const count = (status: ConformanceOutcome) => scenarios.filter((scenario) => scenario.status === status).length;
  return { total: scenarios.length, passed: count("PASSED"), failed: count("FAILED"), unsupported: count("UNSUPPORTED"), notApplicable: count("NOT_APPLICABLE") };
}
