import {
  validateCompanyManifest,
  CompanyConfigError,
  type CompanyManifestV1,
  type EnabledProof,
} from "@aao/config";
import { createHash } from "node:crypto";
import { ApprovalError } from "@aao/approval";
import { JsonValueSchema, canonicalJsonStringify, type ApprovalRecord, type AuditPort, type JsonValue, type Principal } from "@aao/contracts";
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
  CompanyAdmissionError,
  requireCompanyAdmission,
  type RequireCompanyAdmissionContext,
} from "./admission.js";
import type { AttestedActor, RunBindingStore, TrustedHostIdentity } from "./run-binding.js";

export type { ProofRegistrationSnapshot };

export interface ProofRegistrationOverride {
  readonly tools?: readonly ToolDefinition[];
  readonly modelPolicies?: readonly ModelPolicySpec[];
  readonly modelBindings?: readonly ModelBindingDefinition[];
  readonly modelAdapters?: readonly ModelAdapterDefinition[];
}

export interface CreateCompanyAAOOptions {
  /** The company manifest (validated or raw). */
  readonly manifest: CompanyManifestV1 | unknown;
  /** The host's trusted capability catalog. */
  readonly hostCapabilities: HostCapabilityCatalog;
  /**
   * Demonstration identity mode: a host resolver from Run ID to principal.
   * Whatever it reads, the Run ID is caller-chosen, so this mode is only as
   * trustworthy as the host function. Exactly one of `principalForRun` or
   * `trustedIdentity` is required.
   */
  readonly principalForRun?: PrincipalForRun;
  /**
   * Hardened identity mode (ADR-034): every entry point takes a host-minted
   * `AttestedActor`, binds it to the Run once in `runBindings`, and all later
   * identity (Tool Authorization, Approval requester) reads that binding.
   * Share one `runBindings` store across companies so Run IDs cannot collide.
   */
  readonly trustedIdentity?: {
    readonly identity: TrustedHostIdentity;
    readonly runBindings: RunBindingStore;
  };
  readonly trace?: RuntimeTracePort;
  /** Emit-only Audit port for the Operational Request proof's canonical Approval and Tool access events. */
  readonly audit?: AuditPort;
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
    actor?: AttestedActor;
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
    actor?: AttestedActor;
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
  readonly approvals: CompanyApprovals;
  execute(input: {
    runId: string;
    request: OperationalRequestInput;
    actor?: AttestedActor;
  }): Promise<WorkflowExecutionResult>;
  /** In hardened mode `actor` is required and `execution` must be exactly the state this facade returned at the wait. */
  continue(execution: RuntimeExecutionState, actor?: AttestedActor): Promise<WorkflowExecutionResult>;
}

/**
 * The canonical Approval facade. In hardened identity mode the approver must
 * be a host-minted `AttestedActor`; a bare `Principal` (a caller-controlled
 * `resolvedBy`) is refused with `APPROVAL_IDENTITY_ATTESTATION_REQUIRED`.
 */
export interface CompanyApprovals {
  get(approvalId: string): ApprovalRecord | undefined;
  approve(approvalId: string, approver: Principal | AttestedActor): ApprovalRecord;
  reject(approvalId: string, approver: Principal | AttestedActor): ApprovalRecord;
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
    actor?: AttestedActor;
  }): Promise<CompanyResearchRunOutcome>;

  runDocumentIntelligence(input: {
    runId: string;
    request: DocumentIntelligenceRequestInput;
    actor?: AttestedActor;
  }): Promise<DocumentIntelligenceRunOutcome>;

  executeOperationalRequest(input: {
    runId: string;
    request: OperationalRequestInput;
    actor?: AttestedActor;
  }): Promise<WorkflowExecutionResult>;

  continueOperationalRequest(
    execution: RuntimeExecutionState,
    actor?: AttestedActor
  ): Promise<WorkflowExecutionResult>;
}

/** SHA-256 of the canonical JSON execution. Throws on non-JSON state: JSON.stringify would silently drop it. */
function executionDigest(execution: RuntimeExecutionState): string {
  if (!JsonValueSchema.safeParse(execution).success) throw new Error("CONTINUATION_STATE_NOT_JSON");
  return createHash("sha256").update(canonicalJsonStringify(execution as unknown as JsonValue), "utf8").digest("hex");
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
  const trusted = options.trustedIdentity;
  const hasResolver = typeof options.principalForRun === "function";
  const hasTrusted =
    trusted !== undefined &&
    typeof trusted.identity?.resolve === "function" &&
    typeof trusted.runBindings?.claim === "function";
  // Exactly one identity source: no fallback from one mode to the other.
  if (hasResolver === hasTrusted || (trusted !== undefined && !hasTrusted)) {
    throw new CompanyConfigError(
      "CONFIG_SCOPE_MISMATCH",
      "createCompanyAAO requires exactly one trusted identity source: principalForRun or trustedIdentity"
    );
  }

  // 1. Strict preflight validation and fingerprinting
  const { manifest, configFingerprint } = validateCompanyManifest(options.manifest);

  // In hardened mode the only identity source after admission is the immutable Run binding.
  const principalForRun: PrincipalForRun = hasTrusted
    ? ({ runId }) => {
        const binding = trusted!.runBindings.get(runId);
        if (!binding || binding.companyId !== manifest.companyId) throw new Error("RUN_BINDING_MISSING");
        return { id: binding.principal.id, type: binding.principal.type };
      }
    : options.principalForRun!;

  // 2. Compile canonical Governance registry for admission gating
  const governanceRegistry = createGovernanceRegistry(manifest.governance);
  const admissionContext: RequireCompanyAdmissionContext = Object.freeze({
    companyId: manifest.companyId,
    governanceRegistry,
    principalForRun,
  });
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const deny = (proof: EnabledProof, runId: unknown, reasonCode: string): never => {
    throw new CompanyAdmissionError({
      companyId: manifest.companyId,
      proof,
      runId: typeof runId === "string" ? runId : "",
      reasonCode,
    });
  };
  const attestedPrincipal = (proof: EnabledProof, runId: unknown, actor: unknown): Principal => {
    const principal = trusted!.identity.resolve(actor);
    return principal ?? deny(proof, runId, "IDENTITY_ATTESTATION_REQUIRED");
  };

  /**
   * Pre-execution admission. Hardened mode: attested actor → canonical
   * Governance admission → atomic Run binding claim, all before any node runs.
   */
  const admit = (runId: string, proof: EnabledProof, actor: unknown, workflowFingerprint: string): void => {
    if (!hasTrusted) {
      if (actor !== undefined) deny(proof, runId, "IDENTITY_MODE_MISMATCH");
      requireCompanyAdmission(admissionContext, runId, proof);
      return;
    }
    const principal = attestedPrincipal(proof, runId, actor);
    requireCompanyAdmission({ ...admissionContext, principalForRun: () => principal }, runId, proof);
    const claim = trusted!.runBindings.claim({
      schemaVersion: 1,
      runId,
      companyId: manifest.companyId,
      principal,
      proofRef: proof,
      configurationFingerprint: configFingerprint,
      workflowFingerprint,
      createdAt: clock.now(),
    });
    if (!claim.ok) deny(proof, runId, claim.code);
  };

  /** Records the exact waiting execution so continuation can only resume that state. */
  const recordWait = (result: WorkflowExecutionResult): WorkflowExecutionResult => {
    const execution = result.execution;
    const wait = execution?.wait;
    if (hasTrusted && execution && wait?.kind === "approval" && execution.run.status === "WAITING_FOR_APPROVAL") {
      // A conflicting re-record leaves the first digest in place, so continuation of the new state fails closed.
      trusted!.runBindings.recordWaitpoint(execution.run.runId, wait.referenceId, executionDigest(execution));
    }
    return result;
  };

  /**
   * Continuation admission. Hardened mode verifies, in order: attested actor,
   * canonical admission, the immutable binding (company, proof, config and
   * Workflow fingerprints), and that `execution` is byte-for-byte the state
   * recorded at the wait. Only then may the proof verify Approval and attest origin.
   */
  const admitContinuation = (execution: RuntimeExecutionState, actor: unknown, workflowFingerprint: string): void => {
    const runId = execution?.run?.runId;
    if (!hasTrusted) {
      if (actor !== undefined) deny("operational_request", runId, "IDENTITY_MODE_MISMATCH");
      requireCompanyAdmission(admissionContext, runId, "operational_request");
      return;
    }
    const principal = attestedPrincipal("operational_request", runId, actor);
    requireCompanyAdmission({ ...admissionContext, principalForRun: () => principal }, runId, "operational_request");
    const binding = trusted!.runBindings.get(runId);
    if (
      !binding ||
      binding.companyId !== manifest.companyId ||
      binding.proofRef !== "operational_request" ||
      binding.configurationFingerprint !== configFingerprint ||
      binding.workflowFingerprint !== workflowFingerprint
    ) {
      deny("operational_request", runId, "RUN_BINDING_MISMATCH");
    }
    const approvalId = execution.wait?.referenceId;
    let digest: string | undefined;
    try {
      digest = executionDigest(execution);
    } catch {
      digest = undefined;
    }
    const recorded = typeof approvalId === "string" ? trusted!.runBindings.getWaitpoint(runId, approvalId) : undefined;
    if (digest === undefined || recorded === undefined || recorded !== digest) {
      deny("operational_request", runId, "CONTINUATION_STATE_MISMATCH");
    }
  };

  const companyApprovals = (approvals: AAOApprovals): CompanyApprovals => {
    const approver = (input: unknown): Principal => {
      if (!hasTrusted) return input as Principal;
      const principal = trusted!.identity.resolve(input);
      if (!principal) throw new ApprovalError("APPROVAL_IDENTITY_ATTESTATION_REQUIRED");
      return principal;
    };
    return Object.freeze({
      get: (approvalId: string) => approvals.get(approvalId),
      approve: (approvalId: string, input: Principal | AttestedActor) => approvals.approve(approvalId, approver(input)),
      reject: (approvalId: string, input: Principal | AttestedActor) => approvals.reject(approvalId, approver(input)),
    });
  };

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
      principalForRun,
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
      principalForRun,
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
      principalForRun,
      ...(options.audit ? { audit: options.audit } : {}),
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
        registrationSnapshot: companyResearchProof.registrationSnapshot,
        async run(input: {
          runId: string;
          request: CompanyResearchRequestInput;
          actor?: AttestedActor;
        }): Promise<CompanyResearchRunOutcome> {
          admit(input.runId, "company_research", input.actor, companyResearchProof!.planFingerprint);
          return companyResearchProof!.run({ runId: input.runId, request: input.request });
        },
      })
    : undefined;

  const documentIntelligenceFacade: DocumentIntelligenceFacade | undefined =
    documentIntelligenceProof
      ? Object.freeze({
          workflow: documentIntelligenceProof.workflow,
          planFingerprint: documentIntelligenceProof.planFingerprint,
          registrationSnapshot: documentIntelligenceProof.registrationSnapshot,
          async run(input: {
            runId: string;
            request: DocumentIntelligenceRequestInput;
            actor?: AttestedActor;
          }): Promise<DocumentIntelligenceRunOutcome> {
            admit(input.runId, "document_intelligence", input.actor, documentIntelligenceProof!.planFingerprint);
            return documentIntelligenceProof!.run({ runId: input.runId, request: input.request });
          },
        })
      : undefined;

  const operationalRequestFacade: OperationalRequestFacade | undefined =
    operationalRequestProof
      ? Object.freeze({
          workflow: operationalRequestProof.workflow,
          planFingerprint: operationalRequestProof.planFingerprint,
          registrationSnapshot: operationalRequestProof.registrationSnapshot,
          approvals: companyApprovals(operationalRequestProof.approvals),
          async execute(input: {
            runId: string;
            request: OperationalRequestInput;
            actor?: AttestedActor;
          }): Promise<WorkflowExecutionResult> {
            admit(input.runId, "operational_request", input.actor, operationalRequestProof!.planFingerprint);
            return recordWait(await operationalRequestProof!.execute({ runId: input.runId, request: input.request }));
          },
          async continue(execution: RuntimeExecutionState, actor?: AttestedActor): Promise<WorkflowExecutionResult> {
            admitContinuation(execution, actor, operationalRequestProof!.planFingerprint);
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
      actor?: AttestedActor;
    }): Promise<CompanyResearchRunOutcome> {
      if (!companyResearchProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'company_research' is disabled for company '${manifest.companyId}'`
        );
      }
      admit(input.runId, "company_research", input.actor, companyResearchProof.planFingerprint);
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
      actor?: AttestedActor;
    }): Promise<DocumentIntelligenceRunOutcome> {
      if (!documentIntelligenceProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'document_intelligence' is disabled for company '${manifest.companyId}'`
        );
      }
      admit(input.runId, "document_intelligence", input.actor, documentIntelligenceProof.planFingerprint);
      return documentIntelligenceProof.run({ runId: input.runId, request: input.request });
    },

    async executeOperationalRequest(input: {
      runId: string;
      request: OperationalRequestInput;
      actor?: AttestedActor;
    }): Promise<WorkflowExecutionResult> {
      if (!operationalRequestProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'operational_request' is disabled for company '${manifest.companyId}'`
        );
      }
      admit(input.runId, "operational_request", input.actor, operationalRequestProof.planFingerprint);
      return recordWait(await operationalRequestProof.execute({ runId: input.runId, request: input.request }));
    },

    async continueOperationalRequest(
      execution: RuntimeExecutionState,
      actor?: AttestedActor
    ): Promise<WorkflowExecutionResult> {
      if (!operationalRequestProof) {
        throw new CompanyConfigError(
          "CONFIG_PROOF_DISABLED",
          `Proof 'operational_request' is disabled for company '${manifest.companyId}'`
        );
      }
      admitContinuation(execution, actor, operationalRequestProof.planFingerprint);
      return operationalRequestProof.continue(execution);
    },
  });
}
