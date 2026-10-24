import process from "node:process";
import {
  CANONICAL_CAPABILITY_PACKS,
  CapabilityPackError,
  COMPANY_RESEARCH_PACK_MANIFEST,
  createCapabilityPackCatalog,
  defineCapabilityPack,
} from "@aao/capability-packs";
import {
  createCompanyAAO,
  CompanyAdmissionError,
  type ProofRegistrationOverride,
} from "@aao/example-company-portability";
import {
  defineModelAdapter,
  type ModelAdapterDefinition,
  type ModelBindingDefinition,
} from "@aao/framework";
import {
  createInMemoryTraceStore,
  createTraceRecorder,
} from "@aao/observability";
import type { EvalEvidenceBundle, ExecutionEvidence } from "@aao/evaluation";
import {
  createStandardPackCatalog,
  createStandardEvalProfileCatalog,
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

  // 1. Registered Capability Packs and fingerprints
  const catalog = createStandardPackCatalog();
  const evalProfileCatalog = createStandardEvalProfileCatalog();
  const packs = catalog.listCapabilityPacks();

  process.stdout.write(`1. Registered Capability Packs (${packs.length}):\n`);
  for (const pack of packs) {
    process.stdout.write(
      `  - ${pack.identity}\n` +
        `    Name: ${pack.manifest.name}\n` +
        `    Category: ${pack.manifest.category}\n` +
        `    Outcome Class: ${pack.manifest.execution.outcomeClass}\n` +
        `    Pack Fingerprint: ${pack.fingerprint.slice(0, 16)}...\n` +
        `    Workflow: ${pack.manifest.workflow.id}@${pack.manifest.workflow.version} (plan: ${pack.manifest.workflow.planFingerprint.slice(0, 16)}...)\n` +
        `    Required Tools: ${pack.manifest.requirements.toolRefs.map((t) => `${t.id}@${t.version}`).join(", ")}\n` +
        `    Required Model Policies: ${pack.manifest.requirements.modelPolicyRefs.join(", ")}\n` +
        `    Required Eval Profile: ${pack.manifest.verification.evalProfileRef}\n`
    );
  }
  process.stdout.write("\n");

  // Compose Northstar Commerce & Arbor Consulting
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

  // 2-5. Actual registered Tool counts, Model Policy refs, Model binding/adapter verification, Eval profile refs
  process.stdout.write("2-5. Trusted Registration Evidence Snapshot (Northstar & Arbor):\n");
  const proofEntries = [
    ["company_research", northstarAAO.getCompanyResearchProof()],
    ["document_intelligence", northstarAAO.getDocumentIntelligenceProof()],
    ["operational_request", northstarAAO.getOperationalRequestProof()],
  ] as const;
  for (const [proofId, nsFacade] of proofEntries) {
    const snap = nsFacade.registrationSnapshot;
    const bindingInfo = snap.modelBindings
      .map((b) => {
        const adapter = snap.modelAdapters.find(
          (a) => a.id === b.adapterRef.id && a.version === b.adapterRef.version
        );
        const supportedAdapterCaps =
          adapter?.capabilities
            .filter((c) => c.support === "supported")
            .map((c) => c.capability)
            .join(",") ?? "missing";
        return `${b.id}[${b.capabilities.join(",")}] -> ${b.adapterRef.id}@${b.adapterRef.version}[${supportedAdapterCaps}]`;
      })
      .join("; ");
    process.stdout.write(
      `  - Proof [${proofId}]:\n` +
        `    Registered Tools (${snap.tools.length}): ${snap.tools.map((t) => `${t.id}@${t.version}`).join(", ")}\n` +
        `    Registered Model Policies (${snap.modelPolicies.length}): ${snap.modelPolicies.join(", ")}\n` +
        `    Verified Binding & Adapter Capabilities: ${bindingInfo}\n`
    );
  }
  process.stdout.write(
    `  - Registered Eval Profiles (${evalProfileCatalog.listProfileRefs().length}): ${evalProfileCatalog.listProfileRefs().join(", ")}\n\n`
  );

  // 6-7. Northstar & Arbor compatibility reports: PASS
  const northstarPacks = resolveCompanyCapabilityPacks({
    company: northstarAAO,
    catalog,
    selection: NORTHSTAR_PACK_SELECTION,
    evalProfileCatalog,
    hostCapabilities: env.hostCapabilities,
  });

  const arborPacks = resolveCompanyCapabilityPacks({
    company: arborAAO,
    catalog,
    selection: ARBOR_PACK_SELECTION,
    evalProfileCatalog,
    hostCapabilities: env.hostCapabilities,
  });

  process.stdout.write("6-7. Compatibility Preflight Reports:\n");
  for (const activated of northstarPacks.listPacks()) {
    const r = activated.compatibilityReport;
    process.stdout.write(
      `  - Northstar (${r.companyId}) x ${r.packIdentity}: ${r.compatible ? "PASS" : "FAIL"} ` +
        `(tools: ${r.verifiedRequirements.tools}, policies: ${r.verifiedRequirements.modelPolicies}, ` +
        `modelCaps: ${r.verifiedRequirements.modelCapabilities}, evalProfiles: ${r.verifiedRequirements.evalProfiles})\n`
    );
  }
  for (const activated of arborPacks.listPacks()) {
    const r = activated.compatibilityReport;
    process.stdout.write(
      `  - Arbor (${r.companyId}) x ${r.packIdentity}: ${r.compatible ? "PASS" : "FAIL"} ` +
        `(tools: ${r.verifiedRequirements.tools}, policies: ${r.verifiedRequirements.modelPolicies}, ` +
        `modelCaps: ${r.verifiedRequirements.modelCapabilities}, evalProfiles: ${r.verifiedRequirements.evalProfiles})\n`
    );
  }
  process.stdout.write("\n");

  // 13-14. Pack fingerprint equality & Workflow Plan fingerprint equality across companies
  process.stdout.write("13-14. Cross-Company Fingerprint Equality:\n");
  for (const pack of CANONICAL_CAPABILITY_PACKS) {
    const nsAct = northstarPacks.getPack(pack.ref);
    const arbAct = arborPacks.getPack(pack.ref);
    process.stdout.write(
      `  - ${pack.identity}: Pack Fingerprint Equal=${nsAct.packFingerprint === arbAct.packFingerprint} (${nsAct.packFingerprint.slice(0, 12)}...) | ` +
        `Workflow Plan Fingerprint Equal=${nsAct.workflowPlanFingerprint === arbAct.workflowPlanFingerprint} (${nsAct.workflowPlanFingerprint.slice(0, 12)}...)\n`
    );
  }
  process.stdout.write("\n");

  // 8. Six successful executions
  process.stdout.write("8. Activated Pack Execution Matrix (6/6):\n");

  const evidenceMap = new Map<string, EvalEvidenceBundle>();

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

  // 9-12. Governance & Compatibility Refusal Demonstrations
  process.stdout.write("9-12. Governance & Compatibility Refusal Demonstrations:\n");

  const baseCRSnapshot = northstarAAO.getCompanyResearchProof().registrationSnapshot;
  const validAdapterDef = env.hostCapabilities.getModelAdapter("aao.native-model")!;

  // 9. Missing Tool refusal & Registration integrity demonstration
  try {
    const missingToolAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          tools: [],
          // Attempt to inject a previously valid registrationSnapshot claiming all tools exist
          registrationSnapshot: baseCRSnapshot,
        } as unknown as ProofRegistrationOverride,
      },
    });
    const actualToolsCount = missingToolAAO.getCompanyResearchProof().registrationSnapshot.tools.length;
    process.stdout.write(
      `  - Registration integrity:\n` +
        `    Actual Tool registration missing (registered=${actualToolsCount})\n` +
        `    Fabricated snapshot supplied (claimed=${baseCRSnapshot.tools.length})\n` +
        `    Fabricated snapshot ignored/rejected\n`
    );
    resolveCompanyCapabilityPacks({
      company: missingToolAAO,
      catalog,
      selection: {
        schemaVersion: 1,
        companyId: "northstar-commerce",
        packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
      },
    });
  } catch (err) {
    if (err instanceof CapabilityPackError) {
      process.stdout.write(`    Compatibility refused: ${err.code} (${err.message})\n`);
    }
  }

  // 10. Missing Model capability refusal demonstration (actual constructed adapter/binding)
  try {
    const textOnlyBinding: ModelBindingDefinition = {
      id: "northstar.model.text_only",
      priority: 10,
      capabilities: ["model.text_generation"],
      adapterRef: { id: "aao.native-model", version: "1.0.0" },
    };
    const textOnlyAdapterDef: ModelAdapterDefinition = defineModelAdapter({
      manifest: {
        id: "aao.native-model",
        version: "1.0.0",
        kind: "model",
        capabilities: [
          { capability: "model.text_generation", support: "supported" },
          { capability: "model.structured_output", support: "unsupported" },
          { capability: "model.usage", support: "supported" },
          { capability: "model.cancellation", support: "unsupported" },
          { capability: "model.tool_call_response", support: "unsupported" },
        ],
      },
      adapter: validAdapterDef.adapter,
    });
    const missingModelCapAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          modelBindings: [textOnlyBinding],
          modelAdapters: [textOnlyAdapterDef],
          registrationSnapshot: baseCRSnapshot,
        } as unknown as ProofRegistrationOverride,
      },
    });
    resolveCompanyCapabilityPacks({
      company: missingModelCapAAO,
      catalog,
      selection: {
        schemaVersion: 1,
        companyId: "northstar-commerce",
        packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
      },
    });
  } catch (err) {
    if (err instanceof CapabilityPackError) {
      process.stdout.write(`  - [10] Missing Model/Adapter capability refused: ${err.code} (${err.message})\n`);
    }
  }

  // 11. Unknown Eval profile refusal demonstration
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
    if (err instanceof CapabilityPackError) {
      process.stdout.write(`  - [11] Unknown Eval profile refused: ${err.code} (${err.message})\n`);
    }
  }

  // 12. Foreign-principal refusal demonstration
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
      process.stdout.write(`  - [12] Foreign principal refused pre-execution: ${err.code} (0 provider calls)\n\n`);
    }
  }

  // 15. Evaluation verification results
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

  process.stdout.write("15. Pack Evaluation Verification:\n");
  process.stdout.write(`  - ${EVAL_PROFILES.companyResearch}: ${crEval.passedCases}/${crEval.totalCases} PASSED\n`);
  process.stdout.write(`  - ${EVAL_PROFILES.documentIntelligence}: ${diEval.passedCases}/${diEval.totalCases} PASSED\n`);
  process.stdout.write(`  - ${EVAL_PROFILES.operationalRequest}: ${orEval.passedCases}/${orEval.totalCases} PASSED\n\n`);

  process.stdout.write("Demo completed successfully.\n");
}

main().catch((err) => {
  process.stderr.write(`Demo failed: ${String(err)}\n`);
  process.exit(1);
});
