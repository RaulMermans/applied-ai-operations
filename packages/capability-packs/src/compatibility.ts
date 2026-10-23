import { CapabilityPackError } from "./errors.js";
import type { CapabilityPack } from "./pack.js";

export interface PackCompatibilityContext {
  readonly companyId: string;
  readonly enabledProofs: ReadonlyArray<string>;
  readonly governanceRoles: ReadonlyArray<{ id: string }>;
  readonly modelBindings: ReadonlyArray<{ id: string; capabilities: ReadonlyArray<string> }>;
  readonly integrations: {
    readonly publicWebProviderRef?: string;
    readonly documentSourceProviderRef?: string;
    readonly draftRepositoryRef?: string;
  };
  readonly workflow: {
    readonly id: string;
    readonly version: string;
    readonly planFingerprint: string;
  };
  readonly availableTools?: ReadonlyArray<{ id: string; version: string }>;
  readonly availableModelPolicies?: ReadonlyArray<string>;
}

export interface PackCompatibilityReport {
  readonly compatible: true;
  readonly packIdentity: string;
  readonly companyId: string;
  readonly workflowId: string;
  readonly planFingerprint: string;
}

/**
 * Maps a canonical capability pack ID to its corresponding AAO proof name.
 */
export function getRequiredProofName(packId: string): string {
  switch (packId) {
    case "aao.company-research":
      return "company_research";
    case "aao.document-intelligence":
      return "document_intelligence";
    case "aao.operational-request":
      return "operational_request";
    default:
      // By default derive proof name from id suffix (e.g. "aao.custom-proof" -> "custom_proof")
      return packId.replace(/^aao\./, "").replace(/-/g, "_");
  }
}

/**
 * Validates preflight compatibility between a Capability Pack and a company's
 * configured capabilities and workflow context.
 *
 * Fails fast BEFORE workflow preparation or execution if any requirement is unsatisfied.
 */
export function validatePackCompatibility(
  pack: CapabilityPack,
  context: PackCompatibilityContext
): PackCompatibilityReport {
  const manifest = pack.manifest;

  // 1. Validate Workflow identity and plan fingerprint pinning
  if (manifest.workflow.id !== context.workflow.id || manifest.workflow.version !== context.workflow.version) {
    throw new CapabilityPackError(
      "PACK_WORKFLOW_MISMATCH",
      `Pack '${pack.identity}' expects workflow '${manifest.workflow.id}@${manifest.workflow.version}', but context provides '${context.workflow.id}@${context.workflow.version}'`
    );
  }

  if (manifest.workflow.planFingerprint !== context.workflow.planFingerprint) {
    throw new CapabilityPackError(
      "PACK_WORKFLOW_MISMATCH",
      `Pack '${pack.identity}' expects plan fingerprint '${manifest.workflow.planFingerprint}', but prepared workflow has '${context.workflow.planFingerprint}'`
    );
  }

  // 2. Validate company proof enablement
  const requiredProof = getRequiredProofName(manifest.id);
  if (!context.enabledProofs.includes(requiredProof)) {
    throw new CapabilityPackError(
      "PACK_PROOF_DISABLED",
      `Proof '${requiredProof}' required by pack '${pack.identity}' is disabled for company '${context.companyId}'`
    );
  }

  // 3. Validate Tool requirements if availableTools provided
  if (context.availableTools) {
    for (const requiredTool of manifest.requirements.toolRefs) {
      const match = context.availableTools.some(
        (t) => t.id === requiredTool.id && t.version === requiredTool.version
      );
      if (!match) {
        throw new CapabilityPackError(
          "PACK_REQUIREMENT_MISSING",
          `Pack '${pack.identity}' requires tool '${requiredTool.id}@${requiredTool.version}', but it is not available in host capabilities`
        );
      }
    }
  }

  // 4. Validate Model Policy requirements if availableModelPolicies provided
  if (context.availableModelPolicies) {
    for (const requiredPolicy of manifest.requirements.modelPolicyRefs) {
      if (!context.availableModelPolicies.includes(requiredPolicy)) {
        throw new CapabilityPackError(
          "PACK_REQUIREMENT_MISSING",
          `Pack '${pack.identity}' requires model policy '${requiredPolicy}', but it is not available in host environment`
        );
      }
    }
  }

  // 5. Validate Model Capabilities across resolved company bindings
  for (const cap of manifest.requirements.modelCapabilities) {
    const supported = context.modelBindings.some((b) => b.capabilities.includes(cap));
    if (!supported) {
      throw new CapabilityPackError(
        "PACK_CAPABILITY_INCOMPATIBLE",
        `Pack '${pack.identity}' requires model capability '${cap}', but no registered model binding supports it`
      );
    }
  }

  // 6. Validate Integration Slots
  for (const slot of manifest.requirements.integrationSlots) {
    switch (slot.slot) {
      case "public_web":
        if (!context.integrations.publicWebProviderRef) {
          throw new CapabilityPackError(
            "PACK_REQUIREMENT_MISSING",
            `Pack '${pack.identity}' requires integration slot 'public_web', but publicWebProviderRef is not configured for company '${context.companyId}'`
          );
        }
        break;
      case "document_source":
        if (!context.integrations.documentSourceProviderRef) {
          throw new CapabilityPackError(
            "PACK_REQUIREMENT_MISSING",
            `Pack '${pack.identity}' requires integration slot 'document_source', but documentSourceProviderRef is not configured for company '${context.companyId}'`
          );
        }
        break;
      case "draft_repository":
        if (!context.integrations.draftRepositoryRef) {
          throw new CapabilityPackError(
            "PACK_REQUIREMENT_MISSING",
            `Pack '${pack.identity}' requires integration slot 'draft_repository', but draftRepositoryRef is not configured for company '${context.companyId}'`
          );
        }
        break;
      default:
        throw new CapabilityPackError(
          "PACK_REQUIREMENT_MISSING",
          `Pack '${pack.identity}' references unrecognized integration slot '${slot.slot}'`
        );
    }
  }

  // 7. Validate Governance and Approval requirements
  if (manifest.requirements.approval?.required) {
    for (const roleId of manifest.requirements.approval.requiredRoleIds) {
      const exists = context.governanceRoles.some((r) => r.id === roleId);
      if (!exists) {
        throw new CapabilityPackError(
          "PACK_GOVERNANCE_INCOMPATIBLE",
          `Pack '${pack.identity}' requires approver role '${roleId}', but it is not defined in governance for company '${context.companyId}'`
        );
      }
    }
  }

  return Object.freeze({
    compatible: true,
    packIdentity: pack.identity,
    companyId: context.companyId,
    workflowId: manifest.workflow.id,
    planFingerprint: manifest.workflow.planFingerprint,
  });
}
