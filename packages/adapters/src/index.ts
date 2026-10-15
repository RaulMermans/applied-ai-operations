// @aao/adapters — the vendor-free AAO adapter and portability contract
// (Sprint 20, ADR-025, docs/architecture/adapter-contract.md).
//
// It owns the cross-kind adapter envelope: the contract and conformance
// versions, the adapter-kind taxonomy, the canonical capability catalog,
// AdapterManifest V1, exact adapter references, registration-time
// compatibility, the canonical conformance suite (scenarios, Eval
// definitions, dataset), the public conformance vocabulary and
// AdapterConformanceReport V1 with integrity validation and the separate
// full-conformance (completeness) validation, and the
// generated compatibility matrix.
//
// It depends only on @aao/contracts and zod. It imports no vendor SDK, no
// protocol SDK, no execution package, and no Evaluation. Executable ports
// stay kind-specific with their owners: the ModelAdapter port belongs to
// @aao/model-runtime, and Tool providers bind to the Tool Runtime's
// RegisteredTool. Judging conformance evidence is @aao/evaluation's job.
// A manifest is metadata, never authority.

export { AAO_ADAPTER_CONTRACT_VERSION, AAO_ADAPTER_CONFORMANCE_VERSION } from "./version.js";
export { ADAPTER_CONTRACT_ERROR_CODES, AdapterContractError, type AdapterContractErrorCode } from "./errors.js";
export {
  ADAPTER_KINDS,
  AdapterKindSchema,
  ADAPTER_CAPABILITY_CATALOG,
  ADAPTER_CAPABILITIES,
  AdapterCapabilitySchema,
  CAPABILITY_SUPPORT,
  CapabilitySupportSchema,
  capabilitiesForKind,
  type AdapterKind,
  type AdapterCapability,
  type ModelAdapterCapability,
  type ToolProviderAdapterCapability,
  type CapabilitySupport,
} from "./capabilities.js";
export {
  AdapterManifestSchema,
  AdapterCapabilityDeclarationSchema,
  AdapterLimitationSchema,
  AdapterRefSchema,
  AdapterIdSchema,
  AdapterVersionSchema,
  defineAdapterManifest,
  validateAdapterManifest,
  adapterManifestFingerprint,
  declaredSupport,
  supportedCapabilities,
  adapterRefOf,
  adapterRefKey,
  type AdapterManifest,
  type AdapterManifestInput,
  type AdapterManifestValidation,
  type AdapterCapabilityDeclaration,
  type AdapterLimitation,
  type AdapterRef,
} from "./manifest.js";
export { checkAdapterCompatibility, type AdapterCompatibilityRequirements, type AdapterCompatibilityResult, type AdapterCompatibilityMismatch } from "./compatibility.js";
export {
  ADAPTER_CONFORMANCE_SCENARIOS,
  conformanceScenariosForKind,
  conformanceScenarioEvidenceRef,
  type AdapterConformanceScenario,
  type ToolScenarioOutcome,
  type ModelScenarioOutcome,
} from "./conformance/scenarios.js";
export { ADAPTER_CONFORMANCE_SUITE, type AdapterConformanceSuite } from "./conformance/suite.js";
export {
  CONFORMANCE_OUTCOMES,
  ConformanceOutcomeSchema,
  SCENARIO_CLAIMS,
  ScenarioClaimSchema,
  CONFORMANCE_FINDING_CODES,
  ConformanceCaseSchema,
  ConformanceFindingSchema,
  AdapterScenarioResultSchema,
  AdapterConformanceReportSchema,
  scenarioClaim,
  buildAdapterConformanceReport,
  validateAdapterConformanceReportIntegrity,
  validateCompleteAdapterConformanceReport,
  adapterConformancePassed,
  type ConformanceOutcome,
  type ScenarioClaim,
  type ConformanceFindingCode,
  type ConformanceCase,
  type ConformanceFinding,
  type AdapterScenarioResult,
  type AdapterConformanceReport,
  type AdapterConformanceReportInput,
  type AdapterConformanceReportIntegrity,
  type AdapterConformanceCompleteness,
  type AdapterConformanceCompletenessCode,
} from "./conformance/report.js";
export { AdapterCompatibilityMatrixSchema, buildAdapterCompatibilityMatrix, type AdapterCompatibilityMatrix, type AdapterMatrixEntryInput, type DeferredAdapterEntry } from "./matrix.js";
