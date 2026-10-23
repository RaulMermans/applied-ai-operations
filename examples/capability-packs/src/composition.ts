import {
  type CapabilityPack,
  type CapabilityPackCatalog,
  type CompanyPackSelectionV1,
  type CompanyPackSelectionV1Input,
  type PackCompatibilityReport,
  type ProofRegistrationSnapshot,
  type VerifiedModelAdapter,
  type VerifiedModelBinding,
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
  HostCapabilityCatalog,
} from "@aao/example-company-portability";
import {
  createStandardEvalProfileCatalog,
  verifyEvalProfileRegistration,
  type PackEvalProfileCatalog,
} from "./eval-profiles.js";

/**
 * An activated capability pack bound to a company's guarded execution facade
 * and its verified compatibility report.
 */
export interface ActivatedCompanyPack<TFacade = unknown> {
  readonly pack: CapabilityPack;
  readonly packRef: { readonly id: string; readonly version: string };
  readonly packFingerprint: string;
  readonly workflowPlanFingerprint: string;
  readonly compatibilityReport: PackCompatibilityReport;
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
  /**
   * Optional host capability catalog used to cross-verify model bindings and
   * adapters against the host's registered declarations.
   */
  readonly hostCapabilities?: HostCapabilityCatalog;
  /**
   * Optional evaluation profile catalog (defaults to the canonical standard
   * evaluation profile catalog).
   */
  readonly evalProfileCatalog?: PackEvalProfileCatalog;
}

function buildHostModelEvidence(
  company: ComposedCompanyAAO,
  hostCapabilities: HostCapabilityCatalog
): {
  readonly bindings: ReadonlyArray<VerifiedModelBinding>;
  readonly adapters: ReadonlyArray<VerifiedModelAdapter>;
} {
  const bindings: VerifiedModelBinding[] = [];
  const adaptersMap = new Map<string, VerifiedModelAdapter>();

  for (const bindingRef of company.manifest.models.bindingRefs) {
    const binding = hostCapabilities.getModelBinding(bindingRef);
    if (!binding) {
      throw new CapabilityPackError(
        "PACK_CAPABILITY_INCOMPATIBLE",
        `Model binding '${bindingRef}' configured for company '${company.companyId}' is not registered in the host capability catalog`
      );
    }

    const adapterDef =
      hostCapabilities.getModelAdapter(`${binding.adapterRef.id}@${binding.adapterRef.version}`) ??
      hostCapabilities.getModelAdapter(binding.adapterRef.id);

    let adapterSnapshot: VerifiedModelAdapter | undefined;
    if (adapterDef) {
      adapterSnapshot = Object.freeze({
        id: adapterDef.manifest.id,
        version: adapterDef.manifest.version,
        capabilities: Object.freeze(
          adapterDef.manifest.capabilities.map((c) =>
            Object.freeze({ capability: c.capability, support: c.support })
          )
        ),
      });
      adaptersMap.set(`${adapterSnapshot.id}@${adapterSnapshot.version}`, adapterSnapshot);
    }

    bindings.push(
      Object.freeze({
        id: binding.id,
        capabilities: Object.freeze([...binding.capabilities]),
        adapterRef: Object.freeze({
          id: binding.adapterRef.id,
          version: binding.adapterRef.version,
        }),
        ...(adapterSnapshot &&
        adapterSnapshot.id === binding.adapterRef.id &&
        adapterSnapshot.version === binding.adapterRef.version
          ? { adapter: adapterSnapshot }
          : {}),
      })
    );
  }

  return {
    bindings: Object.freeze(bindings),
    adapters: Object.freeze(Array.from(adaptersMap.values())),
  };
}

/**
 * Resolves and activates a company's selected Capability Packs against its composed AAO environment.
 *
 * Guarantees:
 * 1. Zero workflow duplication: binds directly to the canonical proof workflows.
 * 2. Trusted registration evidence: derives Tool, Model Policy, Model Binding, and Adapter
 *    evidence strictly from the proof's actual construction snapshot (never from static lists
 *    or untrusted caller capability arrays).
 * 3. Verified Evaluation profiles: confirms each pack's `evalProfileRef` resolves to a usable
 *    canonical dataset/definition builder and registered graders before activation.
 * 4. Atomic all-or-nothing selection: if any selected pack fails compatibility, the entire
 *    selection is refused and zero activated packs are returned.
 * 5. Preserves admission enforcement: every guarded facade enforces `requireCompanyAdmission()`.
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

  const evalProfileCatalog = options.evalProfileCatalog ?? createStandardEvalProfileCatalog();
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
      readonly workflow: { readonly id: string; readonly version: string };
      readonly planFingerprint: string;
      readonly registrationSnapshot?: ProofRegistrationSnapshot;
    };

    const snapshot = typedFacade.registrationSnapshot;
    if (!snapshot || typeof snapshot !== "object") {
      throw new CapabilityPackError(
        "PACK_EVIDENCE_UNAVAILABLE",
        `Proof '${proofName}' for company '${company.companyId}' does not provide a trusted registration snapshot`
      );
    }

    // Verify evaluation profile registration in the trusted Eval profile catalog
    verifyEvalProfileRegistration(evalProfileCatalog, pack.manifest.verification.evalProfileRef);
    const registeredEvalProfiles = evalProfileCatalog.listProfileRefs();

    // Primary preflight compatibility check against actual proof registration snapshot
    const compatibilityReport = validatePackCompatibility(pack, {
      companyId: company.companyId,
      enabledProofs: company.enabledProofs,
      governanceRoles: company.manifest.governance.roles,
      integrations: company.manifest.integrations,
      workflow: snapshot.workflow,
      registeredTools: snapshot.tools,
      registeredModelPolicies: snapshot.modelPolicies,
      registeredModelBindings: snapshot.modelBindings,
      registeredModelAdapters: snapshot.modelAdapters,
      registeredEvalProfiles,
    });

    // Optional cross-verification against host capability catalog if supplied
    if (options.hostCapabilities) {
      const hostModels = buildHostModelEvidence(company, options.hostCapabilities);
      validatePackCompatibility(pack, {
        companyId: company.companyId,
        enabledProofs: company.enabledProofs,
        governanceRoles: company.manifest.governance.roles,
        integrations: company.manifest.integrations,
        workflow: snapshot.workflow,
        registeredTools: snapshot.tools,
        registeredModelPolicies: snapshot.modelPolicies,
        registeredModelBindings: hostModels.bindings,
        registeredModelAdapters: hostModels.adapters,
        registeredEvalProfiles,
      });
    }

    const activated: ActivatedCompanyPack = Object.freeze({
      pack,
      packRef: Object.freeze({ id: pack.manifest.id, version: pack.manifest.version }),
      packFingerprint: pack.fingerprint,
      workflowPlanFingerprint: typedFacade.planFingerprint,
      compatibilityReport,
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
