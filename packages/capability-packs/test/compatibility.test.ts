import { describe, expect, it } from "vitest";
import {
  validatePackCompatibility,
  CapabilityPackError,
  COMPANY_RESEARCH_PACK,
  OPERATIONAL_REQUEST_PACK,
  type PackCompatibilityContext,
} from "../src/index.js";

describe("Pack Compatibility Preflight Validation", () => {
  const validContext: PackCompatibilityContext = {
    companyId: "northstar-commerce",
    enabledProofs: ["company_research"],
    governanceRoles: [],
    modelBindings: [
      { id: "northstar-model", capabilities: ["model.structured_output"] },
    ],
    integrations: {
      publicWebProviderRef: "northstar.web-provider",
    },
    workflow: {
      id: "company_research.proof",
      version: "1.0.0",
      planFingerprint: "d316887874d40e7218ee0dbce3392db29ba8a666b36dcd5d513ebf0a885c2919",
    },
    availableTools: [
      { id: "public_web.search", version: "1.0.0" },
      { id: "records.dedupe", version: "1.0.0" },
      { id: "public_web.fetch_pages", version: "1.0.0" },
      { id: "records.project", version: "1.0.0" },
    ],
    availableModelPolicies: [
      "company_research.planning",
      "company_research.synthesis",
    ],
  };

  it("passes when all compatibility requirements are satisfied", () => {
    const report = validatePackCompatibility(COMPANY_RESEARCH_PACK, validContext);
    expect(report.compatible).toBe(true);
    expect(report.packIdentity).toBe("aao.company-research@1.0.0");
    expect(report.companyId).toBe("northstar-commerce");
    expect(report.workflowId).toBe("company_research.proof");
    expect(report.planFingerprint).toBe("d316887874d40e7218ee0dbce3392db29ba8a666b36dcd5d513ebf0a885c2919");
  });

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
      enabledProofs: ["document_intelligence"], // company_research is missing!
    };
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, disabledProof)).toThrow(
      CapabilityPackError
    );
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, disabledProof)).toThrow(
      /PACK_PROOF_DISABLED/
    );
  });

  it("fails with PACK_REQUIREMENT_MISSING when a required tool is missing", () => {
    const missingTool = {
      ...validContext,
      availableTools: [
        { id: "public_web.search", version: "1.0.0" },
        // records.dedupe missing!
      ],
    };
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingTool)).toThrow(
      CapabilityPackError
    );
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingTool)).toThrow(
      /PACK_REQUIREMENT_MISSING/
    );
  });

  it("fails with PACK_REQUIREMENT_MISSING when a required model policy is missing", () => {
    const missingPolicy = {
      ...validContext,
      availableModelPolicies: ["company_research.planning"], // synthesis missing
    };
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingPolicy)).toThrow(
      CapabilityPackError
    );
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingPolicy)).toThrow(
      /PACK_REQUIREMENT_MISSING/
    );
  });

  it("fails with PACK_CAPABILITY_INCOMPATIBLE when model binding lacks required capability", () => {
    const missingCap = {
      ...validContext,
      modelBindings: [
        { id: "basic-model", capabilities: ["model.plain_text"] }, // lacks structured_output!
      ],
    };
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingCap)).toThrow(
      CapabilityPackError
    );
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingCap)).toThrow(
      /PACK_CAPABILITY_INCOMPATIBLE/
    );
  });

  it("fails with PACK_REQUIREMENT_MISSING when required integration slot is missing", () => {
    const missingSlot = {
      ...validContext,
      integrations: {}, // publicWebProviderRef missing!
    };
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingSlot)).toThrow(
      CapabilityPackError
    );
    expect(() => validatePackCompatibility(COMPANY_RESEARCH_PACK, missingSlot)).toThrow(
      /PACK_REQUIREMENT_MISSING/
    );
  });

  it("fails with PACK_GOVERNANCE_INCOMPATIBLE when required approver role is missing from governance", () => {
    const opsContext: PackCompatibilityContext = {
      companyId: "northstar-commerce",
      enabledProofs: ["operational_request"],
      governanceRoles: [{ id: "unrelated.role" }], // operations.approver missing!
      modelBindings: [
        { id: "northstar-model", capabilities: ["model.structured_output"] },
      ],
      integrations: {
        draftRepositoryRef: "northstar.draft-repo",
      },
      workflow: {
        id: "operational_request.proof",
        version: "1.0.0",
        planFingerprint: "8323d4dca07e54cb66fa8dd7f0614cf17a2afcd501d39c99802bd0b07c0d9d73",
      },
    };

    expect(() => validatePackCompatibility(OPERATIONAL_REQUEST_PACK, opsContext)).toThrow(
      CapabilityPackError
    );
    expect(() => validatePackCompatibility(OPERATIONAL_REQUEST_PACK, opsContext)).toThrow(
      /PACK_GOVERNANCE_INCOMPATIBLE/
    );
  });
});
