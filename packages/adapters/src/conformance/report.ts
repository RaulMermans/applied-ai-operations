import { z } from "zod";
import { CaseExpectationVerdictSchema, EvalComparisonKeySchema, EvalDatasetRefSchema, EvalExpectedVerdictSchema, EvalVerdictSummarySchema, SemanticVerdictFingerprintSchema, identifierSchema } from "@aao/contracts";
import { AdapterCapabilitySchema, AdapterKindSchema } from "../capabilities.js";
import { deepFreeze, jsonClone, sha256Hex } from "../json.js";
import { AdapterIdSchema, AdapterVersionSchema, adapterManifestFingerprint, declaredSupport, type AdapterManifest } from "../manifest.js";
import { AAO_ADAPTER_CONFORMANCE_VERSION, AAO_ADAPTER_CONTRACT_VERSION } from "../version.js";
import type { AdapterConformanceScenario } from "./scenarios.js";

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

/** "AAO conformance v1 PASS": an intact report of this suite version with no FAILED scenario. */
export function adapterConformancePassed(report: unknown, manifest?: AdapterManifest): boolean {
  const integrity = validateAdapterConformanceReportIntegrity(report, manifest);
  return integrity.ok && integrity.report.conformanceVersion === AAO_ADAPTER_CONFORMANCE_VERSION && integrity.report.summary.failed === 0;
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
