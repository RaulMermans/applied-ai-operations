import { describe, expect, it } from "vitest";
import {
  createCompanyAAO,
  CompanyAdmissionError,
} from "@aao/example-company-portability";
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

  it("Section 28.1: fails compatibility when a required Tool is removed from actual proof registration (even if an obsolete static constant still lists it)", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    // Even if an obsolete helper lists all tools, actual proof registration is authoritative
    const OBSOLETE_STATIC_TOOLS = [
      { id: "public_web.search", version: "1.0.0" },
      { id: "records.dedupe", version: "1.0.0" },
      { id: "public_web.fetch_pages", version: "1.0.0" },
      { id: "records.project", version: "1.0.0" },
    ];
    expect(OBSOLETE_STATIC_TOOLS).toHaveLength(4);

    // Controlled composition where tools=[] is passed to actual proof registration
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
    ).toThrow(/PACK_REQUIREMENT_MISSING.*public_web\.search@1\.0\.0/);
  });

  it("Section 28.2: fails compatibility when a required Model Policy is removed from actual proof registration", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const driftedAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          modelPolicies: [],
        },
      },
    });

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

  it("Section 28.3: fails compatibility before activation when binding or adapter lacks required model.structured_output capability", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const baseAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });
    const baseSnapshot = baseAAO.getCompanyResearchProof().registrationSnapshot;

    // Case A: Binding lacks model.structured_output
    const bindingLacksCapAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          registrationSnapshot: {
            ...baseSnapshot,
            modelBindings: baseSnapshot.modelBindings.map((b) => ({
              ...b,
              capabilities: ["model.text_generation"],
            })),
            modelAdapters: baseSnapshot.modelAdapters.map((a) => ({
              ...a,
              capabilities: [
                { capability: "model.text_generation", support: "supported" as const },
                { capability: "model.structured_output", support: "supported" as const },
              ],
            })),
          },
        },
      },
    });

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

    // Case B: Adapter manifest lacks model.structured_output
    const adapterLacksCapAAO = createCompanyAAO({
      manifest: researchOnlyManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
      proofRegistrations: {
        company_research: {
          registrationSnapshot: {
            ...baseSnapshot,
            modelAdapters: baseSnapshot.modelAdapters.map((a) => ({
              ...a,
              capabilities: [
                { capability: "model.structured_output", support: "unsupported" as const },
              ],
            })),
          },
        },
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
      expect(Object.isFrozen(snapshot.tools)).toBe(true);
      expect(Object.isFrozen(snapshot.modelPolicies)).toBe(true);
      expect(Object.isFrozen(snapshot.modelBindings)).toBe(true);
      expect(Object.isFrozen(snapshot.modelAdapters)).toBe(true);

      for (const tool of snapshot.tools) {
        expect("handler" in tool).toBe(false);
        expect("execute" in tool).toBe(false);
      }
      for (const adapter of snapshot.modelAdapters) {
        expect("invoke" in adapter).toBe(false);
        expect("execute" in adapter).toBe(false);
      }
    }
  });
});
