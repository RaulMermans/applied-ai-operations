import process from "node:process";
import {
  CANONICAL_NORTHSTAR_MANIFEST,
  COMPANY_RESEARCH_PACK,
  buildCanonicalTraceFixtures,
  createCanonicalDemoInspectionSource,
  createOperatorInspectionService,
  createVerifiedRegistrationEvidenceForCompany,
  formatAdvancedRunInspectionNodesText,
  formatAdvancedRunInspectionTimelineText,
  formatIntegrationDiagnosticsText,
  formatOverviewText,
  formatRunInspectionText,
  projectIntegrationDiagnostics,
} from "@aao/operator-inspection";

const section = (title: string, body: string) => process.stdout.write(`--- ${title} ---\n${body}\n`);

async function main(): Promise<void> {
  process.stdout.write("=== Sprint 28: Operator Inspection Demo (offline, read-only, fixture evidence) ===\n\n");

  // Measured side effects: any network call or evidence mutation during inspection is counted.
  let networkCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { networkCalls += 1; return realFetch(...args); }) as typeof fetch;
  const { tracesByRunId } = await buildCanonicalTraceFixtures();
  const evidenceBefore = JSON.stringify([tracesByRunId, CANONICAL_NORTHSTAR_MANIFEST]);

  const service = createOperatorInspectionService(await createCanonicalDemoInspectionSource({ includeExtendedRuns: true }));
  section("Overview", formatOverviewText(await service.getOverview()));

  const verified = createVerifiedRegistrationEvidenceForCompany("northstar-commerce").company_research!;
  const diagnose = (registrationEvidence: typeof verified) =>
    formatIntegrationDiagnosticsText(projectIntegrationDiagnostics({ companyManifest: CANONICAL_NORTHSTAR_MANIFEST, pack: COMPANY_RESEARCH_PACK, registrationEvidence }));
  section("Readiness: fully verified compatible Pack", diagnose(verified));
  section("Readiness: several requirements missing at once (Tools, Model Policies, Eval profile)", diagnose({ ...verified, registeredTools: [], registeredModelPolicies: [], registeredEvalProfiles: [] }));
  section("Readiness: adapter evidence absent -> model capability NOT_VERIFIED", diagnose({ ...verified, registeredModelAdapters: undefined }));

  section("Run with an explicit Tool retry (run.northstar.cr.retry)", formatAdvancedRunInspectionTimelineText(await service.getAdvancedRunInspection("run.northstar.cr.retry")));
  section("Repeated node at a different step, usage recorded for 1 of 2 model invocations -> PARTIAL tokens (run.northstar.cr.repeat)", formatAdvancedRunInspectionNodesText(await service.getAdvancedRunInspection("run.northstar.cr.repeat")));
  section("Recovery replay (run.northstar.ops.recovery)", formatAdvancedRunInspectionTimelineText(await service.getAdvancedRunInspection("run.northstar.ops.recovery")));
  section("Incomplete Run without authoritative state (run.arbor.cr.incomplete)", formatRunInspectionText(await service.getRunInspection("run.arbor.cr.incomplete")));

  globalThis.fetch = realFetch;
  const mutations = JSON.stringify([tracesByRunId, CANONICAL_NORTHSTAR_MANIFEST]) === evidenceBefore ? 0 : 1;
  section("Side effects measured during inspection", `Network calls: ${networkCalls}\nEvidence mutations: ${mutations}\n(The inspection package has no dependency able to call models, Tools, approvals, workflows or Evals.)`);
  if (networkCalls !== 0 || mutations !== 0) throw new Error("Inspection produced side effects");
  process.stdout.write("Demo completed successfully (no execution, approval, or write occurred).\n");
}

main().catch((err) => {
  process.stderr.write(`Demo failed: ${String(err)}\n`);
  process.exit(1);
});
