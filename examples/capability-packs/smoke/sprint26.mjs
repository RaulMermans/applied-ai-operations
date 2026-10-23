// Sprint 26 compiled smoke: Capability Packs & Reusable Business Templates proof using compiled package output only.
// Runs after `pnpm build`. Every AAO import resolves through package exports / dist.
// No network, external API keys, or external databases.

import process from "node:process";
import {
  defineCapabilityPack,
  createCapabilityPackCatalog,
  validateCapabilityPackManifest,
  validatePackCompatibility,
  CapabilityPackError,
  COMPANY_RESEARCH_PACK,
  COMPANY_RESEARCH_PACK_MANIFEST,
  DOCUMENT_INTELLIGENCE_PACK,
  DOCUMENT_INTELLIGENCE_PACK_MANIFEST,
  OPERATIONAL_REQUEST_PACK,
  OPERATIONAL_REQUEST_PACK_MANIFEST,
  CANONICAL_CAPABILITY_PACKS,
} from "@aao/capability-packs";
import {
  createCompanyAAO,
  CompanyAdmissionError,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_ACTORS,
} from "@aao/example-company-portability";
import {
  createInMemoryTraceStore,
  createTraceRecorder,
} from "@aao/observability";
import {
  createStandardPackCatalog,
  resolveCompanyCapabilityPacks,
  evaluatePackRun,
  EVAL_PROFILES,
} from "../dist/src/index.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_PACK_SELECTION,
  ARBOR_PACK_SELECTION,
  NORTHSTAR_RESEARCH_REQUEST,
  ARBOR_RESEARCH_REQUEST,
  NORTHSTAR_DOC_REQUEST,
  ARBOR_DOC_REQUEST,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
} from "../dist/fixtures/index.js";

const assert = (condition, message) => {
  if (!condition) {
    process.stderr.write(`Smoke Assertion Failed: ${message}\n`);
    throw new Error(message);
  }
};

process.stdout.write("Starting Sprint 26 Compiled Smoke Verification...\n");

// 1. Three manifests validate
const crManifest = validateCapabilityPackManifest(COMPANY_RESEARCH_PACK_MANIFEST);
const diManifest = validateCapabilityPackManifest(DOCUMENT_INTELLIGENCE_PACK_MANIFEST);
const orManifest = validateCapabilityPackManifest(OPERATIONAL_REQUEST_PACK_MANIFEST);
assert(crManifest.schemaVersion === 1 && crManifest.id === "aao.company-research", "Step 1: Company Research manifest invalid");
assert(diManifest.schemaVersion === 1 && diManifest.id === "aao.document-intelligence", "Step 1: Document Intelligence manifest invalid");
assert(orManifest.schemaVersion === 1 && orManifest.id === "aao.operational-request", "Step 1: Operational Request manifest invalid");

// 2. Exact Pack versions resolve
const catalog = createStandardPackCatalog();
assert(catalog.listCapabilityPacks().length === 3, "Step 2: Expected 3 packs in standard catalog");
assert(catalog.getCapabilityPack("aao.company-research@1.0.0")?.identity === "aao.company-research@1.0.0", "Step 2: CR pack lookup failed");
assert(catalog.getCapabilityPack("aao.document-intelligence@1.0.0")?.identity === "aao.document-intelligence@1.0.0", "Step 2: DI pack lookup failed");
assert(catalog.getCapabilityPack("aao.operational-request@1.0.0")?.identity === "aao.operational-request@1.0.0", "Step 2: OR pack lookup failed");

// 3. Pack fingerprints are deterministic
const crPackClone = defineCapabilityPack(JSON.parse(JSON.stringify(COMPANY_RESEARCH_PACK_MANIFEST)));
assert(crPackClone.fingerprint === COMPANY_RESEARCH_PACK.fingerprint, "Step 3: CR fingerprint not deterministic");
assert(/^[a-f0-9]{64}$/.test(COMPANY_RESEARCH_PACK.fingerprint), "Step 3: CR fingerprint invalid hex");
assert(/^[a-f0-9]{64}$/.test(DOCUMENT_INTELLIGENCE_PACK.fingerprint), "Step 3: DI fingerprint invalid hex");
assert(/^[a-f0-9]{64}$/.test(OPERATIONAL_REQUEST_PACK.fingerprint), "Step 3: OR fingerprint invalid hex");

// 4. Duplicate registrations fail
let duplicateFailed = false;
try {
  createCapabilityPackCatalog([COMPANY_RESEARCH_PACK, COMPANY_RESEARCH_PACK]);
} catch (err) {
  duplicateFailed = err instanceof CapabilityPackError && err.code === "PACK_DUPLICATE_REF";
}
assert(duplicateFailed, "Step 4: Duplicate pack registration did not fail with PACK_DUPLICATE_REF");

// 5. Invalid versions fail
let invalidVersionFailed = false;
try {
  defineCapabilityPack({ ...COMPANY_RESEARCH_PACK_MANIFEST, version: "^1.0.0" });
} catch (err) {
  invalidVersionFailed = err instanceof CapabilityPackError && err.code === "PACK_INVALID_MANIFEST";
}
assert(invalidVersionFailed, "Step 5: Non-exact SemVer version did not fail");

// 6. Forged permission or authority field is rejected
let forgedFieldFailed = false;
try {
  defineCapabilityPack({ ...COMPANY_RESEARCH_PACK_MANIFEST, skipAuthorization: true });
} catch (err) {
  forgedFieldFailed = err instanceof CapabilityPackError && err.code === "PACK_INVALID_MANIFEST";
}
assert(forgedFieldFailed, "Step 6: Forged authority field was not rejected");

let unsupportedPermFailed = false;
try {
  defineCapabilityPack({
    ...COMPANY_RESEARCH_PACK_MANIFEST,
    requirements: {
      ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
      preliminaryPermissions: ["external_side_effect"],
    },
  });
} catch (err) {
  unsupportedPermFailed = err instanceof CapabilityPackError && err.code === "PACK_INVALID_MANIFEST";
}
assert(unsupportedPermFailed, "Step 6: Unsupported permission class was not rejected");

// 7. Compose Northstar and Arbor and activate three packs each
const store = createInMemoryTraceStore();
const trace = createTraceRecorder({ store });
const env = createTestHostEnvironment();

const northstarAAO = createCompanyAAO({
  manifest: NORTHSTAR_MANIFEST,
  hostCapabilities: env.hostCapabilities,
  principalForRun: env.northstarPrincipalForRun,
  trace,
});
const arborAAO = createCompanyAAO({
  manifest: ARBOR_MANIFEST,
  hostCapabilities: env.hostCapabilities,
  principalForRun: env.arborPrincipalForRun,
  trace,
});

const northstarPacks = resolveCompanyCapabilityPacks({
  company: northstarAAO,
  catalog,
  selection: NORTHSTAR_PACK_SELECTION,
});
const arborPacks = resolveCompanyCapabilityPacks({
  company: arborAAO,
  catalog,
  selection: ARBOR_PACK_SELECTION,
});

assert(northstarPacks.listPacks().length === 3, "Step 7: Northstar did not activate 3 packs");
assert(arborPacks.listPacks().length === 3, "Step 7: Arbor did not activate 3 packs");

// 8. Verify Plan fingerprints match pinned workflow contracts and zero workflow forks exist
for (const pack of CANONICAL_CAPABILITY_PACKS) {
  const nsActivated = northstarPacks.getPack(pack.ref);
  const arbActivated = arborPacks.getPack(pack.ref);
  assert(nsActivated.packFingerprint === pack.fingerprint, "Step 8: Northstar pack fingerprint mismatch");
  assert(arbActivated.packFingerprint === pack.fingerprint, "Step 8: Arbor pack fingerprint mismatch");
  assert(nsActivated.workflowPlanFingerprint === pack.manifest.workflow.planFingerprint, "Step 8: Northstar workflow plan fingerprint mismatch");
  assert(arbActivated.workflowPlanFingerprint === pack.manifest.workflow.planFingerprint, "Step 8: Arbor workflow plan fingerprint mismatch");
  assert(nsActivated.facade.workflow.id === arbActivated.facade.workflow.id, "Step 8: Workflow ID mismatch across companies");
  assert(nsActivated.facade.workflow.version === arbActivated.facade.workflow.version, "Step 8: Workflow version mismatch across companies");
  assert(JSON.stringify(nsActivated.facade.workflow) === JSON.stringify(arbActivated.facade.workflow), "Step 8: Workflow definition fork detected across companies");
}

// 9. Execute Six-Scenario Matrix
const evidenceMap = new Map();

// 9.1 Northstar Company Research
const nsCR = await northstarPacks.getPack("aao.company-research@1.0.0").facade.run({
  runId: "run.smoke26.ns.cr",
  request: NORTHSTAR_RESEARCH_REQUEST,
});
assert(nsCR.status === "completed", "Step 9.1: Northstar CR failed");
evidenceMap.set("run://smoke26.ns.cr", {
  origin: "live_run",
  runId: "run.smoke26.ns.cr",
  trace: await store.getRunTrace("run.smoke26.ns.cr"),
  execution: nsCR.execution.execution,
});

// 9.2 Arbor Company Research
const arbCR = await arborPacks.getPack("aao.company-research@1.0.0").facade.run({
  runId: "run.smoke26.arb.cr",
  request: ARBOR_RESEARCH_REQUEST,
});
assert(arbCR.status === "completed", "Step 9.2: Arbor CR failed");

// 9.3 Northstar Document Intelligence
const nsDI = await northstarPacks.getPack("aao.document-intelligence@1.0.0").facade.run({
  runId: "run.smoke26.ns.di",
  request: NORTHSTAR_DOC_REQUEST,
});
assert(nsDI.status === "completed", "Step 9.3: Northstar DI failed");
evidenceMap.set("run://smoke26.ns.di", {
  origin: "live_run",
  runId: "run.smoke26.ns.di",
  trace: await store.getRunTrace("run.smoke26.ns.di"),
  execution: nsDI.execution.execution,
});

// 9.4 Arbor Document Intelligence
const arbDI = await arborPacks.getPack("aao.document-intelligence@1.0.0").facade.run({
  runId: "run.smoke26.arb.di",
  request: ARBOR_DOC_REQUEST,
});
assert(arbDI.status === "completed", "Step 9.4: Arbor DI failed");

// 9.5 Northstar Operational Request (with Human Approval)
const nsORFacade = northstarPacks.getPack("aao.operational-request@1.0.0").facade;
const nsORInit = await nsORFacade.execute({
  runId: "run.smoke26.ns.ops",
  request: NORTHSTAR_OPERATIONAL_REQUEST,
});
assert(nsORInit.ok && nsORInit.execution.run.status === "WAITING_FOR_APPROVAL", "Step 9.5: Northstar OR did not wait for approval");
nsORFacade.approvals.approve(nsORInit.execution.wait.referenceId, NORTHSTAR_ACTORS.manager);
const nsORResume = await nsORFacade.continue(nsORInit.execution);
assert(nsORResume.ok && nsORResume.execution.run.status === "COMPLETED", "Step 9.5: Northstar OR did not complete after approval");
evidenceMap.set("run://smoke26.ns.ops", {
  origin: "live_run",
  runId: "run.smoke26.ns.ops",
  trace: await store.getRunTrace("run.smoke26.ns.ops"),
  execution: nsORResume.execution,
});

// 9.6 Arbor Operational Request (with Human Approval)
const arbORFacade = arborPacks.getPack("aao.operational-request@1.0.0").facade;
const arbORInit = await arbORFacade.execute({
  runId: "run.smoke26.arb.ops",
  request: ARBOR_OPERATIONAL_REQUEST,
});
assert(arbORInit.ok && arbORInit.execution.run.status === "WAITING_FOR_APPROVAL", "Step 9.6: Arbor OR did not wait for approval");
arbORFacade.approvals.approve(arbORInit.execution.wait.referenceId, ARBOR_ACTORS.manager);
const arbORResume = await arbORFacade.continue(arbORInit.execution);
assert(arbORResume.ok && arbORResume.execution.run.status === "COMPLETED", "Step 9.6: Arbor OR did not complete after approval");

// 10. Verify cross-company draft isolation
assert(env.northstarDraftRepo.getAllDrafts().length === 1, "Step 10: Northstar draft count mismatch");
assert(env.arborDraftRepo.getAllDrafts().length === 1, "Step 10: Arbor draft count mismatch");
assert(env.northstarDraftRepo.getAllDrafts()[0].accountId === "NS-COMMERCE-001", "Step 10: Northstar draft target mismatch");
assert(env.arborDraftRepo.getAllDrafts()[0].accountId === "ARB-CLIENT-202", "Step 10: Arbor draft target mismatch");

// 11. Missing provider & compatibility negative checks fail before execution
const baseCRSnapshot = northstarAAO.getCompanyResearchProof().registrationSnapshot;

let missingProviderFailed = false;
try {
  validatePackCompatibility(COMPANY_RESEARCH_PACK, {
    companyId: "northstar-commerce",
    enabledProofs: ["company_research"],
    governanceRoles: [],
    integrations: {}, // missing publicWebProviderRef
    workflow: baseCRSnapshot.workflow,
    registeredTools: baseCRSnapshot.tools,
    registeredModelPolicies: baseCRSnapshot.modelPolicies,
    registeredModelBindings: baseCRSnapshot.modelBindings,
    registeredModelAdapters: baseCRSnapshot.modelAdapters,
    registeredEvalProfiles: [EVAL_PROFILES.companyResearch],
  });
} catch (err) {
  missingProviderFailed = err instanceof CapabilityPackError && err.code === "PACK_REQUIREMENT_MISSING";
}
assert(missingProviderFailed, "Step 11.0: Missing provider did not fail with PACK_REQUIREMENT_MISSING");

// 11.1 Missing Tool evidence -> FAIL
let missingToolEvidenceFailed = false;
try {
  validatePackCompatibility(COMPANY_RESEARCH_PACK, {
    companyId: "northstar-commerce",
    enabledProofs: ["company_research"],
    governanceRoles: [],
    integrations: { publicWebProviderRef: "provider.northstar.public_web" },
    workflow: baseCRSnapshot.workflow,
    registeredTools: undefined,
    registeredModelPolicies: baseCRSnapshot.modelPolicies,
    registeredModelBindings: baseCRSnapshot.modelBindings,
    registeredModelAdapters: baseCRSnapshot.modelAdapters,
    registeredEvalProfiles: [EVAL_PROFILES.companyResearch],
  });
} catch (err) {
  missingToolEvidenceFailed = err instanceof CapabilityPackError && err.code === "PACK_EVIDENCE_UNAVAILABLE";
}
assert(missingToolEvidenceFailed, "Step 11.1: Missing Tool evidence did not fail with PACK_EVIDENCE_UNAVAILABLE");

// 11.2 Tool absent from actual registration -> FAIL
let toolAbsentFromRegistrationFailed = false;
try {
  const driftedAAO = createCompanyAAO({
    manifest: NORTHSTAR_MANIFEST,
    hostCapabilities: env.hostCapabilities,
    principalForRun: env.northstarPrincipalForRun,
    proofRegistrations: {
      company_research: {
        tools: [],
      },
    },
  });
  resolveCompanyCapabilityPacks({
    company: driftedAAO,
    catalog,
    selection: {
      schemaVersion: 1,
      companyId: "northstar-commerce",
      packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
    },
  });
} catch (err) {
  toolAbsentFromRegistrationFailed = err instanceof CapabilityPackError && err.code === "PACK_REQUIREMENT_MISSING";
}
assert(toolAbsentFromRegistrationFailed, "Step 11.2: Tool absent from actual registration did not fail with PACK_REQUIREMENT_MISSING");

// 11.3 Missing Model Policy -> FAIL
let missingModelPolicyFailed = false;
try {
  const driftedPolicyAAO = createCompanyAAO({
    manifest: NORTHSTAR_MANIFEST,
    hostCapabilities: env.hostCapabilities,
    principalForRun: env.northstarPrincipalForRun,
    proofRegistrations: {
      company_research: {
        modelPolicies: [],
      },
    },
  });
  resolveCompanyCapabilityPacks({
    company: driftedPolicyAAO,
    catalog,
    selection: {
      schemaVersion: 1,
      companyId: "northstar-commerce",
      packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
    },
  });
} catch (err) {
  missingModelPolicyFailed = err instanceof CapabilityPackError && err.code === "PACK_REQUIREMENT_MISSING";
}
assert(missingModelPolicyFailed, "Step 11.3: Missing Model Policy did not fail with PACK_REQUIREMENT_MISSING");

// 11.4 Model binding capability unsupported -> FAIL
let bindingCapUnsupportedFailed = false;
try {
  const driftedBindingAAO = createCompanyAAO({
    manifest: NORTHSTAR_MANIFEST,
    hostCapabilities: env.hostCapabilities,
    principalForRun: env.northstarPrincipalForRun,
    proofRegistrations: {
      company_research: {
        registrationSnapshot: {
          ...baseCRSnapshot,
          modelBindings: baseCRSnapshot.modelBindings.map((b) => ({
            ...b,
            capabilities: ["model.text_generation"],
          })),
          modelAdapters: baseCRSnapshot.modelAdapters.map((a) => ({
            ...a,
            capabilities: [
              { capability: "model.text_generation", support: "supported" },
              { capability: "model.structured_output", support: "supported" },
            ],
          })),
        },
      },
    },
  });
  resolveCompanyCapabilityPacks({
    company: driftedBindingAAO,
    catalog,
    selection: {
      schemaVersion: 1,
      companyId: "northstar-commerce",
      packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
    },
  });
} catch (err) {
  bindingCapUnsupportedFailed = err instanceof CapabilityPackError && err.code === "PACK_CAPABILITY_INCOMPATIBLE";
}
assert(bindingCapUnsupportedFailed, "Step 11.4: Model binding capability unsupported did not fail with PACK_CAPABILITY_INCOMPATIBLE");

// 11.5 Adapter capability unsupported -> FAIL
let adapterCapUnsupportedFailed = false;
try {
  const driftedAdapterAAO = createCompanyAAO({
    manifest: NORTHSTAR_MANIFEST,
    hostCapabilities: env.hostCapabilities,
    principalForRun: env.northstarPrincipalForRun,
    proofRegistrations: {
      company_research: {
        registrationSnapshot: {
          ...baseCRSnapshot,
          modelAdapters: baseCRSnapshot.modelAdapters.map((a) => ({
            ...a,
            capabilities: [
              { capability: "model.structured_output", support: "unsupported" },
            ],
          })),
        },
      },
    },
  });
  resolveCompanyCapabilityPacks({
    company: driftedAdapterAAO,
    catalog,
    selection: {
      schemaVersion: 1,
      companyId: "northstar-commerce",
      packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
    },
  });
} catch (err) {
  adapterCapUnsupportedFailed = err instanceof CapabilityPackError && err.code === "PACK_CAPABILITY_INCOMPATIBLE";
}
assert(adapterCapUnsupportedFailed, "Step 11.5: Adapter capability unsupported did not fail with PACK_CAPABILITY_INCOMPATIBLE");

// 11.6 Unknown Eval profile -> PACK_VERIFICATION_PROFILE_MISSING
let unknownEvalProfileFailed = false;
try {
  const unknownEvalPack = defineCapabilityPack({
    ...COMPANY_RESEARCH_PACK_MANIFEST,
    verification: {
      evalProfileRef: "aao.unknown-profile.evals@1.0.0",
    },
  });
  const customCatalog = createCapabilityPackCatalog([unknownEvalPack]);
  resolveCompanyCapabilityPacks({
    company: northstarAAO,
    catalog: customCatalog,
    selection: {
      schemaVersion: 1,
      companyId: "northstar-commerce",
      packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
    },
  });
} catch (err) {
  unknownEvalProfileFailed = err instanceof CapabilityPackError && err.code === "PACK_VERIFICATION_PROFILE_MISSING";
}
assert(unknownEvalProfileFailed, "Step 11.6: Unknown Eval profile did not fail with PACK_VERIFICATION_PROFILE_MISSING");

// 12. Disabled proof fails before execution
let disabledProofFailed = false;
try {
  const restrictedAAO = createCompanyAAO({
    manifest: { ...ARBOR_MANIFEST, enabledProofs: ["company_research"] },
    hostCapabilities: env.hostCapabilities,
    principalForRun: env.arborPrincipalForRun,
  });
  resolveCompanyCapabilityPacks({
    company: restrictedAAO,
    catalog,
    selection: {
      schemaVersion: 1,
      companyId: "arbor-consulting",
      packRefs: [{ id: "aao.operational-request", version: "1.0.0" }],
    },
  });
} catch (err) {
  disabledProofFailed = err instanceof CapabilityPackError && err.code === "PACK_PROOF_DISABLED";
}
assert(disabledProofFailed, "Step 12: Disabled proof did not fail with PACK_PROOF_DISABLED");

// 13. Foreign principal is refused before model invocation
let foreignPrincipalRefused = false;
const foreignEnv = createTestHostEnvironment({
  arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst,
});
const foreignArborAAO = createCompanyAAO({
  manifest: ARBOR_MANIFEST,
  hostCapabilities: foreignEnv.hostCapabilities,
  principalForRun: foreignEnv.arborPrincipalForRun,
});
const foreignArborPacks = resolveCompanyCapabilityPacks({
  company: foreignArborAAO,
  catalog,
  selection: ARBOR_PACK_SELECTION,
});
const arbCallsBefore = foreignEnv.getArborProviderCalls();
try {
  await foreignArborPacks.getPack("aao.company-research@1.0.0").facade.run({
    runId: "run.smoke26.foreign",
    request: ARBOR_RESEARCH_REQUEST,
  });
} catch (err) {
  foreignPrincipalRefused = err instanceof CompanyAdmissionError && err.code === "COMPANY_ADMISSION_DENIED";
}
assert(foreignPrincipalRefused, "Step 13: Foreign principal was not refused with COMPANY_ADMISSION_DENIED");
assert(foreignEnv.getArborProviderCalls() === arbCallsBefore, "Step 13: Foreign principal caused model provider calls");

// 14. Evaluation verification passes for all 3 packs
const crEval = await evaluatePackRun({
  profileRef: EVAL_PROFILES.companyResearch,
  evidenceKey: "run://smoke26.ns.cr",
  evidenceMap,
});
assert(crEval.passedCases === 5 && crEval.allMatched, "Step 14: CR eval verification failed");

const diEval = await evaluatePackRun({
  profileRef: EVAL_PROFILES.documentIntelligence,
  evidenceKey: "run://smoke26.ns.di",
  evidenceMap,
});
assert(diEval.passedCases === 5 && diEval.allMatched, "Step 14: DI eval verification failed");

const orEval = await evaluatePackRun({
  profileRef: EVAL_PROFILES.operationalRequest,
  evidenceKey: "run://smoke26.ns.ops",
  evidenceMap,
});
assert(orEval.passedCases === 5 && orEval.allMatched, "Step 14: OR eval verification failed");

process.stdout.write("All 14 Smoke Verification Steps Passed!\n");
process.stdout.write("SPRINT_26_CAPABILITY_PACKS_SMOKE_OK\n");
