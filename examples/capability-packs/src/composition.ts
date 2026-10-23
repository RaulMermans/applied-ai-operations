import {
  type CapabilityPack,
  type CapabilityPackCatalog,
  type CompanyPackSelectionV1,
  type CompanyPackSelectionV1Input,
  CapabilityPackError,
  packRefKey,
  validateCompanyPackSelection,
  validatePackCompatibility,
  getRequiredProofName,
} from "@aao/capability-packs";
import type { EnabledProof } from "@aao/config";
import type {
  ComposedCompanyAAO,
  CompanyResearchFacade,
  DocumentIntelligenceFacade,
  OperationalRequestFacade,
} from "@aao/example-company-portability";

/**
 * Known tools and policies provided by the flagship proof execution environments.
 */
export const STANDARD_PROOF_TOOLS = Object.freeze([
  { id: "public_web.search", version: "1.0.0" },
  { id: "records.dedupe", version: "1.0.0" },
  { id: "public_web.fetch_pages", version: "1.0.0" },
  { id: "records.project", version: "1.0.0" },
  { id: "document.extract_text", version: "1.0.0" },
  { id: "operations.create_change_draft", version: "1.0.0" },
]);

export const STANDARD_MODEL_POLICIES = Object.freeze([
  "company_research.planning",
  "company_research.synthesis",
  "document_intelligence.synthesis",
  "operational_request.interpret",
]);

/**
 * An activated capability pack bound to a company's guarded execution facade.
 */
export interface ActivatedCompanyPack<TFacade = unknown> {
  readonly pack: CapabilityPack;
  readonly packRef: { readonly id: string; readonly version: string };
  readonly packFingerprint: string;
  readonly workflowPlanFingerprint: string;
  readonly facade: TFacade;
}

export interface ActivatedCompanyPacks {
  readonly companyId: string;
  readonly configFingerprint: string;
  readonly selection: Readonly<CompanyPackSelectionV1>;
  getPack<T = unknown>(ref: { id: string; version: string } | string): ActivatedCompanyPack<T>;
  listPacks(): ReadonlyArray<ActivatedCompanyPack>;
}

export interface ResolveCompanyCapabilityPacksOptions {
  /** The composed company AAO runtime environment. */
  readonly company: ComposedCompanyAAO;
  /** The Capability Pack catalog. */
  readonly catalog: CapabilityPackCatalog;
  /** The company's pack selection contract. */
  readonly selection: CompanyPackSelectionV1 | CompanyPackSelectionV1Input | unknown;
  /** Optional override for available tools (defaults to STANDARD_PROOF_TOOLS). */
  readonly availableTools?: ReadonlyArray<{ id: string; version: string }>;
  /** Optional override for available model policies (defaults to STANDARD_MODEL_POLICIES). */
  readonly availableModelPolicies?: ReadonlyArray<string>;
}

/**
 * Resolves and activates a company's selected Capability Packs against its composed AAO environment.
 *
 * Guarantees:
 * 1. Zero workflow duplication: binds directly to the canonical proof workflows.
 * 2. Strict preflight compatibility validation before exposing any executable facade.
 * 3. Enforces company enablement: disabled proofs are rejected immediately with PACK_PROOF_DISABLED.
 * 4. Pinned workflow attestation: verifies the prepared workflow plan fingerprint matches the pack manifest.
 * 5. Preserves admission enforcement: every guarded facade enforces requireCompanyAdmission().
 * 6. Pack metadata does NOT grant authority: execution remains strictly governed.
 */
export function resolveCompanyCapabilityPacks(
  options: ResolveCompanyCapabilityPacksOptions
): ActivatedCompanyPacks {
  const selection = validateCompanyPackSelection(options.selection);
  const company = options.company;

  if (selection.companyId !== company.companyId) {
    throw new CapabilityPackError(
      "PACK_SCOPE_MISMATCH",
      `Pack selection companyId '${selection.companyId}' does not match composed companyId '${company.companyId}'`
    );
  }

  const availableTools = options.availableTools ?? STANDARD_PROOF_TOOLS;
  const availableModelPolicies = options.availableModelPolicies ?? STANDARD_MODEL_POLICIES;

  const activatedMap = new Map<string, ActivatedCompanyPack>();

  for (const ref of selection.packRefs) {
    const pack = options.catalog.getCapabilityPack(ref);
    if (!pack) {
      throw new CapabilityPackError(
        "PACK_NOT_FOUND",
        `Capability pack '${ref.id}@${ref.version}' not found in catalog`
      );
    }

    const proofName = getRequiredProofName(pack.manifest.id);

    // Check company enabledProofs
    if (!company.enabledProofs.includes(proofName as EnabledProof)) {
      throw new CapabilityPackError(
        "PACK_PROOF_DISABLED",
        `Proof '${proofName}' required by pack '${pack.identity}' is disabled for company '${company.companyId}'`
      );
    }

    // Retrieve guarded facade
    let facade: unknown;
    switch (proofName) {
      case "company_research":
        facade = company.getCompanyResearchProof();
        break;
      case "document_intelligence":
        facade = company.getDocumentIntelligenceProof();
        break;
      case "operational_request":
        facade = company.getOperationalRequestProof();
        break;
      default:
        throw new CapabilityPackError(
          "PACK_NOT_FOUND",
          `No proof implementation available for pack '${pack.identity}'`
        );
    }

    const typedFacade = facade as {
      workflow: { id: string; version: string };
      planFingerprint: string;
    };

    // Preflight compatibility check
    validatePackCompatibility(pack, {
      companyId: company.companyId,
      enabledProofs: company.enabledProofs,
      governanceRoles: company.manifest.governance.roles,
      modelBindings: company.manifest.models.bindingRefs.map((id) => ({
        id,
        capabilities: ["model.structured_output"],
      })),
      integrations: company.manifest.integrations,
      workflow: {
        id: typedFacade.workflow.id,
        version: typedFacade.workflow.version,
        planFingerprint: typedFacade.planFingerprint,
      },
      availableTools,
      availableModelPolicies,
    });

    const activated: ActivatedCompanyPack = Object.freeze({
      pack,
      packRef: Object.freeze({ id: pack.manifest.id, version: pack.manifest.version }),
      packFingerprint: pack.fingerprint,
      workflowPlanFingerprint: typedFacade.planFingerprint,
      facade,
    });

    activatedMap.set(pack.identity, activated);
  }

  const result: ActivatedCompanyPacks = {
    companyId: company.companyId,
    configFingerprint: company.configFingerprint,
    selection,
    getPack<T = unknown>(ref: { id: string; version: string } | string): ActivatedCompanyPack<T> {
      const key = typeof ref === "string" ? ref : packRefKey(ref);
      const hit = activatedMap.get(key);
      if (!hit) {
        throw new CapabilityPackError(
          "PACK_NOT_FOUND",
          `Activated capability pack '${key}' not found for company '${company.companyId}'`
        );
      }
      return hit as ActivatedCompanyPack<T>;
    },
    listPacks(): ReadonlyArray<ActivatedCompanyPack> {
      return Object.freeze(Array.from(activatedMap.values()));
    },
  };

  return Object.freeze(result);
}

export type {
  CompanyResearchFacade,
  DocumentIntelligenceFacade,
  OperationalRequestFacade,
};

