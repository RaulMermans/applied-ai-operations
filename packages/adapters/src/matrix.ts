import { z } from "zod";
import { EvalDatasetRefSchema, identifierSchema } from "@aao/contracts";
import { ADAPTER_KINDS, AdapterCapabilitySchema, AdapterKindSchema, CapabilitySupportSchema, capabilitiesForKind } from "./capabilities.js";
import { ConformanceOutcomeSchema, validateAdapterConformanceReportIntegrity, type AdapterConformanceReport, type ConformanceOutcome } from "./conformance/report.js";
import { conformanceScenariosForKind } from "./conformance/scenarios.js";
import { AdapterContractError } from "./errors.js";
import { deepFreeze } from "./json.js";
import { AdapterIdSchema, AdapterLimitationSchema, AdapterVersionSchema, adapterManifestFingerprint, declaredSupport, validateAdapterManifest } from "./manifest.js";
import { AAO_ADAPTER_CONFORMANCE_VERSION, AAO_ADAPTER_CONTRACT_VERSION } from "./version.js";

const CapabilityRowSchema = z
  .object({
    capability: AdapterCapabilitySchema,
    declared: CapabilitySupportSchema,
    /** Derived from the scenarios that require this capability: never typed by hand. */
    conformance: ConformanceOutcomeSchema,
    scenarios: z.array(identifierSchema.max(128)),
  })
  .strict();

const AdapterEntrySchema = z
  .object({
    id: AdapterIdSchema,
    version: AdapterVersionSchema,
    kind: AdapterKindSchema,
    adapterContractVersion: z.literal(AAO_ADAPTER_CONTRACT_VERSION),
    /** True for the native AAO semantic reference of its kind; false for a substrate adapter. */
    reference: z.boolean(),
    manifestFingerprint: z.string(),
    reportFingerprint: z.string(),
    conformance: z.enum(["PASSED", "FAILED"]),
    capabilities: z.array(CapabilityRowSchema),
    baseInvariants: z.array(z.object({ scenarioId: identifierSchema.max(128), status: ConformanceOutcomeSchema }).strict()),
    limitations: z.array(AdapterLimitationSchema),
  })
  .strict();

const DeferredEntrySchema = z.object({ id: identifierSchema.max(128), kind: AdapterKindSchema, status: z.literal("DEFERRED"), reason: z.string().min(1).max(300) }).strict();
export type DeferredAdapterEntry = z.infer<typeof DeferredEntrySchema>;

/**
 * The compatibility matrix: product and documentation evidence, generated
 * from manifests plus intact conformance reports. It is not runtime
 * authority. It cannot enable an adapter, authorize an actor, or grant a
 * permission. A deferred substrate (LangGraph) is listed outside the
 * conformance vocabulary, because no adapter exists to verify.
 */
export const AdapterCompatibilityMatrixSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapterContractVersion: z.literal(AAO_ADAPTER_CONTRACT_VERSION),
    conformanceVersion: z.literal(AAO_ADAPTER_CONFORMANCE_VERSION),
    datasetRef: EvalDatasetRefSchema,
    authority: z.literal("none"),
    adapters: z.array(AdapterEntrySchema),
    deferred: z.array(DeferredEntrySchema),
  })
  .strict();
export type AdapterCompatibilityMatrix = z.infer<typeof AdapterCompatibilityMatrixSchema>;

export interface AdapterMatrixEntryInput {
  manifest: unknown;
  report: unknown;
  /** True for the native AAO semantic reference of its kind, false for a substrate adapter. */
  reference: boolean;
}

/**
 * Pure and deterministic. Each report must be intact and produced for its
 * manifest (`ADAPTER_CONFORMANCE_REPORT_INVALID` otherwise). Each
 * capability's conformance cell is derived from the report's own scenario
 * outcomes, never from the manifest. Entries are ordered by kind, then
 * reference before adapter, then id and version.
 */
export function buildAdapterCompatibilityMatrix(params: { entries: readonly AdapterMatrixEntryInput[]; deferred?: readonly DeferredAdapterEntry[] }): AdapterCompatibilityMatrix {
  let datasetRef: AdapterConformanceReport["datasetRef"] | undefined;
  const adapters = params.entries.map((entry) => {
    const validated = validateAdapterManifest(entry.manifest);
    if (!validated.ok) throw new AdapterContractError(validated.code, "matrix entry manifest is invalid", validated.issues);
    const manifest = validated.manifest;
    const integrity = validateAdapterConformanceReportIntegrity(entry.report, manifest);
    if (!integrity.ok) throw new AdapterContractError("ADAPTER_CONFORMANCE_REPORT_INVALID", `conformance report for ${manifest.id}@${manifest.version} is not intact`, integrity.issues);
    const report = integrity.report;
    if (datasetRef !== undefined && (datasetRef.id !== report.datasetRef.id || datasetRef.version !== report.datasetRef.version)) throw new AdapterContractError("ADAPTER_CONFORMANCE_REPORT_INVALID", "every report in one matrix must come from the same conformance dataset");
    datasetRef = report.datasetRef;
    const scenarios = conformanceScenariosForKind(manifest.kind);
    const statusOf = new Map(report.scenarios.map((scenario) => [scenario.scenarioId, scenario.status] as const));
    const capabilities = capabilitiesForKind(manifest.kind).map((capability) => {
      const declared = declaredSupport(manifest, capability)!;
      const covering = scenarios.filter((scenario) => scenario.requires.includes(capability)).map((scenario) => scenario.id);
      if (covering.length === 0) throw new AdapterContractError("ADAPTER_CONFORMANCE_REPORT_INVALID", `capability ${capability} has no canonical scenario`);
      const statuses = covering.map((id) => statusOf.get(id));
      if (statuses.some((status) => status === undefined)) throw new AdapterContractError("ADAPTER_CONFORMANCE_REPORT_INVALID", `report for ${manifest.id}@${manifest.version} is missing scenarios for ${capability}`);
      return { capability, declared, conformance: capabilityOutcome(declared, statuses as ConformanceOutcome[]), scenarios: covering };
    });
    const baseInvariants = scenarios.filter((scenario) => scenario.requires.length === 0).map((scenario) => ({ scenarioId: scenario.id, status: statusOf.get(scenario.id) ?? ("FAILED" as const) }));
    return {
      id: manifest.id,
      version: manifest.version,
      kind: manifest.kind,
      adapterContractVersion: AAO_ADAPTER_CONTRACT_VERSION,
      reference: entry.reference,
      manifestFingerprint: adapterManifestFingerprint(manifest),
      reportFingerprint: report.fingerprint,
      conformance: report.summary.failed === 0 && baseInvariants.every((invariant) => invariant.status === "PASSED") ? ("PASSED" as const) : ("FAILED" as const),
      capabilities,
      baseInvariants,
      limitations: (manifest.limitations ?? []).map((limitation) => ({ ...limitation })),
    };
  });
  if (datasetRef === undefined) throw new AdapterContractError("ADAPTER_CONFORMANCE_REPORT_INVALID", "a matrix needs at least one verified adapter");
  const kindOrder = ADAPTER_KINDS as readonly string[];
  adapters.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || (a.reference === b.reference ? 0 : a.reference ? -1 : 1) || compare(a.id, b.id) || compare(a.version, b.version));
  const deferred = [...(params.deferred ?? [])].map((entry) => DeferredEntrySchema.parse(entry)).sort((a, b) => compare(a.id, b.id));
  return deepFreeze(AdapterCompatibilityMatrixSchema.parse({ schemaVersion: 1, adapterContractVersion: AAO_ADAPTER_CONTRACT_VERSION, conformanceVersion: AAO_ADAPTER_CONFORMANCE_VERSION, datasetRef, authority: "none", adapters, deferred }));
}

/**
 * A declared-unsupported capability is UNSUPPORTED. A supported claim is
 * PASSED only if at least one covering scenario actually ran and every one
 * that ran passed. A scenario skipped because it also needs another,
 * unsupported capability verifies nothing, and a claim nothing verified is
 * never PASSED.
 */
function capabilityOutcome(declared: "supported" | "unsupported", statuses: readonly ConformanceOutcome[]): ConformanceOutcome {
  if (declared === "unsupported") return "UNSUPPORTED";
  const ran = statuses.filter((status) => status === "PASSED" || status === "FAILED");
  return ran.length > 0 && ran.every((status) => status === "PASSED") ? "PASSED" : "FAILED";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
