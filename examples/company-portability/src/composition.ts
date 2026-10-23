import {
  validateCompanyManifest,
  CompanyConfigError,
  type CompanyManifestV1,
  type EnabledProof,
} from "@aao/config";
import type {
  AAOApprovals,
  AAOClock,
  ModelAdapterDefinition,
  ModelBindingDefinition,
  ModelPolicySpec,
  PrincipalForRun,
  RuntimeExecutionState,
  RuntimeTracePort,
  ToolDefinition,
  Workflow,
  WorkflowExecutionResult,
} from "@aao/framework";
import { createGovernanceRegistry } from "@aao/governance";
import {
  createCompanyResearchProof,
  type CompanyResearchProof,
  type CompanyResearchRequestInput,
  type CompanyResearchRunOutcome,
  type ProofRegistrationSnapshot,
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
import {
  requireCompanyAdmission,
  type RequireCompanyAdmissionContext,
} from "./admission.js";

export type { ProofRegistrationSnapshot };

export interface ProofRegistrationOverride {
  readonly tools?: readonly ToolDefinition[];
  readonly modelPolicies?: readonly ModelPolicySpec[];
  readonly modelBindings?: readonly ModelBindingDefinition[];
  readonly modelAdapters?: readonly ModelAdapterDefinition[];
  readonly registrationSnapshot?: ProofRegistrationSnapshot;
}

export interface CreateCompanyAAOOptions {
  /** The company manifest (validated or raw). */
  readonly manifest: CompanyManifestV1 | unknown;
  /** The host's trusted capability catalog. */
  readonly hostCapabilities: HostCapabilityCatalog;
  /** The host-attested principal resolver for this company's runs. */
  readonly principalForRun: PrincipalForRun;
  readonly trace?: RuntimeTracePort;
  readonly clock?: AAOClock;
  /**
   * Optional per-proof registration overrides for testing actual proof registration
   * changes (e.g. missing tools, missing model policies, or altered model bindings).
   */
  readonly proofRegistrations?: {
    readonly company_research?: ProofRegistrationOverride;
    readonly document_intelligence?: ProofRegistrationOverride;
    readonly operational_request?: ProofRegistrationOverride;
  };
}

/**
 * Narrow, guarded execution facade for Company Research.
 * Enforces company-level admission before any workflow run begins.
 */
export interface CompanyResearchFacade {
  readonly workflow: Workflow;
  readonly planFingerprint: string;
  readonly registrationSnapshot: ProofRegistrationSnapshot;
  run(input: {
    runId: string;
    request: CompanyResearchRequestInput;
  }): Promise<CompanyResearchRunOutcome>;
}

/**
 * Narrow, guarded execution facade for Document Intelligence.
 * Enforces company-level admission before any workflow run begins.
 */
export interface DocumentIntelligenceFacade {
  readonly workflow: Workflow;
  readonly planFingerprint: string;
  readonly registrationSnapshot: ProofRegistrationSnapshot;
  run(input: {
    runId: string;
    request: DocumentIntelligenceRequestInput;
  }): Promise<DocumentIntelligenceRunOutcome>;
}

/**
 * Narrow, guarded execution facade for Operational Request.
 * Enforces company-level admission before intake or continuation begins.
 * Exposes canonical human approval operations without unguarded workflow preparation.
 */
export interface OperationalRequestFacade {
  readonly workflow: Workflow;
  readonly planFingerprint: string;
  readonly registrationSnapshot: ProofRegistrationSnapshot;
  readonly approvals: AAOApprovals;
  execute(input: {
    runId: string;
    request: OperationalRequestInput;
  }): Promise<WorkflowExecutionResult>;
  continue(execution: RuntimeExecutionState): Promise<WorkflowExecutionResult>;
}

export interface ComposedCompanyAAO {
  readonly companyId: string;
  readonly displayName: string;
  readonly configFingerprint: string;
  readonly manifest: Readonly<CompanyManifestV1>;
  readonly enabledProofs: ReadonlyArray<EnabledProof>;

  getCompanyResearchProof(): CompanyResearchFacade;
  getDocumentIntelligenceProof(): DocumentIntelligenceFacade;
  getOperationalRequestProof(): OperationalRequestFacade;

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
 * 6. Deterministic company-level admission check backed by canonical Governance precedes any workflow execution.
 * 7. Guarded facades prevent getter bypass of admission boundaries.
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

  // 2. Compile canonical Governance registry for admission gating
  const governanceRegistry = createGovernanceRegistry(manifest.governance);
  const admissionContext: RequireCompanyAdmissionContext = Object.freeze({
    companyId: manifest.companyId,
    governanceRegistry,
    principalForRun: options.principalForRun,
  });

  // 3. Resolve model bindings and adapters
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

    const adapterDef =
      options.hostCapabilities.getModelAdapter(`${binding.adapterRef.id}@${binding.adapterRef.version}`) ??
      options.hostCapabilities.getModelAdapter(binding.adapterRef.id);
    if (
      !adapterDef ||
      adapterDef.manifest.id !== binding.adapterRef.id ||
      adapterDef.manifest.version !== binding.adapterRef.version
    ) {
      throw new CompanyConfigError(
        "CONFIG_CAPABILITY_NOT_FOUND",
        `Model adapter '${binding.adapterRef.id}@${binding.adapterRef.version}' referenced by binding '${bindingRef}' is not registered in the host capability catalog`
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

  // 4. Resolve integration providers for enabled proofs
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

    const crOverrides = options.proofRegistrations?.company_research;
    companyResearchProof = createCompanyResearchProof({
      modelAdapters: crOverrides?.modelAdapters ?? resolvedModelAdapters,
      modelBindings: crOverrides?.modelBindings ?? resolvedModelBindings,
      researchProvider,
      governance: manifest.governance,
      principalForRun: options.principalForRun,
      ...(crOverrides?.tools !== undefined ? { tools: crOverrides.tools } : {}),
      ...(crOverrides?.modelPolicies !== undefined ? { modelPolicies: crOverrides.modelPolicies } : {}),
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

    const diOverrides = options.proofRegistrations?.document_intelligence;
    documentIntelligenceProof = createDocumentIntelligenceProof({
      modelAdapters: diOverrides?.modelAdapters ?? resolvedModelAdapters,
      modelBindings: diOverrides?.modelBindings ?? resolvedModelBindings,
      documentSourceProvider,
      governance: manifest.governance,
      principalForRun: options.principalForRun,
      ...(diOverrides?.tools !== undefined ? { tools: diOverrides.tools } : {}),
      ...(diOverrides?.modelPolicies !== undefined ? { modelPolicies: diOverrides.modelPolicies } : {}),
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

    const orOverrides = options.proofRegistrations?.operational_request;
    operationalRequestProof = createOperationalRequestProof({
      modelAdapters: orOverrides?.modelAdapters ?? resolvedModelAdapters,
      modelBindings: orOverrides?.modelBindings ?? resolvedModelBindings,
      draftRepository,
      governance: manifest.governance,
      principalForRun: options.principalForRun,
      ...(orOverrides?.tools !== undefined ? { tools: orOverrides.tools } : {}),
      ...(orOverrides?.modelPolicies !== undefined ? { modelPolicies: orOverrides.modelPolicies } : {}),
      ...(options.trace ? { trace: options.trace } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(manifest.reliability?.operational_request
        ? { reliability: manifest.reliability.operational_request }
        : {}),
    });
  }

  // 5. Construct guarded proof facades preventing getter bypass
  const companyResearchFacade: CompanyResearchFacade | undefined = companyResearchProof
    ? Object.freeze({
        workflow: companyResearchProof.workflow,
        planFingerprint: companyResearchProof.planFingerprint,
        registrationSnapshot:
          options.proofRegistrations?.company_research?.registrationSnapshot ??
          companyResearchProof.registrationSnapshot,
        async run(input: {
          runId: string;
          request: CompanyResearchRequestInput;
        }): Promise<CompanyResearchRunOutcome> {
          requireCompanyAdmission(admissionContext, input.runId, "company_research");
          return companyResearchProof!.run(input);
        },
      })
    : undefined;

  const documentIntelligenceFacade: DocumentIntelligenceFacade | undefined =
    documentIntelligenceProof
      ? Object.freeze({
          workflow: documentIntelligenceProof.workflow,
          planFingerprint: documentIntelligenceProof.planFingerprint,
          registrationSnapshot:
            options.proofRegistrations?.document_intelligence?.registrationSnapshot ??
            documentIntelligenceProof.registrationSnapshot,
          async run(input: {
            runId: string;
            request: DocumentIntelligenceRequestInput;
          }): Promise<DocumentIntelligenceRunOutcome> {
            requireCompanyAdmission(admissionContext, input.runId, "document_intelligence");
            return documentIntelligenceProof!.run(input);
          },
        })
      : undefined;

  const operationalRequestFacade: OperationalRequestFacade | undefined =
    operationalRequestProof
      ? Object.freeze({
          workflow: operationalRequestProof.workflow,
          planFingerprint: operationalRequestProof.planFingerprint,
          registrationSnapshot:
            options.proofRegistrations?.operational_request?.registrationSnapshot ??
            operationalRequestProof.registrationSnapshot,
          approvals: operationalRequestProof.approvals,
          async execute(input: {
            runId: string;
            request: OperationalRequestInput;
          }): Promise<WorkflowExecutionResult> {
            requireCompanyAdmission(admissionContext, input.runId, "operational_request");
            return operationalRequestProof!.execute(input);
          },
          async continue(execution: RuntimeExecutionState): Promise<WorkflowExecutionResult> {
            requireCompanyAdmission(
              admissionContext,
              execution?.run?.runId,
              "operational_request"
            );
            return operationalRequestProof!.continue(execution);
          },
        })
      : undefined;

  return Object.freeze({
    companyId: manifest.companyId,
    displayName: manifest.displayName,
    configFingerprint,
    manifest,
    enabledProofs: manifest.enabledProofs,

    getCompanyResearchProof(): CompanyResearchFacade {
      if (!companyResearchFacade) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'company_research' is disabled for company '${manifest.companyId}'`
        );
      }
      return companyResearchFacade;
    },

    getDocumentIntelligenceProof(): DocumentIntelligenceFacade {
      if (!documentIntelligenceFacade) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'document_intelligence' is disabled for company '${manifest.companyId}'`
        );
      }
      return documentIntelligenceFacade;
    },

    getOperationalRequestProof(): OperationalRequestFacade {
      if (!operationalRequestFacade) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'operational_request' is disabled for company '${manifest.companyId}'`
        );
      }
      return operationalRequestFacade;
    },

    async runCompanyResearch(input: {
      runId: string;
      request: CompanyResearchRequestInput;
    }): Promise<CompanyResearchRunOutcome> {
      if (!companyResearchProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'company_research' is disabled for company '${manifest.companyId}'`
        );
      }
      requireCompanyAdmission(admissionContext, input.runId, "company_research");
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
    }): Promise<DocumentIntelligenceRunOutcome> {
      if (!documentIntelligenceProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'document_intelligence' is disabled for company '${manifest.companyId}'`
        );
      }
      requireCompanyAdmission(admissionContext, input.runId, "document_intelligence");
      return documentIntelligenceProof.run(input);
    },

    async executeOperationalRequest(input: {
      runId: string;
      request: OperationalRequestInput;
    }): Promise<WorkflowExecutionResult> {
      if (!operationalRequestProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'operational_request' is disabled for company '${manifest.companyId}'`
        );
      }
      requireCompanyAdmission(admissionContext, input.runId, "operational_request");
      return operationalRequestProof.execute(input);
    },

    async continueOperationalRequest(
      execution: RuntimeExecutionState
    ): Promise<WorkflowExecutionResult> {
      if (!operationalRequestProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'operational_request' is disabled for company '${manifest.companyId}'`
        );
      }
      requireCompanyAdmission(
        admissionContext,
        execution?.run?.runId,
        "operational_request"
      );
      return operationalRequestProof.continue(execution);
    },
  });
}
