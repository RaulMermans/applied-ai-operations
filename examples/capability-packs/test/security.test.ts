import { describe, expect, it } from "vitest";
import {
  createCompanyAAO,
  createHostCapabilityCatalog,
  CompanyAdmissionError,
  type ProofRegistrationOverride,
} from "@aao/example-company-portability";
import { CompanyConfigError } from "@aao/config";
import {
  AAOFrameworkError,
  defineModelAdapter,
  type ModelAdapterDefinition,
  type ModelBindingDefinition,
} from "@aao/framework";
import {
  CapabilityPackError,
} from "@aao/capability-packs";
import {
  createStandardPackCatalog,
  resolveCompanyCapabilityPacks,
  type CompanyResearchFacade,
  type OperationalRequestFacade,
} from "../src/index.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  NORTHSTAR_PACK_SELECTION,
  ARBOR_PACK_SELECTION,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";

describe("Sprint 26 — Capability Pack Security & Boundary Enforcement", () => {
  it("enforces pre-execution company admission: foreign principal is denied before any model or tool invocation", async () => {
    const env = createTestHostEnvironment({
      // Configure host to return Northstar analyst when running in Arbor AAO
      arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst,
    });
    const catalog = createStandardPackCatalog();

    const arborAAO = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    const arborPacks = resolveCompanyCapabilityPacks({
      company: arborAAO,
      catalog,
      selection: ARBOR_PACK_SELECTION,
    });

    const arborResearchPack = arborPacks.getPack<CompanyResearchFacade>("aao.company-research@1.0.0");

    const initialCalls = env.getArborProviderCalls();

    await expect(
      arborResearchPack.facade.run({
        runId: "run.arb.unauthorized",
        request: {
          company: { name: "Arbor Consulting", domain: "arbor.example" },
          questions: [{ id: "q1", question: "What does it offer?" }],
        },
      })
    ).rejects.toThrow(CompanyAdmissionError);

    // Verify 0 provider calls, 0 tool calls
    expect(env.getArborProviderCalls()).toBe(initialCalls);
  });

  it("fails fast with PACK_PROOF_DISABLED if a company attempts to activate a disabled proof pack", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    // Company with ONLY document_intelligence enabled
    const restrictedManifest = {
      ...ARBOR_MANIFEST,
      enabledProofs: ["document_intelligence"] as const,
    };

    const restrictedAAO = createCompanyAAO({
      manifest: restrictedManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // Attempting to select company-research pack
    expect(() =>
      resolveCompanyCapabilityPacks({
        company: restrictedAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: restrictedManifest.companyId,
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(CapabilityPackError);

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: restrictedAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: restrictedManifest.companyId,
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_PROOF_DISABLED/);
  });

  it("fails fast with PACK_SCOPE_MISMATCH if pack selection companyId does not match composed company", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const northstarAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    // Selection has companyId "arbor-consulting" but composed company is "northstar-commerce"
    expect(() =>
      resolveCompanyCapabilityPacks({
        company: northstarAAO,
        catalog,
        selection: ARBOR_PACK_SELECTION,
      })
    ).toThrow(CapabilityPackError);

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: northstarAAO,
        catalog,
        selection: ARBOR_PACK_SELECTION,
      })
    ).toThrow(/PACK_SCOPE_MISMATCH/);
  });

  it("enforces approval isolation: Northstar approver cannot approve Arbor approval waitpoint", async () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const arborAAO = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    const arborPacks = resolveCompanyCapabilityPacks({
      company: arborAAO,
      catalog,
      selection: ARBOR_PACK_SELECTION,
    });

    const arbOpsPack = arborPacks.getPack<OperationalRequestFacade>("aao.operational-request@1.0.0");
    const arbOpsInit = await arbOpsPack.facade.execute({
      runId: "run.arb.isolation.ops",
      request: ARBOR_OPERATIONAL_REQUEST,
    });

    expect(arbOpsInit.ok).toBe(true);
    if (!arbOpsInit.ok) return;

    const arbWaitRef = arbOpsInit.execution.wait?.referenceId as string;

    // Northstar manager attempts to approve Arbor waitpoint
    expect(() =>
      arbOpsPack.facade.approvals.approve(arbWaitRef, NORTHSTAR_ACTORS.manager)
    ).toThrow(/APPROVAL_RESOLVER_NOT_ELIGIBLE/);
  });

  it("handles human rejection: when human approver rejects, 0 drafts are persisted", async () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const northstarAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const northstarPacks = resolveCompanyCapabilityPacks({
      company: northstarAAO,
      catalog,
      selection: NORTHSTAR_PACK_SELECTION,
    });

    const nsOpsPack = northstarPacks.getPack<OperationalRequestFacade>("aao.operational-request@1.0.0");
    const initResult = await nsOpsPack.facade.execute({
      runId: "run.ns.rejection.ops",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });

    expect(initResult.ok).toBe(true);
    if (!initResult.ok) return;
    expect(initResult.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const initialDraftCount = env.northstarDraftRepo.getAllDrafts().length;

    // Human manager deliberately rejects
    const waitRef = initResult.execution.wait?.referenceId as string;
    const rejectedRecord = nsOpsPack.facade.approvals.reject(waitRef, NORTHSTAR_ACTORS.manager);
    expect(rejectedRecord.status).toBe("rejected");

    const continuation = await nsOpsPack.facade.continue(initResult.execution);
    // Because approval was rejected, continuation fails closed with FAILED status and zero drafts persisted
    expect(continuation.ok).toBe(false);
    expect(continuation.execution?.run.status).toBe("FAILED");
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(initialDraftCount);
  });

  const researchOnlyManifest = {
    ...NORTHSTAR_MANIFEST,
    enabledProofs: ["company_research"] as const,
  };

  it("Sprint 26D Section 4 & 7: removes registrationSnapshot from ProofRegistrationOverride and prevents fabricated snapshot override at compile time and runtime", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    // Compile-time type assertion: ProofRegistrationOverride must NOT contain registrationSnapshot
    type HasRegistrationSnapshotOverride = "registrationSnapshot" extends keyof ProofRegistrationOverride
      ? true
      : false;
    const hasRegistrationSnapshotProperty: HasRegistrationSnapshotOverride = false;
    expect(hasRegistrationSnapshotProperty).toBe(false);

    // Capture a previously valid registrationSnapshot claiming all required tools exist
    const validAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });
    const staleValidSnapshot = validAAO.getCompanyResearchProof().registrationSnapshot;
    expect(staleValidSnapshot.tools).toContainEqual({ id: "public_web.search", version: "1.0.0" });

    // Construct a Company Research proof WITHOUT its required Tools, while attempting to inject
    // the stale valid snapshot via an obsolete runtime property on proofRegistrations
    const runtimeForgedOverride = {
      tools: [],
      registrationSnapshot: staleValidSnapshot,
    };

    const driftedAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: runtimeForgedOverride as unknown as ProofRegistrationOverride,
      },
    });

    // Authoritative snapshot reflects the actual construction (0 tools), ignoring the injected snapshot
    const actualSnapshot = driftedAAO.getCompanyResearchProof().registrationSnapshot;
    expect(actualSnapshot.tools).toEqual([]);
    expect(actualSnapshot).not.toBe(staleValidSnapshot);

    const initialArborCalls = env.getArborProviderCalls();
    const initialWebSearches = env.northstarWebProvider.calls.search.length;
    const initialDocReads = env.northstarDocProvider.calls.length;
    const initialDrafts = env.northstarDraftRepo.getAllDrafts().length;

    let activated: unknown = undefined;
    expect(() => {
      activated = resolveCompanyCapabilityPacks({
        company: driftedAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      });
    }).toThrow(/PACK_REQUIREMENT_MISSING.*public_web\.search@1\.0\.0/);

    expect(activated).toBeUndefined();
    expect(env.getArborProviderCalls()).toBe(initialArborCalls);
    expect(env.northstarWebProvider.calls.search.length).toBe(initialWebSearches);
    expect(env.northstarDocProvider.calls.length).toBe(initialDocReads);
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(initialDrafts);
  });

  it("Sprint 26D Section 8: enforces actual Tool registration truth across all three proofs (Company Research, Document Intelligence, Operational Request)", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const validAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });
    const validCRSnapshot = validAAO.getCompanyResearchProof().registrationSnapshot;
    const validDISnapshot = validAAO.getDocumentIntelligenceProof().registrationSnapshot;
    const validORSnapshot = validAAO.getOperationalRequestProof().registrationSnapshot;

    // 1. Company Research: remove public_web.search@1.0.0
    const crMissingToolAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          tools: [],
          registrationSnapshot: validCRSnapshot,
        } as unknown as ProofRegistrationOverride,
      },
    });
    expect(crMissingToolAAO.getCompanyResearchProof().registrationSnapshot.tools).toEqual([]);
    expect(() =>
      resolveCompanyCapabilityPacks({
        company: crMissingToolAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_REQUIREMENT_MISSING.*public_web\.search@1\.0\.0/);
    expect(env.northstarWebProvider.calls.search.length).toBe(0);

    // 2. Document Intelligence: remove document.extract_text@1.0.0
    const diMissingToolAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        document_intelligence: {
          tools: [],
          registrationSnapshot: validDISnapshot,
        } as unknown as ProofRegistrationOverride,
      },
    });
    expect(diMissingToolAAO.getDocumentIntelligenceProof().registrationSnapshot.tools).toEqual([]);
    expect(() =>
      resolveCompanyCapabilityPacks({
        company: diMissingToolAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.document-intelligence", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_REQUIREMENT_MISSING.*document\.extract_text@1\.0\.0/);
    expect(env.northstarDocProvider.calls.length).toBe(0);

    // 3. Operational Request: remove operations.create_change_draft@1.0.0
    const orMissingToolAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        operational_request: {
          tools: [],
          registrationSnapshot: validORSnapshot,
        } as unknown as ProofRegistrationOverride,
      },
    });
    expect(orMissingToolAAO.getOperationalRequestProof().registrationSnapshot.tools).toEqual([]);
    expect(() =>
      resolveCompanyCapabilityPacks({
        company: orMissingToolAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.operational-request", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_REQUIREMENT_MISSING.*operations\.create_change_draft@1\.0\.0/);
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(0);
  });

  it("Sprint 26D Section 9: enforces Model Policy integrity and rejects stale snapshot injection when a required policy is missing", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const validAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });
    const staleValidSnapshot = validAAO.getCompanyResearchProof().registrationSnapshot;
    expect(staleValidSnapshot.modelPolicies).toContain("company_research.planning");

    const driftedAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          modelPolicies: [],
          registrationSnapshot: staleValidSnapshot,
        } as unknown as ProofRegistrationOverride,
      },
    });

    expect(driftedAAO.getCompanyResearchProof().registrationSnapshot.modelPolicies).toEqual([]);

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: driftedAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_REQUIREMENT_MISSING.*company_research\.planning/);
  });

  it("Sprint 26D Section 10: enforces Model Binding and Adapter integrity from actual proof construction", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const baseAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });
    const staleValidSnapshot = baseAAO.getCompanyResearchProof().registrationSnapshot;
    const validAdapterDef = env.hostCapabilities.getModelAdapter("aao.native-model")!;

    // Case A: Actual binding lacks required capability model.structured_output (while adapter supports it)
    const textOnlyBinding: ModelBindingDefinition = {
      id: "northstar.model.text_only",
      priority: 10,
      capabilities: ["model.text_generation"],
      identity: { provider: "fixture-native", model: "text-only" },
      adapterRef: { id: "aao.native-model", version: "1.0.0" },
    };

    const bindingLacksCapAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          modelBindings: [textOnlyBinding],
          modelAdapters: [validAdapterDef],
          registrationSnapshot: staleValidSnapshot,
        } as unknown as ProofRegistrationOverride,
      },
    });

    expect(
      bindingLacksCapAAO.getCompanyResearchProof().registrationSnapshot.modelBindings[0]?.capabilities
    ).toEqual(["model.text_generation"]);

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: bindingLacksCapAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_CAPABILITY_INCOMPATIBLE/);

    // Case B: Actual adapter lacks model.structured_output (and binding only claims text_generation so createAAO succeeds)
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

    const adapterLacksCapAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          modelBindings: [textOnlyBinding],
          modelAdapters: [textOnlyAdapterDef],
          registrationSnapshot: staleValidSnapshot,
        } as unknown as ProofRegistrationOverride,
      },
    });

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: adapterLacksCapAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: "northstar-commerce",
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_CAPABILITY_INCOMPATIBLE/);

    // Case C: Binding references missing adapter -> fails closed at proof construction (AAOFrameworkError: ADAPTER_NOT_FOUND)
    const bindingWithMissingAdapter: ModelBindingDefinition = {
      id: "northstar.model.missing_adapter",
      priority: 10,
      capabilities: ["model.text_generation", "model.structured_output"],
      adapterRef: { id: "aao.missing-adapter", version: "1.0.0" },
    };
    expect(() =>
      createCompanyAAO({
        manifest: researchOnlyManifest,
        hostCapabilities: env.hostCapabilities,
        principalForRun: env.northstarPrincipalForRun,
        proofRegistrations: {
          company_research: {
            modelBindings: [bindingWithMissingAdapter],
            modelAdapters: [validAdapterDef],
          },
        },
      })
    ).toThrow(AAOFrameworkError);

    // Case D: Binding and adapter capabilities disagree (binding claims structured_output, adapter says unsupported)
    // -> fails closed at proof construction (AAOFrameworkError: ADAPTER_CAPABILITY_UNSUPPORTED) or host composition (CompanyConfigError)
    const bindingClaimingStructured: ModelBindingDefinition = {
      id: "northstar.model.disagree",
      priority: 10,
      capabilities: ["model.text_generation", "model.structured_output"],
      adapterRef: { id: "aao.native-model", version: "1.0.0" },
    };
    expect(() =>
      createCompanyAAO({
        manifest: researchOnlyManifest,
        hostCapabilities: env.hostCapabilities,
        principalForRun: env.northstarPrincipalForRun,
        proofRegistrations: {
          company_research: {
            modelBindings: [bindingClaimingStructured],
            modelAdapters: [textOnlyAdapterDef],
          },
        },
      })
    ).toThrow(/ADAPTER_CAPABILITY_UNSUPPORTED/);

    // Also verify host catalog composition refuses adapter without structured_output before proof construction
    const unsupportedHostCatalog = createHostCapabilityCatalog({
      modelAdapters: { "aao.native-model": textOnlyAdapterDef },
      modelBindings: { "northstar.model.native": bindingClaimingStructured },
    });
    expect(() =>
      createCompanyAAO({
        manifest: researchOnlyManifest,
        hostCapabilities: unsupportedHostCatalog,
        principalForRun: env.northstarPrincipalForRun,
      })
    ).toThrow(CompanyConfigError);
  });

  it("Section 28.4: untrusted caller cannot pass a fake capability array (registeredTools) to authorize an incompatible pack", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    // Proof is missing required tools in actual registration
    const driftedAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          tools: [],
        },
      },
    });

    // Untrusted caller attempts to pass `registeredTools` or `availableTools` in activation input
    const untrustedInput = {
      company: driftedAAO,
      catalog,
      selection: {
        schemaVersion: 1 as const,
        companyId: "northstar-commerce",
        packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
      },
      registeredTools: [
        { id: "public_web.search", version: "1.0.0" },
        { id: "records.dedupe", version: "1.0.0" },
        { id: "public_web.fetch_pages", version: "1.0.0" },
        { id: "records.project", version: "1.0.0" },
        { id: "missing.tool", version: "1.0.0" },
      ],
      availableTools: [
        { id: "public_web.search", version: "1.0.0" },
        { id: "records.dedupe", version: "1.0.0" },
        { id: "public_web.fetch_pages", version: "1.0.0" },
        { id: "records.project", version: "1.0.0" },
      ],
    };

    expect(() =>
      resolveCompanyCapabilityPacks(
        untrustedInput as unknown as Parameters<typeof resolveCompanyCapabilityPacks>[0]
      )
    ).toThrow(/PACK_REQUIREMENT_MISSING.*public_web\.search@1\.0\.0/);
  });

  it("Part F Section 18: enforces atomic whole-selection validation (2 compatible + 1 incompatible -> 0 activated, 0 runs/calls)", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    // Make the 3rd pack (operational_request) incompatible while first 2 are compatible
    const partiallyIncompatibleAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        operational_request: {
          tools: [],
        },
      },
    });

    const initialArborCalls = env.getArborProviderCalls();
    const initialDrafts = env.northstarDraftRepo.getAllDrafts().length;

    let activatedResult: unknown = undefined;
    expect(() => {
      activatedResult = resolveCompanyCapabilityPacks({
        company: partiallyIncompatibleAAO,
        catalog,
        selection: NORTHSTAR_PACK_SELECTION, // selects all 3 packs
      });
    }).toThrow(CapabilityPackError);

    expect(activatedResult).toBeUndefined();
    expect(env.getArborProviderCalls()).toBe(initialArborCalls);
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(initialDrafts);
  });

  it("Part C Section 8: never exposes raw runtime objects (app, prepareWorkflow, handlers, adapters, approval verifiers)", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const northstarAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const northstarPacks = resolveCompanyCapabilityPacks({
      company: northstarAAO,
      catalog,
      selection: NORTHSTAR_PACK_SELECTION,
    });

    expect("app" in northstarAAO).toBe(false);
    expect("prepareWorkflow" in northstarAAO).toBe(false);

    for (const activated of northstarPacks.listPacks()) {
      const facade = activated.facade as {
        readonly registrationSnapshot: CompanyResearchFacade["registrationSnapshot"];
      } & Record<string, unknown>;
      expect("app" in facade).toBe(false);
      expect("prepareWorkflow" in facade).toBe(false);
      expect("toolRegistry" in facade).toBe(false);
      expect("modelRegistry" in facade).toBe(false);
      expect("approvalVerifier" in facade).toBe(false);

      const snapshot = facade.registrationSnapshot;
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.workflow)).toBe(true);
      expect(Object.isFrozen(snapshot.tools)).toBe(true);
      expect(Object.isFrozen(snapshot.modelPolicies)).toBe(true);
      expect(Object.isFrozen(snapshot.modelBindings)).toBe(true);
      expect(Object.isFrozen(snapshot.modelAdapters)).toBe(true);

      for (const tool of snapshot.tools) {
        expect(Object.isFrozen(tool)).toBe(true);
        expect("handler" in tool).toBe(false);
        expect("execute" in tool).toBe(false);
      }
      for (const binding of snapshot.modelBindings) {
        expect(Object.isFrozen(binding)).toBe(true);
        expect(Object.isFrozen(binding.capabilities)).toBe(true);
        expect(Object.isFrozen(binding.adapterRef)).toBe(true);
      }
      for (const adapter of snapshot.modelAdapters) {
        expect(Object.isFrozen(adapter)).toBe(true);
        expect(Object.isFrozen(adapter.capabilities)).toBe(true);
        for (const cap of adapter.capabilities) {
          expect(Object.isFrozen(cap)).toBe(true);
        }
        expect("invoke" in adapter).toBe(false);
        expect("execute" in adapter).toBe(false);
      }
    }

    // Verify external mutation of construction inputs does not rewrite snapshots
    const mutableTools: NonNullable<ProofRegistrationOverride["tools"]>[number][] = [];
    const mutablePolicies: NonNullable<ProofRegistrationOverride["modelPolicies"]>[number][] = [];
    const mutableAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          tools: mutableTools,
          modelPolicies: mutablePolicies,
        },
      },
    });
    const mutableSnap = mutableAAO.getCompanyResearchProof().registrationSnapshot;
    expect(mutableSnap.tools).toHaveLength(0);
    expect(mutableSnap.modelPolicies).toHaveLength(0);

    mutablePolicies.push({
      schemaVersion: 1,
      id: "company_research.planning",
      version: "1.0.0",
      name: "Mutated",
      requiredCapabilities: ["model.structured_output"],
    });
    expect(mutableSnap.modelPolicies).toHaveLength(0);
  });
});
