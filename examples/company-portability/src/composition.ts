import {
  validateCompanyManifest,
  CompanyConfigError,
  type CompanyManifestV1,
  type EnabledProof,
} from "@aao/config";
import type {
  AAOClock,
  ModelAdapterDefinition,
  ModelBindingDefinition,
  PrincipalForRun,
  RuntimeExecutionState,
  RuntimeTracePort,
  WorkflowExecutionResult,
} from "@aao/framework";
import {
  createCompanyResearchProof,
  type CompanyResearchProof,
  type CompanyResearchRequestInput,
  type CompanyResearchRunOutcome,
} from "@aao/example-company-research";
import {
  createDocumentIntelligenceProof,
  type DocumentIntelligenceProof,
  type DocumentIntelligenceRequestInput,
  type DocumentIntelligenceRunOutcome,
} from "@aao/example-document-intelligence";
import {
  createOperationalRequestProof,
  type OperationalRequestProof,
  type OperationalRequestInput,
} from "@aao/example-operational-request";
import type { HostCapabilityCatalog } from "./catalog.js";

export interface CreateCompanyAAOOptions {
  /** The company manifest (validated or raw). */
  readonly manifest: CompanyManifestV1 | unknown;
  /** The host's trusted capability catalog. */
  readonly hostCapabilities: HostCapabilityCatalog;
  /** The host-attested principal resolver for this company's runs. */
  readonly principalForRun: PrincipalForRun;
  readonly trace?: RuntimeTracePort;
  readonly clock?: AAOClock;
}

export interface ComposedCompanyAAO {
  readonly companyId: string;
  readonly displayName: string;
  readonly configFingerprint: string;
  readonly manifest: Readonly<CompanyManifestV1>;
  readonly enabledProofs: ReadonlyArray<EnabledProof>;

  getCompanyResearchProof(): CompanyResearchProof;
  getDocumentIntelligenceProof(): DocumentIntelligenceProof;
  getOperationalRequestProof(): OperationalRequestProof;

  runCompanyResearch(input: {
    runId: string;
    request: CompanyResearchRequestInput;
  }): Promise<CompanyResearchRunOutcome>;

  runDocumentIntelligence(input: {
    runId: string;
    request: DocumentIntelligenceRequestInput;
  }): Promise<DocumentIntelligenceRunOutcome>;

  executeOperationalRequest(input: {
    runId: string;
    request: OperationalRequestInput;
  }): Promise<WorkflowExecutionResult>;

  continueOperationalRequest(
    execution: RuntimeExecutionState
  ): Promise<WorkflowExecutionResult>;
}

/**
 * Deterministically composes a company-specific AAO execution environment
 * from a validated company configuration manifest and trusted host-supplied capabilities.
 *
 * Core Guarantees:
 * 1. Zero AAO Core modifications or runtime copies.
 * 2. Zero Workflow definition duplication or forking.
 * 3. Exact capability reference resolution from host catalog; no dynamic loading.
 * 4. Company-scoped Governance, Tool Registries, Model Bindings, and Approval isolation.
 * 5. Preflight validation fails fast before any tool, provider, or model execution.
 */
export function createCompanyAAO(options: CreateCompanyAAOOptions): ComposedCompanyAAO {
  if (typeof options.principalForRun !== "function") {
    throw new CompanyConfigError(
      "CONFIG_SCOPE_MISMATCH",
      "createCompanyAAO requires a trusted host principalForRun function"
    );
  }

  // 1. Strict preflight validation and fingerprinting
  const { manifest, configFingerprint } = validateCompanyManifest(options.manifest);

  // 2. Resolve model bindings and adapters
  const resolvedBindings: ModelBindingDefinition[] = [];
  const resolvedAdaptersMap = new Map<string, ModelAdapterDefinition>();

  for (const bindingRef of manifest.models.bindingRefs) {
    const binding = options.hostCapabilities.getModelBinding(bindingRef);
    if (!binding) {
      throw new CompanyConfigError(
        "CONFIG_CAPABILITY_NOT_FOUND",
        `Model binding '${bindingRef}' is not registered in the host capability catalog`
      );
    }

    if (!binding.capabilities.includes("model.structured_output")) {
      throw new CompanyConfigError(
        "CONFIG_CAPABILITY_INCOMPATIBLE",
        `Model binding '${bindingRef}' lacks required capability 'model.structured_output'`
      );
    }

    const adapterDef = options.hostCapabilities.getModelAdapter(binding.adapterRef.id);
    if (!adapterDef) {
      throw new CompanyConfigError(
        "CONFIG_CAPABILITY_NOT_FOUND",
        `Model adapter '${binding.adapterRef.id}' referenced by binding '${bindingRef}' is not registered in the host capability catalog`
      );
    }

    const supportsStructuredOutput = adapterDef.manifest.capabilities.some(
      (c) => c.capability === "model.structured_output" && c.support === "supported"
    );
    if (!supportsStructuredOutput) {
      throw new CompanyConfigError(
        "CONFIG_CAPABILITY_INCOMPATIBLE",
        `Model adapter '${binding.adapterRef.id}' does not support required capability 'model.structured_output'`
      );
    }

    resolvedBindings.push(binding);
    resolvedAdaptersMap.set(adapterDef.manifest.id, adapterDef);
  }

  const resolvedModelAdapters = Object.freeze(Array.from(resolvedAdaptersMap.values()));
  const resolvedModelBindings = Object.freeze(resolvedBindings);

  // 3. Resolve integration providers for enabled proofs
  const enabledSet = new Set(manifest.enabledProofs);

  let companyResearchProof: CompanyResearchProof | undefined;
  if (enabledSet.has("company_research")) {
    const providerRef = manifest.integrations.publicWebProviderRef!;
    const researchProvider = options.hostCapabilities.getPublicWebProvider(providerRef);
    if (!researchProvider) {
      throw new CompanyConfigError(
        "CONFIG_CAPABILITY_NOT_FOUND",
        `Public-web provider '${providerRef}' is not registered in the host capability catalog`
      );
    }

    companyResearchProof = createCompanyResearchProof({
      modelAdapters: resolvedModelAdapters,
      modelBindings: resolvedModelBindings,
      researchProvider,
      governance: manifest.governance,
      principalForRun: options.principalForRun,
      ...(options.trace ? { trace: options.trace } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(manifest.reliability?.company_research
        ? { reliability: manifest.reliability.company_research }
        : {}),
    });
  }

  let documentIntelligenceProof: DocumentIntelligenceProof | undefined;
  if (enabledSet.has("document_intelligence")) {
    const providerRef = manifest.integrations.documentSourceProviderRef!;
    const documentSourceProvider = options.hostCapabilities.getDocumentSourceProvider(providerRef);
    if (!documentSourceProvider) {
      throw new CompanyConfigError(
        "CONFIG_CAPABILITY_NOT_FOUND",
        `Document-source provider '${providerRef}' is not registered in the host capability catalog`
      );
    }

    documentIntelligenceProof = createDocumentIntelligenceProof({
      modelAdapters: resolvedModelAdapters,
      modelBindings: resolvedModelBindings,
      documentSourceProvider,
      governance: manifest.governance,
      principalForRun: options.principalForRun,
      ...(options.trace ? { trace: options.trace } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(manifest.reliability?.document_intelligence
        ? { reliability: manifest.reliability.document_intelligence }
        : {}),
    });
  }

  let operationalRequestProof: OperationalRequestProof | undefined;
  if (enabledSet.has("operational_request")) {
    const repoRef = manifest.integrations.draftRepositoryRef!;
    const draftRepository = options.hostCapabilities.getDraftRepository(repoRef);
    if (!draftRepository) {
      throw new CompanyConfigError(
        "CONFIG_CAPABILITY_NOT_FOUND",
        `Draft repository '${repoRef}' is not registered in the host capability catalog`
      );
    }

    operationalRequestProof = createOperationalRequestProof({
      modelAdapters: resolvedModelAdapters,
      modelBindings: resolvedModelBindings,
      draftRepository,
      governance: manifest.governance,
      principalForRun: options.principalForRun,
      ...(options.trace ? { trace: options.trace } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(manifest.reliability?.operational_request
        ? { reliability: manifest.reliability.operational_request }
        : {}),
    });
  }

  return Object.freeze({
    companyId: manifest.companyId,
    displayName: manifest.displayName,
    configFingerprint,
    manifest,
    enabledProofs: manifest.enabledProofs,

    getCompanyResearchProof() {
      if (!companyResearchProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'company_research' is disabled for company '${manifest.companyId}'`
        );
      }
      return companyResearchProof;
    },

    getDocumentIntelligenceProof() {
      if (!documentIntelligenceProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'document_intelligence' is disabled for company '${manifest.companyId}'`
        );
      }
      return documentIntelligenceProof;
    },

    getOperationalRequestProof() {
      if (!operationalRequestProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'operational_request' is disabled for company '${manifest.companyId}'`
        );
      }
      return operationalRequestProof;
    },

    async runCompanyResearch(input: {
      runId: string;
      request: CompanyResearchRequestInput;
    }) {
      if (!companyResearchProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'company_research' is disabled for company '${manifest.companyId}'`
        );
      }
      const canonicalRequest = {
        schemaVersion: 1 as const,
        company: input.request.company,
        questions: input.request.questions,
      };
      return companyResearchProof.run({ runId: input.runId, request: canonicalRequest });
    },

    async runDocumentIntelligence(input: {
      runId: string;
      request: DocumentIntelligenceRequestInput;
    }) {
      if (!documentIntelligenceProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'document_intelligence' is disabled for company '${manifest.companyId}'`
        );
      }
      return documentIntelligenceProof.run(input);
    },

    async executeOperationalRequest(input: {
      runId: string;
      request: OperationalRequestInput;
    }) {
      if (!operationalRequestProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'operational_request' is disabled for company '${manifest.companyId}'`
        );
      }
      return operationalRequestProof.execute(input);
    },

    async continueOperationalRequest(execution: RuntimeExecutionState) {
      if (!operationalRequestProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'operational_request' is disabled for company '${manifest.companyId}'`
        );
      }
      return operationalRequestProof.continue(execution);
    },
  });
}
