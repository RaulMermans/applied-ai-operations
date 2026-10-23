import process from "node:process";
import {
  CANONICAL_CAPABILITY_PACKS,
  CapabilityPackError,
  validatePackCompatibility,
} from "@aao/capability-packs";
import {
  createCompanyAAO,
  CompanyAdmissionError,
} from "@aao/example-company-portability";
import {
  createInMemoryTraceStore,
  createTraceRecorder,
} from "@aao/observability";
import type { EvalEvidenceBundle, ExecutionEvidence } from "@aao/evaluation";
import {
  createStandardPackCatalog,
  resolveCompanyCapabilityPacks,
  evaluatePackRun,
  EVAL_PROFILES,
  type CompanyResearchFacade,
  type DocumentIntelligenceFacade,
  type OperationalRequestFacade,
} from "../src/index.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_ACTORS,
  NORTHSTAR_PACK_SELECTION,
  ARBOR_PACK_SELECTION,
  NORTHSTAR_RESEARCH_REQUEST,
  ARBOR_RESEARCH_REQUEST,
  NORTHSTAR_DOC_REQUEST,
  ARBOR_DOC_REQUEST,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";

async function main() {
  process.stdout.write("=== Sprint 26: Capability Packs & Reusable Business Templates Demo ===\n\n");

  // 1-3. Load manifests, validate contracts, and print catalog
  const catalog = createStandardPackCatalog();
  const packs = catalog.listCapabilityPacks();

  process.stdout.write(`Registered Capability Packs (${packs.length}):\n`);
  for (const pack of packs) {
    process.stdout.write(
      `  - ${pack.identity}\n` +
        `    Name: ${pack.manifest.name}\n` +
        `    Category: ${pack.manifest.category}\n` +
        `    Outcome Class: ${pack.manifest.execution.outcomeClass}\n` +
        `    Pack Fingerprint: ${pack.fingerprint.slice(0, 16)}...\n` +
        `    Workflow: ${pack.manifest.workflow.id}@${pack.manifest.workflow.version} (plan: ${pack.manifest.workflow.planFingerprint.slice(0, 16)}...)\n` +
        `    Tools: ${pack.manifest.requirements.toolRefs.map((t) => `${t.id}@${t.version}`).join(", ")}\n` +
        `    Model Policies: ${pack.manifest.requirements.modelPolicyRefs.join(", ")}\n` +
        `    Eval Profile: ${pack.manifest.verification.evalProfileRef}\n`
    );
  }
  process.stdout.write("\n");

  // 4-8. Compose Northstar Commerce & Arbor Consulting and activate packs
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

  process.stdout.write("Company Configurations:\n");
  process.stdout.write(`  - ${northstarAAO.displayName} (${northstarAAO.companyId}) | fingerprint: ${northstarAAO.configFingerprint.slice(0, 16)}...\n`);
  process.stdout.write(`  - ${arborAAO.displayName} (${arborAAO.companyId}) | fingerprint: ${arborAAO.configFingerprint.slice(0, 16)}...\n\n`);

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

  process.stdout.write("Activated Pack Matrix (6/6):\n");

  const evidenceMap = new Map<string, EvalEvidenceBundle>();

  // 9. Run Six-Scenario Matrix
  // Scenario 1: Northstar x Company Research
  const nsCR = await northstarPacks.getPack<CompanyResearchFacade>("aao.company-research@1.0.0").facade.run({
    runId: "run.demo.ns.cr",
    request: NORTHSTAR_RESEARCH_REQUEST,
  });
  process.stdout.write(`  [1/6] Northstar x Company Research: ${nsCR.status.toUpperCase()}\n`);
  evidenceMap.set("run://demo.ns.cr", {
    origin: "live_run",
    runId: "run.demo.ns.cr",
    trace: await store.getRunTrace("run.demo.ns.cr"),
    execution: (nsCR as unknown as { execution: { execution: ExecutionEvidence } }).execution.execution,
  });

  // Scenario 2: Arbor x Company Research
  const arbCR = await arborPacks.getPack<CompanyResearchFacade>("aao.company-research@1.0.0").facade.run({
    runId: "run.demo.arb.cr",
    request: ARBOR_RESEARCH_REQUEST,
  });
  process.stdout.write(`  [2/6] Arbor x Company Research: ${arbCR.status.toUpperCase()}\n`);

  // Scenario 3: Northstar x Document Intelligence
  const nsDI = await northstarPacks.getPack<DocumentIntelligenceFacade>("aao.document-intelligence@1.0.0").facade.run({
    runId: "run.demo.ns.di",
    request: NORTHSTAR_DOC_REQUEST,
  });
  process.stdout.write(`  [3/6] Northstar x Document Intelligence: ${nsDI.status.toUpperCase()}\n`);
  evidenceMap.set("run://demo.ns.di", {
    origin: "live_run",
    runId: "run.demo.ns.di",
    trace: await store.getRunTrace("run.demo.ns.di"),
    execution: (nsDI as unknown as { execution: { execution: ExecutionEvidence } }).execution.execution,
  });

  // Scenario 4: Arbor x Document Intelligence
  const arbDI = await arborPacks.getPack<DocumentIntelligenceFacade>("aao.document-intelligence@1.0.0").facade.run({
    runId: "run.demo.arb.di",
    request: ARBOR_DOC_REQUEST,
  });
  process.stdout.write(`  [4/6] Arbor x Document Intelligence: ${arbDI.status.toUpperCase()}\n`);

  // Scenario 5: Northstar x Operational Request
  const nsORFacade = northstarPacks.getPack<OperationalRequestFacade>("aao.operational-request@1.0.0").facade;
  const nsORInit = await nsORFacade.execute({
    runId: "run.demo.ns.ops",
    request: NORTHSTAR_OPERATIONAL_REQUEST,
  });
  if (!nsORInit.ok) throw new Error("Northstar Operational Request intake failed");
  const nsWaitRef = nsORInit.execution.wait?.referenceId as string;
  nsORFacade.approvals.approve(nsWaitRef, NORTHSTAR_ACTORS.manager);
  const nsORResume = await nsORFacade.continue(nsORInit.execution);
  if (!nsORResume.ok) throw new Error("Northstar Operational Request continuation failed");
  process.stdout.write(`  [5/6] Northstar x Operational Request: ${nsORResume.execution.run.status}\n`);
  evidenceMap.set("run://demo.ns.ops", {
    origin: "live_run",
    runId: "run.demo.ns.ops",
    trace: await store.getRunTrace("run.demo.ns.ops"),
    execution: (nsORResume as unknown as { execution: ExecutionEvidence }).execution,
  });

  // Scenario 6: Arbor x Operational Request
  const arbORFacade = arborPacks.getPack<OperationalRequestFacade>("aao.operational-request@1.0.0").facade;
  const arbORInit = await arbORFacade.execute({
    runId: "run.demo.arb.ops",
    request: ARBOR_OPERATIONAL_REQUEST,
  });
  if (!arbORInit.ok) throw new Error("Arbor Operational Request intake failed");
  const arbWaitRef = arbORInit.execution.wait?.referenceId as string;
  arbORFacade.approvals.approve(arbWaitRef, ARBOR_ACTORS.manager);
  const arbORResume = await arbORFacade.continue(arbORInit.execution);
  if (!arbORResume.ok) throw new Error("Arbor Operational Request continuation failed");
  process.stdout.write(`  [6/6] Arbor x Operational Request: ${arbORResume.execution.run.status}\n\n`);

  // 10-12. Negative boundary demonstrations
  process.stdout.write("Governance & Compatibility Refusal Demonstrations:\n");

  // 10. Missing capability rejection
  try {
    validatePackCompatibility(CANONICAL_CAPABILITY_PACKS[0]!, {
      companyId: "northstar-commerce",
      enabledProofs: ["company_research"],
      governanceRoles: [],
      modelBindings: [{ id: "ns", capabilities: ["model.structured_output"] }],
      integrations: {}, // Missing publicWebProviderRef!
      workflow: CANONICAL_CAPABILITY_PACKS[0]!.manifest.workflow,
    });
  } catch (err) {
    if (err instanceof CapabilityPackError) {
      process.stdout.write(`  - Missing integration capability refused: ${err.code}\n`);
    }
  }

  // 11. Disabled proof rejection
  const restrictedAAO = createCompanyAAO({
    manifest: { ...ARBOR_MANIFEST, enabledProofs: ["company_research"] },
    hostCapabilities: env.hostCapabilities,
    principalForRun: env.arborPrincipalForRun,
  });
  try {
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
    if (err instanceof CapabilityPackError) {
      process.stdout.write(`  - Disabled proof pack activation refused: ${err.code}\n`);
    }
  }

  // 12. Unauthorized principal refusal
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
  try {
    await foreignArborPacks.getPack<CompanyResearchFacade>("aao.company-research@1.0.0").facade.run({
      runId: "run.demo.unauthorized",
      request: ARBOR_RESEARCH_REQUEST,
    });
  } catch (err) {
    if (err instanceof CompanyAdmissionError) {
      process.stdout.write(`  - Foreign principal refused pre-execution: ${err.code}\n\n`);
    }
  }

  // 14. Evaluation verification
  const crEval = await evaluatePackRun({
    profileRef: EVAL_PROFILES.companyResearch,
    evidenceKey: "run://demo.ns.cr",
    evidenceMap,
  });
  const diEval = await evaluatePackRun({
    profileRef: EVAL_PROFILES.documentIntelligence,
    evidenceKey: "run://demo.ns.di",
    evidenceMap,
  });
  const orEval = await evaluatePackRun({
    profileRef: EVAL_PROFILES.operationalRequest,
    evidenceKey: "run://demo.ns.ops",
    evidenceMap,
  });

  process.stdout.write("Pack Evaluation Verification:\n");
  process.stdout.write(`  - ${EVAL_PROFILES.companyResearch}: ${crEval.passedCases}/${crEval.totalCases} PASSED\n`);
  process.stdout.write(`  - ${EVAL_PROFILES.documentIntelligence}: ${diEval.passedCases}/${diEval.totalCases} PASSED\n`);
  process.stdout.write(`  - ${EVAL_PROFILES.operationalRequest}: ${orEval.passedCases}/${orEval.totalCases} PASSED\n\n`);

  process.stdout.write("Demo completed successfully.\n");
}

main().catch((err) => {
  process.stderr.write(`Demo failed: ${String(err)}\n`);
  process.exit(1);
});
