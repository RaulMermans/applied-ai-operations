import { describe, expect, it } from "vitest";
import {
  validatePackCompatibility,
  defineCapabilityPack,
  CapabilityPackError,
  COMPANY_RESEARCH_PACK,
  COMPANY_RESEARCH_PACK_MANIFEST,
  DOCUMENT_INTELLIGENCE_PACK,
  OPERATIONAL_REQUEST_PACK,
  type PackCompatibilityContext,
  type VerifiedModelAdapter,
  type VerifiedModelBinding,
} from "../src/index.js";

const VALID_ADAPTER: VerifiedModelAdapter = Object.freeze({
  id: "aao.native-model",
  version: "1.0.0",
  capabilities: Object.freeze([
    { capability: "model.text_generation", support: "supported" as const },
    { capability: "model.structured_output", support: "supported" as const },
    { capability: "model.usage", support: "supported" as const },
    { capability: "model.cancellation", support: "unsupported" as const },
    { capability: "model.tool_call_response", support: "unsupported" as const },
  ]),
});

const VALID_BINDING: VerifiedModelBinding = Object.freeze({
  id: "northstar.model.native",
  capabilities: Object.freeze(["model.text_generation", "model.structured_output"]),
  adapterRef: Object.freeze({ id: "aao.native-model", version: "1.0.0" }),
  adapter: VALID_ADAPTER,
});

describe("Pack Compatibility Preflight Validation", () => {
  const validContext: PackCompatibilityContext = {
    companyId: "northstar-commerce",
    enabledProofs: ["company_research", "document_intelligence", "operational_request"],
    governanceRoles: [{ id: "operations.approver" }],
    integrations: {
      publicWebProviderRef: "northstar.web-provider",
      documentSourceProviderRef: "northstar.doc-provider",
      draftRepositoryRef: "northstar.draft-repository",
    },
    workflow: {
      id: "company_research.proof",
      version: "1.0.0",
      planFingerprint: "d316887874d40e7218ee0dbce3392db29ba8a666b36dcd5d513ebf0a885c2919",
    },
    registeredTools: [
      { id: "public_web.search", version: "1.0.0" },
      { id: "records.dedupe", version: "1.0.0" },
      { id: "public_web.fetch_pages", version: "1.0.0" },
      { id: "records.project", version: "1.0.0" },
    ],
    registeredModelPolicies: [
      "company_research.planning",
      "company_research.synthesis",
    ],
    registeredModelBindings: [VALID_BINDING],
    registeredModelAdapters: [VALID_ADAPTER],
    registeredEvalProfiles: [
      "aao.company-research.evals@1.0.0",
      "aao.document-intelligence.evals@1.0.0",
      "aao.operational-request.evals@1.0.0",
    ],
  };

  it("passes when all compatibility requirements are satisfied and returns verifiedRequirements counts", () => {
    const report = validatePackCompatibility(COMPANY_RESEARCH_PACK, validContext);
    expect(report.compatible).toBe(true);
    expect(report.packIdentity).toBe("aao.company-research@1.0.0");
    expect(report.companyId).toBe("northstar-commerce");
    expect(report.workflowId).toBe("company_research.proof");
    expect(report.planFingerprint).toBe(
      "d316887874d40e7218ee0dbce3392db29ba8a666b36dcd5d513ebf0a885c2919"
    );
    expect(report.verifiedRequirements).toEqual({
      tools: 4,
      modelPolicies: 2,
      modelCapabilities: 1,
      integrations: 1,
      evalProfiles: 1,
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.verifiedRequirements)).toBe(true);

    const diReport = validatePackCompatibility(DOCUMENT_INTELLIGENCE_PACK, {
      ...validContext,
      workflow: DOCUMENT_INTELLIGENCE_PACK.manifest.workflow,
      registeredTools: [{ id: "document.extract_text", version: "1.0.0" }],
      registeredModelPolicies: ["document_intelligence.synthesis"],
    });
    expect(diReport.compatible).toBe(true);
    expect(diReport.verifiedRequirements).toEqual({
      tools: 1,
      modelPolicies: 1,
      modelCapabilities: 1,
      integrations: 1,
      evalProfiles: 1,
    });

    const orReport = validatePackCompatibility(OPERATIONAL_REQUEST_PACK, {
      ...validContext,
      workflow: OPERATIONAL_REQUEST_PACK.manifest.workflow,
      registeredTools: [{ id: "operations.create_change_draft", version: "1.0.0" }],
      registeredModelPolicies: ["operational_request.interpret"],
    });
    expect(orReport.compatible).toBe(true);
    expect(orReport.verifiedRequirements).toEqual({
      tools: 1,
      modelPolicies: 1,
      modelCapabilities: 1,
      integrations: 1,
      evalProfiles: 1,
    });
  });

  describe("Mandatory Registration Evidence Enforcement (Defect 1)", () => {
    it("fails closed with PACK_EVIDENCE_UNAVAILABLE when registeredTools is omitted, undefined, or null", () => {
      const omitted = { ...validContext } as Record<string, unknown>;
      delete omitted.registeredTools;

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, omitted as unknown as PackCompatibilityContext)
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredTools: undefined as unknown as PackCompatibilityContext["registeredTools"],
        })
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredTools: null as unknown as PackCompatibilityContext["registeredTools"],
        })
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);
    });

    it("fails closed with PACK_EVIDENCE_UNAVAILABLE when registeredModelPolicies is omitted, undefined, or null", () => {
      const omitted = { ...validContext } as Record<string, unknown>;
      delete omitted.registeredModelPolicies;

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, omitted as unknown as PackCompatibilityContext)
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelPolicies: undefined as unknown as PackCompatibilityContext["registeredModelPolicies"],
        })
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelPolicies: null as unknown as PackCompatibilityContext["registeredModelPolicies"],
        })
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);
    });

    it("fails closed with PACK_EVIDENCE_UNAVAILABLE when registeredModelBindings is omitted, undefined, or null", () => {
      const omitted = { ...validContext } as Record<string, unknown>;
      delete omitted.registeredModelBindings;

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, omitted as unknown as PackCompatibilityContext)
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelBindings: null as unknown as PackCompatibilityContext["registeredModelBindings"],
        })
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);
    });

    it("fails closed with PACK_EVIDENCE_UNAVAILABLE when registeredEvalProfiles is omitted, undefined, or null", () => {
      const omitted = { ...validContext } as Record<string, unknown>;
      delete omitted.registeredEvalProfiles;

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, omitted as unknown as PackCompatibilityContext)
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredEvalProfiles: undefined as unknown as PackCompatibilityContext["registeredEvalProfiles"],
        })
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredEvalProfiles: null as unknown as PackCompatibilityContext["registeredEvalProfiles"],
        })
      ).toThrowError(/PACK_EVIDENCE_UNAVAILABLE/);
    });

    it("permits empty evidence arrays only when the pack has zero requirements in that category", () => {
      const zeroToolPack = defineCapabilityPack({
        ...COMPANY_RESEARCH_PACK_MANIFEST,
        id: "aao.zero-tools",
        requirements: {
          ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
          toolRefs: [],
          modelPolicyRefs: [],
          modelCapabilities: [],
          integrationSlots: [],
        },
      });

      const report = validatePackCompatibility(zeroToolPack, {
        ...validContext,
        enabledProofs: ["zero_tools"],
        registeredTools: [],
        registeredModelPolicies: [],
        registeredModelBindings: [],
        registeredModelAdapters: [],
      });
      expect(report.compatible).toBe(true);
      expect(report.verifiedRequirements.tools).toBe(0);
      expect(report.verifiedRequirements.modelPolicies).toBe(0);
      expect(report.verifiedRequirements.modelCapabilities).toBe(0);

      // Empty tools fail when pack requires tools
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredTools: [],
        })
      ).toThrowError(/PACK_REQUIREMENT_MISSING/);
    });

    it("rejects duplicate and conflicting tool, policy, binding, adapter, and eval registrations", () => {
      // Duplicate tool
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredTools: [
            ...validContext.registeredTools,
            { id: "public_web.search", version: "1.0.0" },
          ],
        })
      ).toThrowError(/PACK_DUPLICATE_REF/);

      // Conflicting tool version
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredTools: [
            ...validContext.registeredTools,
            { id: "public_web.search", version: "2.0.0" },
          ],
        })
      ).toThrowError(/PACK_DUPLICATE_REF/);

      // Duplicate model policy
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelPolicies: [
            "company_research.planning",
            "company_research.planning",
          ],
        })
      ).toThrowError(/PACK_DUPLICATE_REF/);

      // Duplicate model binding ID
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelBindings: [VALID_BINDING, VALID_BINDING],
        })
      ).toThrowError(/PACK_DUPLICATE_REF/);

      // Duplicate model adapter
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelAdapters: [VALID_ADAPTER, VALID_ADAPTER],
        })
      ).toThrowError(/PACK_DUPLICATE_REF/);

      // Duplicate eval profile
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredEvalProfiles: [
            "aao.company-research.evals@1.0.0",
            "aao.company-research.evals@1.0.0",
          ],
        })
      ).toThrowError(/PACK_DUPLICATE_REF/);

      // Conflicting eval profile version
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredEvalProfiles: [
            "aao.company-research.evals@1.0.0",
            "aao.company-research.evals@2.0.0",
          ],
        })
      ).toThrowError(/PACK_DUPLICATE_REF/);
    });
  });

  describe("Workflow, Proof, Tool, Policy, Integration, and Governance Checks", () => {
    it("fails with PACK_WORKFLOW_MISMATCH when workflow ID or version differs", () => {
      const badWorkflow = {
        ...validContext,
        workflow: {
          ...validContext.workflow,
          id: "different.workflow",
        },
      };
      expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, badWorkflow)).toThrow(
        CapabilityPackError
      );
      expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, badWorkflow)).toThrow(
        /PACK_WORKFLOW_MISMATCH/
      );
    });

    it("fails with PACK_WORKFLOW_MISMATCH when planFingerprint differs", () => {
      const tamperedPlan = {
        ...validContext,
        workflow: {
          ...validContext.workflow,
          planFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
        },
      };
      expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, tamperedPlan)).toThrow(
        CapabilityPackError
      );
      expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, tamperedPlan)).toThrow(
        /PACK_WORKFLOW_MISMATCH/
      );
    });

    it("fails with PACK_PROOF_DISABLED when proof is not enabled for company", () => {
      const disabledProof = {
        ...validContext,
        enabledProofs: ["document_intelligence"],
      };
      expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, disabledProof)).toThrow(
        /PACK_PROOF_DISABLED/
      );
    });

    it("fails with PACK_REQUIREMENT_MISSING when a required tool is missing or has wrong version", () => {
      const missingTool = {
        ...validContext,
        registeredTools: [{ id: "public_web.search", version: "1.0.0" }],
      };
      expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingTool)).toThrow(
        /PACK_REQUIREMENT_MISSING/
      );

      const wrongVersionTool = {
        ...validContext,
        registeredTools: [
          { id: "public_web.search", version: "1.0.0" },
          { id: "records.dedupe", version: "2.0.0" }, // pack requires 1.0.0
          { id: "public_web.fetch_pages", version: "1.0.0" },
          { id: "records.project", version: "1.0.0" },
        ],
      };
      expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, wrongVersionTool)).toThrow(
        /PACK_REQUIREMENT_MISSING/
      );
    });

    it("fails with PACK_REQUIREMENT_MISSING when a required model policy is missing", () => {
      const missingPolicy = {
        ...validContext,
        registeredModelPolicies: ["company_research.planning"], // synthesis missing
      };
      expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingPolicy)).toThrow(
        /PACK_REQUIREMENT_MISSING/
      );
    });

    it("fails with PACK_REQUIREMENT_MISSING when required integration slot is missing", () => {
      const missingSlot = {
        ...validContext,
        integrations: {},
      };
      expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingSlot)).toThrow(
        /PACK_REQUIREMENT_MISSING/
      );
    });

    it("fails with PACK_GOVERNANCE_INCOMPATIBLE when required approver role is missing from governance", () => {
      const opsContext: PackCompatibilityContext = {
        ...validContext,
        enabledProofs: ["operational_request"],
        governanceRoles: [{ id: "unrelated.role" }],
        workflow: OPERATIONAL_REQUEST_PACK.manifest.workflow,
        registeredTools: [{ id: "operations.create_change_draft", version: "1.0.0" }],
        registeredModelPolicies: ["operational_request.interpret"],
      };

      expect(() => validatePackCompatibility(OPERATIONAL_REQUEST_PACK, opsContext)).toThrow(
        /PACK_GOVERNANCE_INCOMPATIBLE/
      );
    });
  });

  describe("Verified Model Binding and Adapter Capability Matrix (Defect 2)", () => {
    it("fails with PACK_CAPABILITY_INCOMPATIBLE when binding omits structured output even if adapter supports it", () => {
      const textOnlyBinding: VerifiedModelBinding = {
        id: "northstar.model.text-only",
        capabilities: ["model.text_generation"], // omits model.structured_output
        adapterRef: { id: "aao.native-model", version: "1.0.0" },
        adapter: VALID_ADAPTER,
      };
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelBindings: [textOnlyBinding],
          registeredModelAdapters: [VALID_ADAPTER],
        })
      ).toThrowError(/PACK_CAPABILITY_INCOMPATIBLE/);
    });

    it("fails with PACK_CAPABILITY_INCOMPATIBLE when adapter declares unsupported structured output", () => {
      const unsupportedAdapter: VerifiedModelAdapter = {
        id: "aao.native-model",
        version: "1.0.0",
        capabilities: [
          { capability: "model.text_generation", support: "supported" },
          { capability: "model.structured_output", support: "unsupported" },
        ],
      };
      const bindingClaimingStructured: VerifiedModelBinding = {
        id: "northstar.model.native",
        capabilities: ["model.text_generation", "model.structured_output"],
        adapterRef: { id: "aao.native-model", version: "1.0.0" },
        adapter: unsupportedAdapter,
      };
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelBindings: [bindingClaimingStructured],
          registeredModelAdapters: [unsupportedAdapter],
        })
      ).toThrowError(/PACK_CAPABILITY_INCOMPATIBLE/);
    });

    it("fails with PACK_CAPABILITY_INCOMPATIBLE when adapter is missing", () => {
      const bindingWithoutAdapter: VerifiedModelBinding = {
        id: "northstar.model.native",
        capabilities: ["model.text_generation", "model.structured_output"],
        adapterRef: { id: "aao.missing-adapter", version: "1.0.0" },
      };
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelBindings: [bindingWithoutAdapter],
          registeredModelAdapters: [],
        })
      ).toThrowError(/PACK_CAPABILITY_INCOMPATIBLE/);

      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelBindings: [bindingWithoutAdapter],
          registeredModelAdapters: undefined,
        })
      ).toThrowError(/PACK_CAPABILITY_INCOMPATIBLE/);
    });

    it("fails with PACK_CAPABILITY_INCOMPATIBLE when binding references the wrong adapter", () => {
      const wrongAdapterBinding: VerifiedModelBinding = {
        id: "northstar.model.native",
        capabilities: ["model.text_generation", "model.structured_output"],
        adapterRef: { id: "aao.vercel-ai-sdk", version: "1.0.0" },
        adapter: VALID_ADAPTER, // id is aao.native-model != aao.vercel-ai-sdk
      };
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelBindings: [wrongAdapterBinding],
          registeredModelAdapters: [VALID_ADAPTER],
        })
      ).toThrowError(/PACK_CAPABILITY_INCOMPATIBLE/);

      // Also test when binding has no inline adapter and registeredModelAdapters only has aao.native-model@1.0.0
      const wrongRefOnly: VerifiedModelBinding = {
        id: "northstar.model.native",
        capabilities: ["model.text_generation", "model.structured_output"],
        adapterRef: { id: "aao.native-model", version: "2.0.0" },
      };
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelBindings: [wrongRefOnly],
          registeredModelAdapters: [VALID_ADAPTER],
        })
      ).toThrowError(/PACK_CAPABILITY_INCOMPATIBLE/);
    });

    it("fails with PACK_CAPABILITY_INCOMPATIBLE when capabilities are split across unrelated bindings", () => {
      const multiCapPack = defineCapabilityPack({
        ...COMPANY_RESEARCH_PACK_MANIFEST,
        requirements: {
          ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
          modelCapabilities: ["model.structured_output", "model.usage"],
        },
      });

      const bindingA: VerifiedModelBinding = {
        id: "binding.structured-only",
        capabilities: ["model.structured_output"],
        adapterRef: { id: "aao.native-model", version: "1.0.0" },
        adapter: VALID_ADAPTER,
      };
      const bindingB: VerifiedModelBinding = {
        id: "binding.usage-only",
        capabilities: ["model.usage"],
        adapterRef: { id: "aao.native-model", version: "1.0.0" },
        adapter: VALID_ADAPTER,
      };

      // Neither bindingA nor bindingB alone supports both model.structured_output and model.usage
      expect(() =>
        validatePackCompatibility(multiCapPack, {
          ...validContext,
          registeredModelBindings: [bindingA, bindingB],
          registeredModelAdapters: [VALID_ADAPTER],
        })
      ).toThrowError(/PACK_CAPABILITY_INCOMPATIBLE/);
    });

    it("fails with PACK_CAPABILITY_INCOMPATIBLE when capability name is unknown", () => {
      const unknownCapBinding: VerifiedModelBinding = {
        id: "northstar.model.unknown",
        capabilities: ["model.unknown_capability"],
        adapterRef: { id: "aao.native-model", version: "1.0.0" },
        adapter: VALID_ADAPTER,
      };
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredModelBindings: [unknownCapBinding],
          registeredModelAdapters: [VALID_ADAPTER],
        })
      ).toThrowError(/PACK_CAPABILITY_INCOMPATIBLE/);

      const unknownCapPack = defineCapabilityPack({
        ...COMPANY_RESEARCH_PACK_MANIFEST,
        requirements: {
          ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
          modelCapabilities: ["model.nonexistent_feature"],
        },
      });
      expect(() => validatePackCompatibility(unknownCapPack, validContext)).toThrowError(
        /PACK_CAPABILITY_INCOMPATIBLE/
      );
    });
  });

  describe("Evaluation Profile Verification (Defect 3)", () => {
    it("fails with PACK_VERIFICATION_PROFILE_MISSING when required evalProfileRef is not registered", () => {
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredEvalProfiles: ["aao.document-intelligence.evals@1.0.0"],
        })
      ).toThrowError(/PACK_VERIFICATION_PROFILE_MISSING/);
    });

    it("fails with PACK_VERIFICATION_PROFILE_MISSING when registered eval profile has wrong version", () => {
      expect(() =>
        validatePackCompatibility(COMPANY_RESEARCH_PACK, {
          ...validContext,
          registeredEvalProfiles: ["aao.company-research.evals@2.0.0"],
        })
      ).toThrowError(/PACK_VERIFICATION_PROFILE_MISSING/);
    });
  });
});
