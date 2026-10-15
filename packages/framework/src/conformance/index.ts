// @aao/framework/conformance — public adapter conformance verification
// (Sprint 20, ADR-025). An explicit subpath, never re-exported from the
// root.
//
// A third-party adapter author imports their adapter, writes a subject (its
// manifest plus a fresh adapter or Tool binding per scenario), and calls
// `verifyAdapterConformance`. This module supplies the canonical suite from
// @aao/adapters, the canonical harness (a real AAO Run per scenario), and
// the Evaluation Runtime's judgment. There is no discovery, no module
// loading, and no repository path. A report claims "AAO conformance v1
// PASS" only when `adapterConformancePassed(report, manifest)` holds for it.
// That requires a complete report (every canonical scenario of the kind,
// manifest-derived claims, canonical dataset), not only an intact one.
import { ADAPTER_CONFORMANCE_SUITE, type AdapterConformanceReport, type AdapterConformanceScenario } from "@aao/adapters";
import { createEvaluatorRegistry, deterministicGraders, evaluateAdapterConformance } from "@aao/evaluation";
import { createConformanceDriver, type AdapterConformanceSubject } from "./harness.js";

export { createConformanceDriver, conformanceToolSpec, type AdapterConformanceSubject, type ModelConformanceSubject, type ToolProviderConformanceSubject, type ToolProviderHostBinding } from "./harness.js";
export { NATIVE_MODEL_REFERENCE_MANIFEST, NATIVE_TOOL_REFERENCE_MANIFEST, nativeModelReference, nativeToolReference } from "./references.js";
export { compareAdapterConformance, type AdapterPortabilityResult } from "@aao/evaluation";
export { adapterConformancePassed, buildAdapterCompatibilityMatrix, validateAdapterConformanceReportIntegrity, validateCompleteAdapterConformanceReport, type AdapterCompatibilityMatrix, type AdapterConformanceCompleteness } from "@aao/adapters";

/**
 * Verifies one adapter against the canonical conformance suite v1 and
 * returns an intact `AdapterConformanceReport`. The subject's manifest
 * decides which scenarios run. Every running scenario executes a real AAO
 * Run and is judged by the canonical Eval definitions. A false support
 * claim fails. Pass `scenarios` only to restrict the canonical list for a
 * development run. It cannot add a scenario. A restricted run returns a
 * partial report: intact and inspectable, but never complete, so
 * `adapterConformancePassed` is false for it.
 */
export async function verifyAdapterConformance(params: { subject: AdapterConformanceSubject; scenarios?: readonly AdapterConformanceScenario[] }): Promise<AdapterConformanceReport> {
  return evaluateAdapterConformance({
    manifest: params.subject.manifest,
    driver: createConformanceDriver(params.subject),
    registry: createEvaluatorRegistry(deterministicGraders()),
    suite: ADAPTER_CONFORMANCE_SUITE,
    ...(params.scenarios ? { scenarios: params.scenarios } : {}),
  });
}
