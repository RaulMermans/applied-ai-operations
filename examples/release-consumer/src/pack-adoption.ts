import { CANONICAL_CAPABILITY_PACKS } from "@aao/capability-packs";
import {
  createStandardPackCatalog,
  resolveCompanyCapabilityPacks,
  type CompanyResearchFacade,
} from "@aao/example-capability-packs";
import {
  NORTHSTAR_PACK_SELECTION,
  ARBOR_PACK_SELECTION,
  NORTHSTAR_RESEARCH_REQUEST,
  createTestHostEnvironment,
} from "@aao/example-capability-packs/fixtures";
import { createCompanyAAO, NORTHSTAR_MANIFEST, ARBOR_MANIFEST } from "@aao/example-company-portability";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import {
  COMPANY_RESEARCH_PACK,
  CANONICAL_NORTHSTAR_MANIFEST,
  createCanonicalDemoInspectionSource,
  createOperatorInspectionService,
  createVerifiedRegistrationEvidenceForCompany,
  projectPackCompatibilitySummary,
} from "@aao/operator-inspection";

export async function runPackAdoptionJourney() {
  const catalog = createStandardPackCatalog();
  const store = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store });
  const env = createTestHostEnvironment();

  const northstar = createCompanyAAO({
    manifest: NORTHSTAR_MANIFEST,
    hostCapabilities: env.hostCapabilities,
    principalForRun: env.northstarPrincipalForRun,
    trace,
  });
  const arbor = createCompanyAAO({
    manifest: ARBOR_MANIFEST,
    hostCapabilities: env.hostCapabilities,
    principalForRun: env.arborPrincipalForRun,
    trace,
  });

  const northstarPacks = resolveCompanyCapabilityPacks({
    company: northstar,
    catalog,
    selection: NORTHSTAR_PACK_SELECTION,
    hostCapabilities: env.hostCapabilities,
  });
  const arborPacks = resolveCompanyCapabilityPacks({
    company: arbor,
    catalog,
    selection: ARBOR_PACK_SELECTION,
    hostCapabilities: env.hostCapabilities,
  });

  const identities = CANONICAL_CAPABILITY_PACKS.map((pack) => pack.identity);
  const northstarReports = identities.map((identity) => northstarPacks.getPack(identity).compatibilityReport);
  const arborReports = identities.map((identity) => arborPacks.getPack(identity).compatibilityReport);

  const research = northstarPacks.getPack<CompanyResearchFacade>("aao.company-research@1.0.0");
  const executed = await research.facade.run({
    runId: "run.release.ns.cr",
    request: NORTHSTAR_RESEARCH_REQUEST,
  });

  const demoSource = await createCanonicalDemoInspectionSource();
  const demo = createOperatorInspectionService(demoSource);
  const demoPacks = await demo.listCapabilityPacks();
  const demoUnverified = demoPacks.compatibility.every((item) => item.status === "NOT_VERIFIED" && !item.verified);

  const missingEvidence = projectPackCompatibilitySummary({
    companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
    pack: COMPANY_RESEARCH_PACK,
    registrationEvidence: undefined,
  });
  const verifiedEvidence = projectPackCompatibilitySummary({
    companyManifest: CANONICAL_NORTHSTAR_MANIFEST,
    pack: COMPANY_RESEARCH_PACK,
    registrationEvidence: createVerifiedRegistrationEvidenceForCompany("northstar-commerce").company_research,
  });

  return {
    packCount: catalog.listCapabilityPacks().length,
    identities,
    northstarCompatible: northstarReports.every((report) => report.compatible === true),
    arborCompatible: arborReports.every((report) => report.compatible === true),
    fingerprintsMatch: identities.every((identity) => {
      const ns = northstarPacks.getPack(identity);
      const arb = arborPacks.getPack(identity);
      return ns.workflowPlanFingerprint === arb.workflowPlanFingerprint && ns.packFingerprint === arb.packFingerprint;
    }),
    executedStatus: executed.status,
    demoUnverified,
    missingEvidenceStatus: missingEvidence.status,
    verifiedEvidenceStatus: verifiedEvidence.status,
  };
}
