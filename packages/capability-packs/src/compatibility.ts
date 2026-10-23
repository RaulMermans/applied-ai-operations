import { identifierSchema } from "@aao/contracts";
import {
  ExactEvalProfileRefSchema,
  ExactPackVersionSchema,
  ExactToolRefSchema,
  SUPPORTED_MODEL_CAPABILITIES,
  type ExactToolRef,
} from "./contract.js";
import { CapabilityPackError } from "./errors.js";
import { deepFreeze } from "./json.js";
import type { CapabilityPack } from "./pack.js";

const SUPPORTED_MODEL_CAPABILITY_SET = new Set<string>(SUPPORTED_MODEL_CAPABILITIES);

export interface VerifiedModelAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: ReadonlyArray<{
    readonly capability: string;
    readonly support: "supported" | "unsupported";
  }>;
}

export interface VerifiedModelBinding {
  readonly id: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly adapterRef: {
    readonly id: string;
    readonly version: string;
  };
  readonly adapter?: VerifiedModelAdapter;
}

export interface ProofRegistrationSnapshot {
  readonly workflow: {
    readonly id: string;
    readonly version: string;
    readonly planFingerprint: string;
  };
  readonly tools: ReadonlyArray<ExactToolRef>;
  readonly modelPolicies: ReadonlyArray<string>;
  readonly modelBindings: ReadonlyArray<VerifiedModelBinding>;
  readonly modelAdapters: ReadonlyArray<VerifiedModelAdapter>;
}

/**
 * Compatibility preflight context containing mandatory, verified registration
 * evidence. Input to `validatePackCompatibility` is trusted registration evidence
 * by contract, never an authorization credential.
 */
export interface PackCompatibilityContext {
  readonly companyId: string;
  readonly enabledProofs: ReadonlyArray<string>;
  readonly governanceRoles: ReadonlyArray<{ readonly id: string }>;
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
  readonly registeredTools: ReadonlyArray<ExactToolRef>;
  readonly registeredModelPolicies: ReadonlyArray<string>;
  readonly registeredModelBindings: ReadonlyArray<VerifiedModelBinding>;
  readonly registeredModelAdapters?: ReadonlyArray<VerifiedModelAdapter>;
  readonly registeredEvalProfiles: ReadonlyArray<string>;
}

export interface PackCompatibilityReport {
  readonly compatible: true;
  readonly packIdentity: string;
  readonly companyId: string;
  readonly workflowId: string;
  readonly planFingerprint: string;
  readonly verifiedRequirements: {
    readonly tools: number;
    readonly modelPolicies: number;
    readonly modelCapabilities: number;
    readonly integrations: number;
    readonly evalProfiles: number;
  };
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
      return packId.replace(/^aao\./, "").replace(/-/g, "_");
  }
}

function validateAdapterEvidence(raw: unknown, label: string): VerifiedModelAdapter {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      `Invalid model adapter evidence for ${label}: expected object`
    );
  }
  const candidate = raw as Record<string, unknown>;
  const idRes = identifierSchema.max(128).safeParse(candidate.id);
  const verRes = ExactPackVersionSchema.safeParse(candidate.version);
  if (!idRes.success || !verRes.success) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      `Invalid model adapter identity in ${label}`
    );
  }
  if (!Array.isArray(candidate.capabilities)) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      `Model adapter '${idRes.data}@${verRes.data}' is missing capabilities array`
    );
  }

  const seenCaps = new Set<string>();
  const normalizedCaps: Array<{
    readonly capability: string;
    readonly support: "supported" | "unsupported";
  }> = [];

  for (const capEntry of candidate.capabilities) {
    if (!capEntry || typeof capEntry !== "object" || Array.isArray(capEntry)) {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        `Invalid capability declaration on model adapter '${idRes.data}@${verRes.data}'`
      );
    }
    const c = capEntry as Record<string, unknown>;
    if (typeof c.capability !== "string" || c.capability.trim().length === 0) {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        `Model adapter '${idRes.data}@${verRes.data}' has non-string capability name`
      );
    }
    if (c.support !== "supported" && c.support !== "unsupported") {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        `Model adapter '${idRes.data}@${verRes.data}' has invalid support value '${String(c.support)}'`
      );
    }
    if (!SUPPORTED_MODEL_CAPABILITY_SET.has(c.capability)) {
      throw new CapabilityPackError(
        "PACK_CAPABILITY_INCOMPATIBLE",
        `Model adapter '${idRes.data}@${verRes.data}' declares unknown capability '${c.capability}'`
      );
    }
    if (seenCaps.has(c.capability)) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Model adapter '${idRes.data}@${verRes.data}' declares duplicate capability '${c.capability}'`
      );
    }
    seenCaps.add(c.capability);
    normalizedCaps.push({ capability: c.capability, support: c.support });
  }

  return {
    id: idRes.data,
    version: verRes.data,
    capabilities: normalizedCaps,
  };
}

/**
 * Validates preflight compatibility between a Capability Pack and a company's
 * verified registration evidence and workflow context.
 *
 * Fails closed BEFORE workflow execution if any required registration evidence
 * is omitted, malformed, duplicated, or unsatisfied.
 */
export function validatePackCompatibility(
  pack: CapabilityPack,
  context: PackCompatibilityContext
): PackCompatibilityReport {
  if (!pack || typeof pack !== "object" || !pack.manifest) {
    throw new CapabilityPackError("PACK_INVALID_MANIFEST", "Invalid capability pack definition");
  }
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context must be a non-null object"
    );
  }

  const rawContext = context as unknown as Record<string, unknown>;
  if (typeof rawContext.companyId !== "string" || rawContext.companyId.trim().length === 0) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context requires a non-empty companyId"
    );
  }
  if (!Array.isArray(rawContext.enabledProofs)) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context requires enabledProofs array"
    );
  }
  if (!Array.isArray(rawContext.governanceRoles)) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context requires governanceRoles array"
    );
  }
  if (
    !rawContext.integrations ||
    typeof rawContext.integrations !== "object" ||
    Array.isArray(rawContext.integrations)
  ) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context requires integrations object"
    );
  }
  if (
    !rawContext.workflow ||
    typeof rawContext.workflow !== "object" ||
    Array.isArray(rawContext.workflow)
  ) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context requires workflow identity and planFingerprint"
    );
  }

  // Enforce mandatory registration evidence arrays (no optional skip paths)
  if (!Array.isArray(rawContext.registeredTools)) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context requires registeredTools array; missing tool evidence cannot pass compatibility"
    );
  }
  if (!Array.isArray(rawContext.registeredModelPolicies)) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context requires registeredModelPolicies array; missing model policy evidence cannot pass compatibility"
    );
  }
  if (!Array.isArray(rawContext.registeredModelBindings)) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context requires registeredModelBindings array; missing model binding evidence cannot pass compatibility"
    );
  }
  if (
    rawContext.registeredModelAdapters !== undefined &&
    !Array.isArray(rawContext.registeredModelAdapters)
  ) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "registeredModelAdapters must be an array when provided"
    );
  }
  if (!Array.isArray(rawContext.registeredEvalProfiles)) {
    throw new CapabilityPackError(
      "PACK_EVIDENCE_UNAVAILABLE",
      "Compatibility context requires registeredEvalProfiles array; missing evaluation profile evidence cannot pass compatibility"
    );
  }

  const manifest = pack.manifest;

  // 1. Validate Workflow identity and plan fingerprint pinning
  if (
    manifest.workflow.id !== context.workflow.id ||
    manifest.workflow.version !== context.workflow.version
  ) {
    throw new CapabilityPackError(
      "PACK_WORKFLOW_MISMATCH",
      `Pack '${pack.identity}' expects workflow '${manifest.workflow.id}@${manifest.workflow.version}', but context provides '${String(context.workflow.id)}@${String(context.workflow.version)}'`
    );
  }

  if (manifest.workflow.planFingerprint !== context.workflow.planFingerprint) {
    throw new CapabilityPackError(
      "PACK_WORKFLOW_MISMATCH",
      `Pack '${pack.identity}' expects plan fingerprint '${manifest.workflow.planFingerprint}', but prepared workflow has '${String(context.workflow.planFingerprint)}'`
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

  // 3. Validate registeredTools evidence & required Tool references
  const seenToolRefs = new Set<string>();
  const seenToolVersions = new Map<string, string>();
  for (const rawTool of context.registeredTools) {
    const parsedTool = ExactToolRefSchema.safeParse(rawTool);
    if (!parsedTool.success) {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        "registeredTools contains an invalid tool reference; expected exact { id, version }"
      );
    }
    const tool = parsedTool.data;
    const key = `${tool.id}@${tool.version}`;
    if (seenToolRefs.has(key)) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Duplicate tool registration '${key}' in compatibility evidence`
      );
    }
    const existingVersion = seenToolVersions.get(tool.id);
    if (existingVersion !== undefined && existingVersion !== tool.version) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Conflicting tool versions '${tool.id}@${existingVersion}' and '${key}' in compatibility evidence`
      );
    }
    seenToolRefs.add(key);
    seenToolVersions.set(tool.id, tool.version);
  }

  for (const requiredTool of manifest.requirements.toolRefs) {
    const requiredKey = `${requiredTool.id}@${requiredTool.version}`;
    if (!seenToolRefs.has(requiredKey)) {
      throw new CapabilityPackError(
        "PACK_REQUIREMENT_MISSING",
        `Pack '${pack.identity}' requires tool '${requiredKey}', but it is not registered in the host proof environment`
      );
    }
  }

  // 4. Validate registeredModelPolicies evidence & required Model Policy references
  const seenModelPolicies = new Set<string>();
  for (const rawPolicy of context.registeredModelPolicies) {
    const parsedPolicy = identifierSchema.max(128).safeParse(rawPolicy);
    if (!parsedPolicy.success) {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        "registeredModelPolicies contains an invalid policy reference"
      );
    }
    const policy = parsedPolicy.data;
    if (seenModelPolicies.has(policy)) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Duplicate model policy registration '${policy}' in compatibility evidence`
      );
    }
    seenModelPolicies.add(policy);
  }

  for (const requiredPolicy of manifest.requirements.modelPolicyRefs) {
    if (!seenModelPolicies.has(requiredPolicy)) {
      throw new CapabilityPackError(
        "PACK_REQUIREMENT_MISSING",
        `Pack '${pack.identity}' requires model policy '${requiredPolicy}', but it is not registered in the host proof environment`
      );
    }
  }

  // 5. Validate registeredModelAdapters & registeredModelBindings and verify actual model capabilities
  let adaptersByRef: Map<string, VerifiedModelAdapter> | undefined;
  if (context.registeredModelAdapters !== undefined) {
    adaptersByRef = new Map<string, VerifiedModelAdapter>();
    const adapterVersionById = new Map<string, string>();
    for (const rawAdapter of context.registeredModelAdapters) {
      const adapter = validateAdapterEvidence(rawAdapter, "registeredModelAdapters");
      const key = `${adapter.id}@${adapter.version}`;
      if (adaptersByRef.has(key)) {
        throw new CapabilityPackError(
          "PACK_DUPLICATE_REF",
          `Duplicate model adapter registration '${key}' in compatibility evidence`
        );
      }
      const existingVer = adapterVersionById.get(adapter.id);
      if (existingVer !== undefined && existingVer !== adapter.version) {
        throw new CapabilityPackError(
          "PACK_DUPLICATE_REF",
          `Conflicting model adapter versions '${adapter.id}@${existingVer}' and '${key}' in compatibility evidence`
        );
      }
      adaptersByRef.set(key, adapter);
      adapterVersionById.set(adapter.id, adapter.version);
    }
  }

  const seenBindingIds = new Set<string>();
  const verifiedBindingPairs: Array<{
    readonly binding: VerifiedModelBinding;
    readonly adapter: VerifiedModelAdapter;
  }> = [];

  for (const rawBinding of context.registeredModelBindings) {
    if (!rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        "registeredModelBindings contains a non-object entry"
      );
    }
    const candidate = rawBinding as unknown as Record<string, unknown>;
    const idRes = identifierSchema.max(128).safeParse(candidate.id);
    if (!idRes.success) {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        "Model binding in registeredModelBindings requires a valid id"
      );
    }
    if (seenBindingIds.has(idRes.data)) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Duplicate model binding '${idRes.data}' in compatibility evidence`
      );
    }
    seenBindingIds.add(idRes.data);

    if (!Array.isArray(candidate.capabilities)) {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        `Model binding '${idRes.data}' requires a capabilities array`
      );
    }

    const seenBindingCaps = new Set<string>();
    const bindingCaps: string[] = [];
    for (const cap of candidate.capabilities) {
      if (typeof cap !== "string" || cap.trim().length === 0) {
        throw new CapabilityPackError(
          "PACK_EVIDENCE_UNAVAILABLE",
          `Model binding '${idRes.data}' contains an invalid capability value`
        );
      }
      if (!SUPPORTED_MODEL_CAPABILITY_SET.has(cap)) {
        throw new CapabilityPackError(
          "PACK_CAPABILITY_INCOMPATIBLE",
          `Model binding '${idRes.data}' declares unknown model capability '${cap}'`
        );
      }
      if (seenBindingCaps.has(cap)) {
        throw new CapabilityPackError(
          "PACK_DUPLICATE_REF",
          `Model binding '${idRes.data}' declares duplicate capability '${cap}'`
        );
      }
      seenBindingCaps.add(cap);
      bindingCaps.push(cap);
    }

    const adapterRefRes = ExactToolRefSchema.safeParse(candidate.adapterRef);
    if (!adapterRefRes.success) {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        `Model binding '${idRes.data}' requires an exact adapterRef { id, version }`
      );
    }
    const adapterRef = adapterRefRes.data;
    const expectedAdapterKey = `${adapterRef.id}@${adapterRef.version}`;

    let inlineAdapter: VerifiedModelAdapter | undefined;
    if (candidate.adapter !== undefined) {
      inlineAdapter = validateAdapterEvidence(
        candidate.adapter,
        `binding '${idRes.data}'.adapter`
      );
      if (inlineAdapter.id !== adapterRef.id || inlineAdapter.version !== adapterRef.version) {
        throw new CapabilityPackError(
          "PACK_CAPABILITY_INCOMPATIBLE",
          `Model binding '${idRes.data}' references adapter '${expectedAdapterKey}', which does not match attached adapter '${inlineAdapter.id}@${inlineAdapter.version}'`
        );
      }
    }

    let resolvedAdapter: VerifiedModelAdapter | undefined;
    if (adaptersByRef !== undefined) {
      resolvedAdapter = adaptersByRef.get(expectedAdapterKey);
      if (!resolvedAdapter) {
        throw new CapabilityPackError(
          "PACK_CAPABILITY_INCOMPATIBLE",
          `Model binding '${idRes.data}' references adapter '${expectedAdapterKey}', which is not registered in the host environment`
        );
      }
      if (inlineAdapter !== undefined) {
        const inlineSupported = new Set(
          inlineAdapter.capabilities
            .filter((c) => c.support === "supported")
            .map((c) => c.capability)
        );
        const registeredSupported = new Set(
          resolvedAdapter.capabilities
            .filter((c) => c.support === "supported")
            .map((c) => c.capability)
        );
        if (
          inlineSupported.size !== registeredSupported.size ||
          [...inlineSupported].some((c) => !registeredSupported.has(c))
        ) {
          throw new CapabilityPackError(
            "PACK_CAPABILITY_INCOMPATIBLE",
            `Model binding '${idRes.data}' has conflicting adapter capability declarations for '${expectedAdapterKey}'`
          );
        }
      }
    } else {
      if (!inlineAdapter) {
        throw new CapabilityPackError(
          "PACK_CAPABILITY_INCOMPATIBLE",
          `Model binding '${idRes.data}' references adapter '${expectedAdapterKey}', but no adapter registration evidence was provided`
        );
      }
      resolvedAdapter = inlineAdapter;
    }

    // Verify that every capability declared on the binding is supported by its resolved adapter
    for (const cap of bindingCaps) {
      const supportedByAdapter = resolvedAdapter.capabilities.some(
        (c) => c.capability === cap && c.support === "supported"
      );
      if (!supportedByAdapter) {
        throw new CapabilityPackError(
          "PACK_CAPABILITY_INCOMPATIBLE",
          `Model adapter '${resolvedAdapter.id}@${resolvedAdapter.version}' does not support capability '${cap}' declared by binding '${idRes.data}'`
        );
      }
    }

    verifiedBindingPairs.push({
      binding: {
        id: idRes.data,
        capabilities: bindingCaps,
        adapterRef,
        adapter: resolvedAdapter,
      },
      adapter: resolvedAdapter,
    });
  }

  for (const requiredCap of manifest.requirements.modelCapabilities) {
    if (!SUPPORTED_MODEL_CAPABILITY_SET.has(requiredCap)) {
      throw new CapabilityPackError(
        "PACK_CAPABILITY_INCOMPATIBLE",
        `Pack '${pack.identity}' requires unknown model capability '${requiredCap}'`
      );
    }
  }

  if (manifest.requirements.modelCapabilities.length > 0) {
    const satisfiedBySingleBinding = verifiedBindingPairs.some(({ binding, adapter }) =>
      manifest.requirements.modelCapabilities.every(
        (reqCap) =>
          binding.capabilities.includes(reqCap) &&
          adapter.capabilities.some((c) => c.capability === reqCap && c.support === "supported")
      )
    );
    if (!satisfiedBySingleBinding) {
      throw new CapabilityPackError(
        "PACK_CAPABILITY_INCOMPATIBLE",
        `Pack '${pack.identity}' requires model capabilities [${manifest.requirements.modelCapabilities.join(", ")}], but no single registered model binding and adapter pair supports all required capabilities`
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
      const exists = context.governanceRoles.some((r) => r && typeof r === "object" && r.id === roleId);
      if (!exists) {
        throw new CapabilityPackError(
          "PACK_GOVERNANCE_INCOMPATIBLE",
          `Pack '${pack.identity}' requires approver role '${roleId}', but it is not defined in governance for company '${context.companyId}'`
        );
      }
    }
  }

  // 8. Validate Evaluation Profile registration evidence
  const seenEvalProfiles = new Set<string>();
  const seenEvalProfileVersions = new Map<string, string>();
  for (const rawProfileRef of context.registeredEvalProfiles) {
    const parsedProfile = ExactEvalProfileRefSchema.safeParse(rawProfileRef);
    if (!parsedProfile.success) {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        `Invalid evaluation profile reference '${String(rawProfileRef)}' in registeredEvalProfiles`
      );
    }
    const profileRef = parsedProfile.data;
    if (seenEvalProfiles.has(profileRef)) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Duplicate evaluation profile registration '${profileRef}' in compatibility evidence`
      );
    }
    const [profileId, profileVersion] = profileRef.split("@");
    const existingVer = seenEvalProfileVersions.get(profileId!);
    if (existingVer !== undefined && existingVer !== profileVersion) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Conflicting evaluation profile versions '${profileId}@${existingVer}' and '${profileRef}' in compatibility evidence`
      );
    }
    seenEvalProfiles.add(profileRef);
    seenEvalProfileVersions.set(profileId!, profileVersion!);
  }

  if (!seenEvalProfiles.has(manifest.verification.evalProfileRef)) {
    throw new CapabilityPackError(
      "PACK_VERIFICATION_PROFILE_MISSING",
      `Pack '${pack.identity}' requires evaluation profile '${manifest.verification.evalProfileRef}', but it is not registered in the host environment`
    );
  }

  return deepFreeze({
    compatible: true,
    packIdentity: pack.identity,
    companyId: context.companyId,
    workflowId: manifest.workflow.id,
    planFingerprint: manifest.workflow.planFingerprint,
    verifiedRequirements: {
      tools: manifest.requirements.toolRefs.length,
      modelPolicies: manifest.requirements.modelPolicyRefs.length,
      modelCapabilities: manifest.requirements.modelCapabilities.length,
      integrations: manifest.requirements.integrationSlots.length,
      evalProfiles: 1,
    },
  });
}
