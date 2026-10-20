import { describe, expect, it } from "vitest";
import {
  createCompanyAAO,
} from "../src/composition.js";
import {
  createHostCapabilityCatalog,
} from "../src/catalog.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
} from "../fixtures/index.js";

describe("Sprint 25 — Company Composition & Portability Tests", () => {
  it("keeps catalog bindings stable through input and consumer mutation before later composition", async () => {
    const env = createTestHostEnvironment();
    const original = env.hostCapabilities.getPublicWebProvider("arbor.web-provider")!;
    const input = new Map([["arbor.web-provider", original]]);
    const catalog = createHostCapabilityCatalog({
      modelAdapters: [["aao.vercel-ai-sdk", env.hostCapabilities.getModelAdapter("aao.vercel-ai-sdk")!]],
      modelBindings: [["arbor.model.vercel", env.hostCapabilities.getModelBinding("arbor.model.vercel")!]],
      publicWebProviders: input,
    });
    const first = createCompanyAAO({
      manifest: { ...ARBOR_MANIFEST, enabledProofs: ["company_research"] },
      hostCapabilities: catalog,
      principalForRun: env.arborPrincipalForRun,
    });
    input.set("arbor.web-provider", env.northstarWebProvider);
    input.delete("arbor.web-provider");
    input.clear();
    const consumer = catalog as unknown as Record<string, unknown>;
    expect(consumer.publicWebProviders).toBeUndefined();
    expect(consumer.set).toBeUndefined();
    expect(consumer.delete).toBeUndefined();
    expect(consumer.clear).toBeUndefined();
    expect(() => { consumer.getPublicWebProvider = () => env.northstarWebProvider; }).toThrow();
    expect(catalog.getPublicWebProvider("arbor.web-provider")).toBe(original);
    expect(catalog.getPublicWebProvider("missing")).toBeUndefined();
    const later = createCompanyAAO({
      manifest: { ...ARBOR_MANIFEST, enabledProofs: ["company_research"] },
      hostCapabilities: catalog,
      principalForRun: env.arborPrincipalForRun,
    });
    expect(first.getCompanyResearchProof().planFingerprint).toBe(later.getCompanyResearchProof().planFingerprint);
    expect(catalog.getPublicWebProvider("arbor.web-provider")).toBe(original);
    const request = { company: { name: "Arbor Consulting", domain: "arbor.example" }, questions: [{ id: "offering", question: "What services does Arbor offer?" }] };
    expect((await first.runCompanyResearch({ runId: "catalog.first", request })).status).toBe("completed");
    expect((await later.runCompanyResearch({ runId: "catalog.later", request })).status).toBe("completed");
    expect(env.arborWebProvider.calls.search.length).toBeGreaterThan(0);
    expect(env.northstarWebProvider.calls.search.length).toBe(0);
    expect(createHostCapabilityCatalog({ publicWebProviders: [["arbor.web-provider", env.northstarWebProvider]] }).getPublicWebProvider("arbor.web-provider")).not.toBe(original);
    expect(() => createHostCapabilityCatalog({ publicWebProviders: [["same", original], ["same", env.northstarWebProvider]] })).toThrow(/Duplicate host capability reference/);
  });

  it("composes Northstar and Arbor with identical Workflow plan fingerprints", () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // 1. Mandatory Plan Fingerprint Equality (Zero Workflow Forks)
    const nsResearch = northstar.getCompanyResearchProof();
    const arbResearch = arbor.getCompanyResearchProof();
    expect(nsResearch.planFingerprint).toBe(arbResearch.planFingerprint);
    expect(nsResearch.workflow.id).toBe("company_research.proof");

    const nsDoc = northstar.getDocumentIntelligenceProof();
    const arbDoc = arbor.getDocumentIntelligenceProof();
    expect(nsDoc.planFingerprint).toBe(arbDoc.planFingerprint);
    expect(nsDoc.workflow.id).toBe("document_intelligence.proof");

    const nsOps = northstar.getOperationalRequestProof();
    const arbOps = arbor.getOperationalRequestProof();
    expect(nsOps.planFingerprint).toBe(arbOps.planFingerprint);
    expect(nsOps.workflow.id).toBe("operational_request.proof");

    // 2. Distinct Configuration Identity
    expect(northstar.configFingerprint).not.toBe(arbor.configFingerprint);
    expect(northstar.companyId).toBe("northstar-commerce");
    expect(arbor.companyId).toBe("arbor-consulting");
  });

  it("fails composition with CONFIG_CAPABILITY_NOT_FOUND when model binding is unregistered", () => {
    const env = createTestHostEnvironment();
    const unregBindingManifest = {
      ...NORTHSTAR_MANIFEST,
      models: { bindingRefs: ["unregistered.model.binding"] },
    };

    expect(() =>
      createCompanyAAO({
        manifest: unregBindingManifest,
        hostCapabilities: env.hostCapabilities,
        principalForRun: env.northstarPrincipalForRun,
      })
    ).toThrowError(/CONFIG_CAPABILITY_NOT_FOUND/);
  });

  it("refuses a missing operational approver before composing or calling capabilities", () => {
    const env = createTestHostEnvironment();
    const governance = {
      ...NORTHSTAR_MANIFEST.governance,
      roles: NORTHSTAR_MANIFEST.governance.roles.filter((role) => role.id !== "operations.approver"),
      bindings: NORTHSTAR_MANIFEST.governance.bindings.filter((binding) => binding.roleId !== "operations.approver"),
    };
    expect(() => createCompanyAAO({
      manifest: { ...NORTHSTAR_MANIFEST, governance },
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    })).toThrow(/CONFIG_GOVERNANCE_INVALID/);
    expect(env.northstarWebProvider.calls.search).toHaveLength(0);
    expect(env.northstarDraftRepo.getAllDrafts()).toHaveLength(0);
  });

  it("fails composition with CONFIG_CAPABILITY_INCOMPATIBLE when model binding lacks structured output", () => {
    const env = createTestHostEnvironment();
    const incompatibleCatalog = createHostCapabilityCatalog({
      modelAdapters: {
        "aao.native-model": env.hostCapabilities.getModelAdapter("aao.native-model")!,
      },
      modelBindings: {
        "text-only.binding": {
          id: "text-only.binding",
          priority: 10,
          // Missing model.structured_output
          capabilities: ["model.text_generation" as const],
          identity: { provider: "mock", model: "text-only" },
          adapterRef: { id: "aao.native-model", version: "1.0.0" },
        },
      },
    });

    const manifest = {
      ...NORTHSTAR_MANIFEST,
      models: { bindingRefs: ["text-only.binding"] },
    };

    expect(() =>
      createCompanyAAO({
        manifest,
        hostCapabilities: incompatibleCatalog,
        principalForRun: env.northstarPrincipalForRun,
      })
    ).toThrowError(/CONFIG_CAPABILITY_INCOMPATIBLE/);
  });

  it("fails composition with CONFIG_CAPABILITY_NOT_FOUND when provider is missing from catalog", () => {
    const env = createTestHostEnvironment();
    const missingProviderManifest = {
      ...NORTHSTAR_MANIFEST,
      integrations: {
        ...NORTHSTAR_MANIFEST.integrations,
        publicWebProviderRef: "missing.web-provider",
      },
    };

    expect(() =>
      createCompanyAAO({
        manifest: missingProviderManifest,
        hostCapabilities: env.hostCapabilities,
        principalForRun: env.northstarPrincipalForRun,
      })
    ).toThrowError(/CONFIG_CAPABILITY_NOT_FOUND/);
  });

  it("enforces disabled proof with CONFIG_PROOF_DISABLED before execution", async () => {
    const env = createTestHostEnvironment();
    // Manifest with operational_request disabled
    const disabledOpsManifest = {
      ...NORTHSTAR_MANIFEST,
      enabledProofs: ["company_research" as const, "document_intelligence" as const],
      integrations: {
        publicWebProviderRef: "northstar.web-provider",
        documentSourceProviderRef: "northstar.doc-provider",
      },
    };

    const company = createCompanyAAO({
      manifest: disabledOpsManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    expect(() => company.getOperationalRequestProof()).toThrowError(/CONFIG_PROOF_DISABLED/);

    await expect(
      company.executeOperationalRequest({
        runId: "run.disabled",
        request: {
          schemaVersion: 1,
          requestId: "req-001",
          instruction: "Test instruction",
          accountContext: { accountId: "ACC-01", currentDisplayName: "Old" },
        },
      })
    ).rejects.toThrowError(/CONFIG_PROOF_DISABLED/);

    // 0 drafts created
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(0);
  });

  it("configuration-only mutation test: changes configuration fingerprint while preserving plan fingerprints", () => {
    const env = createTestHostEnvironment();

    const original = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    // Mutate only allowed declarative configuration (display name & reliability timeout)
    const modifiedManifest = {
      ...NORTHSTAR_MANIFEST,
      displayName: "Northstar Commerce International",
      reliability: {
        company_research: {
          search: { maxAttempts: 3, attemptTimeoutMs: 20000 },
        },
      },
    };

    const modified = createCompanyAAO({
      manifest: modifiedManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    // Configuration fingerprint changed
    expect(modified.configFingerprint).not.toBe(original.configFingerprint);

    // All Workflow plan fingerprints remain completely identical
    expect(modified.getCompanyResearchProof().planFingerprint).toBe(
      original.getCompanyResearchProof().planFingerprint
    );
    expect(modified.getDocumentIntelligenceProof().planFingerprint).toBe(
      original.getDocumentIntelligenceProof().planFingerprint
    );
    expect(modified.getOperationalRequestProof().planFingerprint).toBe(
      original.getOperationalRequestProof().planFingerprint
    );
  });
});
