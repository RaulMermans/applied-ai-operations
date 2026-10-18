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

  it("fails composition with CONFIG_CAPABILITY_INCOMPATIBLE when model binding lacks structured output", () => {
    const env = createTestHostEnvironment();
    const incompatibleCatalog = createHostCapabilityCatalog({
      modelAdapters: env.hostCapabilities.modelAdapters,
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
      publicWebProviders: env.hostCapabilities.publicWebProviders,
      documentSourceProviders: env.hostCapabilities.documentSourceProviders,
      draftRepositories: env.hostCapabilities.draftRepositories,
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
