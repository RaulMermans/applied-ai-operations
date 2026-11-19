import { createHash } from "node:crypto";
import {
  ApprovalRecordSchema,
  RunRecordSchema,
  TRACE_TERMINAL_EVENT_TYPES,
  WorkflowSchema,
  canonicalJsonStringify,
  type ApprovalRecord,
  type JsonValue,
  type PermissionClass,
  type RunRecord,
  type RunStatus,
  type TraceEvent,
  type Workflow,
} from "@aao/contracts";
import {
  validateCompanyManifest,
  type CompanyManifestV1,
} from "@aao/config";
import {
  CapabilityPackError,
  defineCapabilityPack,
  getRequiredProofName,
  validatePackCompatibility,
  type CapabilityPack,
  type CapabilityPackManifestV1,
  type ExactToolRef,
  type ProofRegistrationSnapshot,
  type VerifiedModelAdapter,
  type VerifiedModelBinding,
} from "@aao/capability-packs";
import { compileWorkflow } from "@aao/workflow-dsl";
import { deriveRunMetrics, validateTrace } from "@aao/observability";
import {
  ApprovalSummarySchema,
  CapabilityPackSummarySchema,
  CompanySummarySchema,
  EvaluationSummarySchema,
  INSPECTION_LIMITS,
  PackCompatibilitySummarySchema,
  RunInspectionSchema,
  RunSummarySchema,
  TraceInspectionSchema,
  WorkflowSummarySchema,
  IntegrationDiagnosticReportSchema,
  AdvancedRunInspectionSchema,
  findForbiddenInspectionKeys,
  type ApprovalSummary,
  type BaselineComparisonStatus,
  type CapabilityPackSummary,
  type CompanySummary,
  type EvaluationSummary,
  type EvaluationSummaryStatus,
  type OperatorRunStatus,
  type OperatorSourceProvenance,
  type PackCompatibilitySummary,
  type RunInspection,
  type RunSummary,
  type TraceDiagnosticSummary,
  type TraceEventSummary,
  type TraceHealthStatus,
  type TraceInspection,
  type WorkflowEdgeSummary,
  type WorkflowNodeSummary,
  type WorkflowSummary,
  type IntegrationDiagnosticReport,
  type IntegrationRequirementDiagnostic,
  type IntegrationDiagnostic,
  type AdvancedRunInspection,
  type NodeExecutionInspection,
  type NodeAttemptInspection,
  type ExecutionCounters,
  type UnattributedEvent,
  type RunDiagnostic,
  type TokenUsageSummary,
} from "./contracts.js";
import { OperatorInspectionError } from "./errors.js";
import { describeRunFailure, getRemediationForCode } from "./remediation.js";

export function assertSafeInspectionPayload<T>(value: T): T {
  const forbidden = findForbiddenInspectionKeys(value);
  if (forbidden.length > 0) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      `Inspection projection blocked forbidden field(s): ${forbidden.slice(0, 5).join(", ")}`,
      { details: { forbiddenFields: forbidden.slice(0, 10) } }
    );
  }
  return value;
}

// --- 1. Company Summary Projection ---

export interface ProjectCompanyInput {
  readonly manifest: CompanyManifestV1 | unknown;
  readonly selectedPackRefs?: readonly { id: string; version: string }[];
  readonly compatibilitySummaries?: readonly PackCompatibilitySummary[];
}

export function projectCompanySummary(input: ProjectCompanyInput): CompanySummary {
  let validated;
  try {
    validated = validateCompanyManifest(input.manifest);
  } catch (err) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      err instanceof Error ? err.message : "Invalid company manifest",
      { cause: err }
    );
  }

  const { manifest, configFingerprint } = validated;
  const enabledPackCount = input.selectedPackRefs
    ? input.selectedPackRefs.length
    : manifest.enabledProofs.length;

  const verifiedCompatiblePackCount = input.compatibilitySummaries
    ? input.compatibilitySummaries.filter(
        (c) => c.companyId === manifest.companyId && c.status === "COMPATIBLE" && c.verified
      ).length
    : 0;

  const summary: CompanySummary = {
    companyId: manifest.companyId,
    displayName: manifest.displayName,
    schemaVersion: manifest.schemaVersion,
    configurationFingerprint: configFingerprint,
    enabledProofs: [...manifest.enabledProofs],
    enabledPackCount,
    verifiedCompatiblePackCount,
    modelBindingRefs: [...manifest.models.bindingRefs],
    integrationRefs: {
      ...(manifest.integrations.publicWebProviderRef
        ? { publicWebProviderRef: manifest.integrations.publicWebProviderRef }
        : {}),
      ...(manifest.integrations.documentSourceProviderRef
        ? { documentSourceProviderRef: manifest.integrations.documentSourceProviderRef }
        : {}),
      ...(manifest.integrations.draftRepositoryRef
        ? { draftRepositoryRef: manifest.integrations.draftRepositoryRef }
        : {}),
    },
  };

  return assertSafeInspectionPayload(CompanySummarySchema.parse(summary));
}

// --- 2. Capability Pack Summary Projection ---

export function projectCapabilityPackSummary(
  packOrManifest: CapabilityPack | CapabilityPackManifestV1 | unknown
): CapabilityPackSummary {
  let pack: CapabilityPack;
  try {
    if (
      packOrManifest !== null &&
      typeof packOrManifest === "object" &&
      "manifest" in packOrManifest &&
      "fingerprint" in packOrManifest &&
      "identity" in packOrManifest
    ) {
      const candidate = packOrManifest as CapabilityPack;
      pack = defineCapabilityPack(candidate.manifest);
    } else {
      pack = defineCapabilityPack(packOrManifest);
    }
  } catch (err) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      err instanceof Error ? err.message : "Invalid capability pack manifest",
      { cause: err }
    );
  }

  const m = pack.manifest;
  const summary: CapabilityPackSummary = {
    id: m.id,
    version: m.version,
    identity: pack.identity,
    packFingerprint: pack.fingerprint,
    name: m.name,
    description: m.description,
    category: m.category,
    tags: [...m.tags],
    outcomeClass: m.execution.outcomeClass,
    workflow: {
      id: m.workflow.id,
      version: m.workflow.version,
      planFingerprint: m.workflow.planFingerprint,
    },
    requirements: {
      toolRefs: m.requirements.toolRefs.map((t) => ({ id: t.id, version: t.version })),
      modelPolicyRefs: [...m.requirements.modelPolicyRefs],
      modelCapabilities: [...m.requirements.modelCapabilities],
      integrationSlots: m.requirements.integrationSlots.map((s) => ({
        slot: s.slot,
        description: s.description,
      })),
      preliminaryPermissions: [...m.requirements.preliminaryPermissions],
      approval: m.requirements.approval
        ? {
            required: m.requirements.approval.required,
            requiredRoleIds: [...m.requirements.approval.requiredRoleIds],
            permissionClasses: [...m.requirements.approval.permissionClasses],
          }
        : { required: false },
    },
    evalProfileRef: m.verification.evalProfileRef,
  };

  return assertSafeInspectionPayload(CapabilityPackSummarySchema.parse(summary));
}

// --- 3. Verified Compatibility Projection ---

export interface TrustedProofRegistrationEvidence {
  readonly snapshot?: ProofRegistrationSnapshot;
  readonly workflow?: ProofRegistrationSnapshot["workflow"];
  readonly tools?: ReadonlyArray<ExactToolRef>;
  readonly registeredTools?: ReadonlyArray<ExactToolRef>;
  readonly modelPolicies?: ReadonlyArray<string>;
  readonly registeredModelPolicies?: ReadonlyArray<string>;
  readonly modelBindings?: ReadonlyArray<VerifiedModelBinding>;
  readonly registeredModelBindings?: ReadonlyArray<VerifiedModelBinding>;
  readonly modelAdapters?: ReadonlyArray<VerifiedModelAdapter>;
  readonly registeredModelAdapters?: ReadonlyArray<VerifiedModelAdapter>;
  readonly registeredEvalProfiles?: ReadonlyArray<string>;
}

export interface ProjectPackCompatibilityInput {
  readonly companyManifest: CompanyManifestV1 | unknown;
  readonly pack: CapabilityPack | CapabilityPackManifestV1;
  readonly selectedByCompany?: boolean;
  /**
   * Trusted registration snapshot for this company and proof category.
   * When omitted or incomplete, compatibility is reported as NOT_VERIFIED
   * (unless the proof itself is disabled).
   */
  readonly registrationEvidence?: TrustedProofRegistrationEvidence;
}

export function projectPackCompatibilitySummary(
  input: ProjectPackCompatibilityInput
): PackCompatibilitySummary {
  let validatedCompany;
  try {
    validatedCompany = validateCompanyManifest(input.companyManifest);
  } catch (err) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      err instanceof Error ? err.message : "Invalid company manifest for compatibility check",
      { cause: err }
    );
  }

  let pack: CapabilityPack;
  try {
    pack =
      "manifest" in input.pack && "fingerprint" in input.pack
        ? defineCapabilityPack((input.pack as CapabilityPack).manifest)
        : defineCapabilityPack(input.pack);
  } catch (err) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      err instanceof Error ? err.message : "Invalid pack manifest for compatibility check",
      { cause: err }
    );
  }

  const manifest = validatedCompany.manifest;
  const m = pack.manifest;
  const requiredProof = getRequiredProofName(m.id);
  const enabledByCompany = (manifest.enabledProofs as readonly string[]).includes(requiredProof);
  const selectedByCompany = input.selectedByCompany ?? enabledByCompany;

  // If the proof is disabled by company configuration, it is deterministically INCOMPATIBLE.
  if (!enabledByCompany) {
    const summary: PackCompatibilitySummary = {
      companyId: manifest.companyId,
      packId: pack.ref.id,
      packVersion: pack.ref.version,
      packIdentity: pack.identity,
      packName: m.name,
      packFingerprint: pack.fingerprint,
      workflowId: m.workflow.id,
      workflowVersion: m.workflow.version,
      planFingerprint: m.workflow.planFingerprint,
      enabledByCompany: false,
      selectedByCompany,
      verified: false,
      status: "INCOMPATIBLE",
      reasonCode: "PACK_PROOF_DISABLED",
      diagnostic: `Company '${manifest.companyId}' does not enable proof '${requiredProof}'.`,
    };
    return assertSafeInspectionPayload(PackCompatibilitySummarySchema.parse(summary));
  }

  // If no trusted registration evidence was supplied, never assume COMPATIBLE from configuration alone!
  if (!input.registrationEvidence) {
    const summary: PackCompatibilitySummary = {
      companyId: manifest.companyId,
      packId: pack.ref.id,
      packVersion: pack.ref.version,
      packIdentity: pack.identity,
      packName: m.name,
      packFingerprint: pack.fingerprint,
      workflowId: m.workflow.id,
      workflowVersion: m.workflow.version,
      planFingerprint: m.workflow.planFingerprint,
      enabledByCompany: true,
      selectedByCompany,
      verified: false,
      status: "NOT_VERIFIED",
      reasonCode: "PACK_EVIDENCE_UNAVAILABLE",
      diagnostic: `Trusted ProofRegistrationSnapshot evidence is unavailable for '${manifest.companyId}' (${pack.identity}); compatibility cannot be assumed from configuration alone.`,
    };
    return assertSafeInspectionPayload(PackCompatibilitySummarySchema.parse(summary));
  }

  const evidence = input.registrationEvidence;
  const snapshot = "snapshot" in evidence && evidence.snapshot ? evidence.snapshot : undefined;
  const workflow = snapshot?.workflow ?? evidence.workflow;
  const tools = snapshot?.tools ?? evidence.registeredTools ?? evidence.tools;
  const modelPolicies =
    snapshot?.modelPolicies ?? evidence.registeredModelPolicies ?? evidence.modelPolicies;
  const modelBindings =
    snapshot?.modelBindings ?? evidence.registeredModelBindings ?? evidence.modelBindings;
  const modelAdapters =
    snapshot?.modelAdapters ?? evidence.registeredModelAdapters ?? evidence.modelAdapters;
  const evalProfiles = evidence.registeredEvalProfiles;

  if (!workflow || !tools || !modelPolicies || !modelBindings) {
    const summary: PackCompatibilitySummary = {
      companyId: manifest.companyId,
      packId: pack.ref.id,
      packVersion: pack.ref.version,
      packIdentity: pack.identity,
      packName: m.name,
      packFingerprint: pack.fingerprint,
      workflowId: m.workflow.id,
      workflowVersion: m.workflow.version,
      planFingerprint: m.workflow.planFingerprint,
      enabledByCompany: true,
      selectedByCompany,
      verified: false,
      status: "NOT_VERIFIED",
      reasonCode: "PACK_EVIDENCE_UNAVAILABLE",
      diagnostic: `Trusted ProofRegistrationSnapshot evidence is unavailable for '${manifest.companyId}' (${pack.identity}); compatibility cannot be assumed from configuration alone.`,
    };
    return assertSafeInspectionPayload(PackCompatibilitySummarySchema.parse(summary));
  }

  try {
    const report = validatePackCompatibility(pack, {
      companyId: manifest.companyId,
      enabledProofs: manifest.enabledProofs,
      governanceRoles: manifest.governance.roles,
      integrations: manifest.integrations,
      workflow: workflow as NonNullable<ProofRegistrationSnapshot["workflow"]>,
      registeredTools: tools as readonly ExactToolRef[],
      registeredModelPolicies: modelPolicies as readonly string[],
      registeredModelBindings: modelBindings as readonly VerifiedModelBinding[],
      registeredModelAdapters: modelAdapters as readonly VerifiedModelAdapter[] | undefined,
      registeredEvalProfiles: evalProfiles as readonly string[], // undefined → PACK_EVIDENCE_UNAVAILABLE, never "missing"
    });

    const summary: PackCompatibilitySummary = {
      companyId: manifest.companyId,
      packId: pack.ref.id,
      packVersion: pack.ref.version,
      packIdentity: pack.identity,
      packName: m.name,
      packFingerprint: pack.fingerprint,
      workflowId: m.workflow.id,
      workflowVersion: m.workflow.version,
      planFingerprint: m.workflow.planFingerprint,
      enabledByCompany: true,
      selectedByCompany,
      verified: true,
      status: "COMPATIBLE",
      verifiedRequirements: {
        tools: report.verifiedRequirements.tools,
        modelPolicies: report.verifiedRequirements.modelPolicies,
        modelCapabilities: report.verifiedRequirements.modelCapabilities,
        integrations: report.verifiedRequirements.integrations,
        evalProfiles: report.verifiedRequirements.evalProfiles,
      },
    };
    return assertSafeInspectionPayload(PackCompatibilitySummarySchema.parse(summary));
  } catch (err) {
    if (err instanceof CapabilityPackError) {
      const isUnverified = err.code === "PACK_EVIDENCE_UNAVAILABLE";
      const summary: PackCompatibilitySummary = {
        companyId: manifest.companyId,
        packId: pack.ref.id,
        packVersion: pack.ref.version,
        packIdentity: pack.identity,
        packName: m.name,
        packFingerprint: pack.fingerprint,
        workflowId: m.workflow.id,
        workflowVersion: m.workflow.version,
        planFingerprint: m.workflow.planFingerprint,
        enabledByCompany: true,
        selectedByCompany,
        verified: false,
        status: isUnverified ? "NOT_VERIFIED" : "INCOMPATIBLE",
        reasonCode: err.code,
        diagnostic: err.message.slice(0, INSPECTION_LIMITS.MAX_STRING_LENGTH),
      };
      return assertSafeInspectionPayload(PackCompatibilitySummarySchema.parse(summary));
    }
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      err instanceof Error ? err.message : "Unexpected error during compatibility verification",
      { cause: err }
    );
  }
}

// --- 4. Workflow Inspection Projection ---

export function computeCompiledWorkflowFingerprint(workflow: Workflow): {
  planFingerprint: string;
  terminalNodeIds: string[];
} {
  const compiled = compileWorkflow(workflow);
  if (!compiled.ok) {
    const diagText = compiled.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ");
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      `Workflow '${workflow.id}@${workflow.version}' failed compilation: ${diagText}`
    );
  }
  const planFingerprint = createHash("sha256")
    .update(canonicalJsonStringify(compiled.plan as unknown as JsonValue), "utf8")
    .digest("hex");

  return {
    planFingerprint,
    terminalNodeIds: [...compiled.plan.terminalNodeIds],
  };
}

function formatRefFromConfig(ref: unknown): string | undefined {
  if (typeof ref === "string" && ref.length > 0) {
    return ref;
  }
  if (ref !== null && typeof ref === "object" && !Array.isArray(ref)) {
    const obj = ref as Record<string, unknown>;
    if (typeof obj.id === "string" && typeof obj.version === "string") {
      return `${obj.id}@${obj.version}`;
    }
    if (typeof obj.id === "string") {
      return obj.id;
    }
  }
  return undefined;
}

export function projectWorkflowSummary(
  rawWorkflow: Workflow | unknown,
  options?: { expectedPlanFingerprint?: string }
): WorkflowSummary {
  const parsed = WorkflowSchema.safeParse(rawWorkflow);
  if (!parsed.success) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      `Invalid Workflow definition: ${parsed.error.issues.map((i) => i.message).join("; ")}`
    );
  }

  const workflow = parsed.data;
  const { planFingerprint, terminalNodeIds } = computeCompiledWorkflowFingerprint(workflow);

  if (
    options?.expectedPlanFingerprint &&
    options.expectedPlanFingerprint !== planFingerprint
  ) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      `Workflow '${workflow.id}@${workflow.version}' plan fingerprint '${planFingerprint}' does not match expected '${options.expectedPlanFingerprint}'.`
    );
  }

  const toolRefSet = new Set<string>();
  const modelPolicySet = new Set<string>();
  const agentRefSet = new Set<string>();
  const approverRoleSet = new Set<string>();
  const nodeKindSet = new Set<Workflow["nodes"][number]["kind"]>();

  const nodes: WorkflowNodeSummary[] = workflow.nodes.map((node) => {
    nodeKindSet.add(node.kind);
    const cfg = node.config as Record<string, unknown>;

    const toolRef = formatRefFromConfig(cfg.toolRef ?? cfg.tool);
    if (toolRef) {
      toolRefSet.add(toolRef);
    }

    const modelPolicyId =
      typeof cfg.modelPolicyId === "string"
        ? cfg.modelPolicyId
        : typeof cfg.modelPolicyRef === "string"
          ? cfg.modelPolicyRef
          : undefined;
    if (modelPolicyId) {
      modelPolicySet.add(modelPolicyId);
    }

    const agentRef = formatRefFromConfig(cfg.agentRef ?? cfg.agent);
    if (agentRef) {
      agentRefSet.add(agentRef);
    }

    const executorRef =
      formatRefFromConfig(cfg.executorRef) ??
      (typeof cfg.executorId === "string"
        ? cfg.executorId
        : typeof cfg.operation === "string"
          ? cfg.operation
          : undefined);

    const requiredApproverRoleIds = Array.isArray(cfg.requiredApproverRoleIds)
      ? cfg.requiredApproverRoleIds.filter((r): r is string => typeof r === "string")
      : undefined;
    if (requiredApproverRoleIds) {
      for (const r of requiredApproverRoleIds) {
        approverRoleSet.add(r);
      }
    }

    const permissionClasses = Array.isArray(cfg.permissionClasses)
      ? cfg.permissionClasses.filter(
          (p): p is PermissionClass =>
            p === "read_only" || p === "write_draft" || p === "external_side_effect"
        )
      : undefined;

    const nodeSummary: WorkflowNodeSummary = {
      id: node.id,
      kind: node.kind,
      ...(node.name ? { name: node.name } : {}),
      ...(toolRef ? { toolRef } : {}),
      ...(modelPolicyId ? { modelPolicyId } : {}),
      ...(agentRef ? { agentRef } : {}),
      ...(executorRef ? { executorRef } : {}),
      ...(requiredApproverRoleIds && requiredApproverRoleIds.length > 0
        ? { requiredApproverRoleIds }
        : {}),
      ...(permissionClasses && permissionClasses.length > 0 ? { permissionClasses } : {}),
    };
    return nodeSummary;
  });

  const edges: WorkflowEdgeSummary[] = workflow.edges.map((e) => ({
    sourceNodeId: e.sourceNodeId,
    targetNodeId: e.targetNodeId,
    conditional: e.condition !== undefined && Object.keys(e.condition).length > 0,
  }));

  const summary: WorkflowSummary = {
    workflowId: workflow.id,
    version: workflow.version,
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description.slice(0, 500) } : {}),
    planFingerprint,
    nodeCount: workflow.nodes.length,
    entryNodeId: workflow.entryNodeId,
    terminalNodeIds,
    nodeKinds: [...nodeKindSet],
    nodeIds: workflow.nodes.map((n) => n.id),
    nodes,
    edges,
    toolRefs: [...toolRefSet].sort(),
    modelPolicyRefs: [...modelPolicySet].sort(),
    agentRefs: [...agentRefSet].sort(),
    requiredApproverRoleIds: [...approverRoleSet].sort(),
  };

  return assertSafeInspectionPayload(WorkflowSummarySchema.parse(summary));
}

// --- 5. Approval Summary Projection ---

export function projectApprovalSummary(rawRecord: ApprovalRecord | unknown): ApprovalSummary {
  const parsed = ApprovalRecordSchema.safeParse(rawRecord);
  if (!parsed.success) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      `Invalid ApprovalRecord: ${parsed.error.issues.map((i) => i.message).join("; ")}`
    );
  }
  const r = parsed.data;
  const summary: ApprovalSummary = {
    approvalId: r.approvalId,
    runId: r.runId,
    nodeId: r.nodeId,
    status: r.status,
    requiredApproverRoleIds: [...r.requiredApproverRoleIds],
    permissionClasses: [...r.permissionClasses],
    allowSelfApproval: r.allowSelfApproval,
    requestedBy: { id: r.requestedBy.id, type: r.requestedBy.type },
    requestedAt: r.requestedAt,
    ...(r.resolvedBy ? { resolvedBy: { id: r.resolvedBy.id, type: r.resolvedBy.type } } : {}),
    ...(r.resolvedAt ? { resolvedAt: r.resolvedAt } : {}),
    requestFingerprint: r.requestFingerprint,
  };
  return assertSafeInspectionPayload(ApprovalSummarySchema.parse(summary));
}

// --- 6. Evaluation Summary Projection ---

export interface RawEvaluationEvidence {
  readonly evalProfileRef: string;
  readonly packIdentity?: string;
  readonly workflowId?: string;
  readonly companyId?: string;
  readonly runId?: string;
  readonly datasetRef?: string;
  readonly graderRefs?: readonly string[];
  /**
   * When false or omitted without execution counts, represents a registered/configured
   * Evaluation profile that has NOT been executed yet.
   */
  readonly executed: boolean;
  readonly executedAt?: string;
  readonly totalCases?: number;
  readonly passedCases?: number;
  readonly failedCases?: number;
  readonly allMatched?: boolean;
  readonly failureCodes?: readonly string[];
  readonly baselineComparisonStatus?: BaselineComparisonStatus;
}

export function projectEvaluationSummary(input: RawEvaluationEvidence): EvaluationSummary {
  if (!input || typeof input.evalProfileRef !== "string" || input.evalProfileRef.trim() === "") {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      "Evaluation evidence is missing a valid evalProfileRef."
    );
  }

  let status: EvaluationSummaryStatus;
  let passRate: number | undefined;
  let totalCases: number | undefined;
  let passedCases: number | undefined;
  let failedCases: number | undefined;

  if (!input.executed) {
    status = "REGISTERED";
  } else {
    totalCases = input.totalCases ?? 0;
    passedCases = input.passedCases ?? 0;
    failedCases = input.failedCases ?? Math.max(0, totalCases - passedCases);
    if (passedCases + failedCases !== totalCases || totalCases <= 0) {
      throw new OperatorInspectionError(
        "INSPECTION_EVIDENCE_INVALID",
        `Executed evaluation '${input.evalProfileRef}' has inconsistent case counts (total=${totalCases}, passed=${passedCases}, failed=${failedCases}).`
      );
    }
    passRate = Number((passedCases / totalCases).toFixed(4));
    const allPassed =
      failedCases === 0 &&
      passedCases === totalCases &&
      (input.allMatched === undefined || input.allMatched === true);
    status = allPassed ? "PASSED" : "FAILED";
  }

  const summary: EvaluationSummary = {
    evalProfileRef: input.evalProfileRef,
    ...(input.packIdentity ? { packIdentity: input.packIdentity } : {}),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.datasetRef ? { datasetRef: input.datasetRef } : {}),
    graderRefs: [...(input.graderRefs ?? [])],
    status,
    executed: input.executed,
    ...(input.executed && input.executedAt ? { executedAt: input.executedAt } : {}),
    ...(input.executed && totalCases !== undefined ? { totalCases } : {}),
    ...(input.executed && passedCases !== undefined ? { passedCases } : {}),
    ...(input.executed && failedCases !== undefined ? { failedCases } : {}),
    ...(input.executed && passRate !== undefined ? { passRate } : {}),
    failureCodes: [...(input.failureCodes ?? [])],
    ...(input.baselineComparisonStatus
      ? { baselineComparisonStatus: input.baselineComparisonStatus }
      : {}),
  };

  return assertSafeInspectionPayload(EvaluationSummarySchema.parse(summary));
}

// --- 7. Trace Inspection Projection ---

function projectSingleTraceEvent(event: TraceEvent): TraceEventSummary {
  const p = event.payload as Record<string, unknown>;

  let reasonCode: string | undefined;
  if (typeof p.code === "string") {
    reasonCode = p.code;
  } else if (typeof p.causeCode === "string") {
    reasonCode = p.causeCode;
  } else if (
    p.access !== null &&
    typeof p.access === "object" &&
    typeof (p.access as Record<string, unknown>).reasonCode === "string"
  ) {
    reasonCode = (p.access as Record<string, unknown>).reasonCode as string;
  }

  const toolRef = formatRefFromConfig(p.toolRef);
  const agentRef = formatRefFromConfig(p.agentRef);
  const modelPolicyRef =
    typeof p.modelPolicyRef === "string" ? p.modelPolicyRef : undefined;
  const modelBindingId =
    typeof p.modelBindingId === "string" ? p.modelBindingId : undefined;
  const approvalId = typeof p.approvalId === "string" ? p.approvalId : undefined;
  const approvalDecisionStatus =
    event.type === "approval.resolved" &&
    (p.status === "approved" ||
      p.status === "rejected" ||
      p.status === "expired" ||
      p.status === "cancelled")
      ? p.status
      : undefined;

  let tokenUsage: TraceEventSummary["tokenUsage"];
  if (p.usage !== null && typeof p.usage === "object") {
    const u = p.usage as Record<string, unknown>;
    tokenUsage = {
      ...(typeof u.inputTokens === "number" ? { inputTokens: u.inputTokens } : {}),
      ...(typeof u.outputTokens === "number" ? { outputTokens: u.outputTokens } : {}),
      ...(typeof u.totalTokens === "number" ? { totalTokens: u.totalTokens } : {}),
    };
  }

  const attempt =
    typeof p.attempt === "number"
      ? p.attempt
      : typeof p.attemptCount === "number"
        ? p.attemptCount
        : undefined;
  const maxAttempts = typeof p.maxAttempts === "number" ? p.maxAttempts : undefined;
  const recoveryReplay =
    typeof p.recoveryReplay === "boolean" ? p.recoveryReplay : undefined;

  return {
    sequence: event.sequence,
    eventId: event.eventId,
    traceId: event.traceId,
    runId: event.runId,
    type: event.type,
    occurredAt: event.occurredAt,
    workflowId: event.workflowId,
    workflowVersion: event.workflowVersion,
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    spanId: event.spanId,
    ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(toolRef ? { toolRef } : {}),
    ...(modelPolicyRef ? { modelPolicyRef } : {}),
    ...(modelBindingId ? { modelBindingId } : {}),
    ...(agentRef ? { agentRef } : {}),
    ...(approvalId ? { approvalId } : {}),
    ...(approvalDecisionStatus ? { approvalDecisionStatus } : {}),
    ...(tokenUsage && Object.keys(tokenUsage).length > 0 ? { tokenUsage } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(recoveryReplay !== undefined ? { recoveryReplay } : {}),
  };
}

export interface ProjectTraceInspectionOptions {
  readonly runId: string;
  readonly events: readonly TraceEvent[] | undefined;
  readonly maxEvents?: number;
  readonly throwOnCorrupt?: boolean;
}

export function projectTraceInspection(
  options: ProjectTraceInspectionOptions
): TraceInspection {
  const maxEvents = Math.min(
    options.maxEvents ?? INSPECTION_LIMITS.MAX_TRACE_EVENTS,
    INSPECTION_LIMITS.MAX_TRACE_EVENTS
  );

  if (!options.events || options.events.length === 0) {
    const empty: TraceInspection = {
      runId: options.runId,
      health: "unavailable",
      eventCount: 0,
      returnedEventCount: 0,
      truncated: false,
      diagnostics: [],
      events: [],
    };
    return assertSafeInspectionPayload(TraceInspectionSchema.parse(empty));
  }

  const validation = validateTrace(options.events, { runId: options.runId });
  if (!validation.valid) {
    const diagnostics: TraceDiagnosticSummary[] = validation.issues.map((d) => ({
      code: d.code,
      message: `Trace integrity check failed: ${d.code}${d.nodeId ? ` (node ${d.nodeId})` : ""}`.slice(
        0,
        INSPECTION_LIMITS.MAX_STRING_LENGTH
      ),
      ...(d.sequence !== undefined ? { sequence: d.sequence } : {}),
    }));

    if (options.throwOnCorrupt) {
      throw new OperatorInspectionError(
        "INSPECTION_TRACE_CORRUPT",
        `Trace for run '${options.runId}' failed integrity validation (${diagnostics.map((d) => d.code).join(", ")}).`,
        {
          details: {
            runId: options.runId,
            diagnosticCodes: diagnostics.map((d) => d.code),
          },
        }
      );
    }

    const corruptInspection: TraceInspection = {
      runId: options.runId,
      health: "corrupt",
      eventCount: options.events.length,
      returnedEventCount: 0,
      truncated: false,
      diagnostics,
      events: [],
    };
    return assertSafeInspectionPayload(TraceInspectionSchema.parse(corruptInspection));
  }

  const events = options.events;
  const first = events[0]!;
  const traceRun = {
    runId: options.runId,
    traceId: first.traceId,
    workflowId: first.workflowId,
    workflowVersion: first.workflowVersion,
    events: [...events],
    terminal: events.find((e) =>
      (TRACE_TERMINAL_EVENT_TYPES as readonly string[]).includes(e.type)
    ),
  };
  const boundedEvents = traceRun.events.slice(0, maxEvents).map(projectSingleTraceEvent);
  const truncated = traceRun.events.length > maxEvents;

  const firstEvent = traceRun.events[0];
  const lastEvent = traceRun.events[traceRun.events.length - 1];
  const terminalEventType = traceRun.terminal?.type as
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | undefined;

  const inspection: TraceInspection = {
    runId: traceRun.runId,
    traceId: traceRun.traceId,
    workflowId: traceRun.workflowId,
    workflowVersion: traceRun.workflowVersion,
    health: "healthy",
    eventCount: traceRun.events.length,
    returnedEventCount: boundedEvents.length,
    truncated,
    ...(terminalEventType ? { terminalEventType } : {}),
    ...(firstEvent ? { startedAt: firstEvent.occurredAt } : {}),
    ...(terminalEventType && lastEvent ? { finishedAt: lastEvent.occurredAt } : {}),
    diagnostics: [],
    events: boundedEvents,
  };

  return assertSafeInspectionPayload(TraceInspectionSchema.parse(inspection));
}

// --- 8. Run Summary & Run Inspection Projections ---

export function mapAuthoritativeRunStatus(status: RunStatus): OperatorRunStatus {
  switch (status) {
    case "COMPLETED":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    case "WAITING_FOR_APPROVAL":
      return "WAITING";
    case "CREATED":
    case "VALIDATING":
    case "QUEUED":
    case "RUNNING":
    case "RETRYING":
      return "RUNNING";
  }
}

export interface KnownRunEvidence {
  readonly runId: string;
  readonly companyId?: string;
  readonly packIdentity?: string;
  /**
   * Authoritative Run record from Runtime or Durability.
   * When undefined, inspection MUST report status = "UNKNOWN" and statusSource = "unavailable",
   * even if trace events exist.
   */
  readonly authoritativeRun?: RunRecord;
  readonly traceEvents?: readonly TraceEvent[];
  readonly approvalRecords?: readonly ApprovalRecord[];
  readonly evaluations?: readonly RawEvaluationEvidence[];
  readonly workflow?: Workflow;
}

export function projectRunSummary(evidence: KnownRunEvidence): RunSummary {
  let validatedRun: RunRecord | undefined;
  if (evidence.authoritativeRun !== undefined) {
    const parsed = RunRecordSchema.safeParse(evidence.authoritativeRun);
    if (!parsed.success) {
      throw new OperatorInspectionError(
        "INSPECTION_EVIDENCE_INVALID",
        `Invalid authoritative RunRecord for '${evidence.runId}': ${parsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }
    validatedRun = parsed.data;
  }

  const traceInspection = projectTraceInspection({
    runId: evidence.runId,
    events: evidence.traceEvents,
    throwOnCorrupt: false,
  });

  const workflowId =
    validatedRun?.workflowId ??
    traceInspection.workflowId ??
    evidence.workflow?.id ??
    "workflow.unknown";
  const workflowVersion =
    validatedRun?.workflowVersion ??
    traceInspection.workflowVersion ??
    evidence.workflow?.version ??
    "0.0.0";

  // Authoritative status rule: NEVER infer COMPLETED, RUNNING, or WAITING from Trace alone.
  let status: OperatorRunStatus;
  let statusSource: "authoritative_runtime" | "unavailable";
  let statusReason: string | undefined;

  if (validatedRun) {
    status = mapAuthoritativeRunStatus(validatedRun.status);
    statusSource = "authoritative_runtime";
    if (validatedRun.status === "WAITING_FOR_APPROVAL") {
      statusReason = "WAITING_FOR_APPROVAL";
    }
  } else {
    status = "UNKNOWN";
    statusSource = "unavailable";
    statusReason = "AUTHORITATIVE_RUN_STATE_UNAVAILABLE";
  }

  // Collect approval IDs from authoritative records + trace observations
  const approvalIdSet = new Set<string>();
  if (evidence.approvalRecords) {
    for (const r of evidence.approvalRecords) {
      if (r.runId === evidence.runId) {
        approvalIdSet.add(r.approvalId);
      }
    }
  }
  for (const ev of traceInspection.events) {
    if (ev.approvalId) {
      approvalIdSet.add(ev.approvalId);
    }
  }

  // Determine overall trace health relative to run existence
  let traceHealth: TraceHealthStatus = traceInspection.health;
  if (validatedRun && traceInspection.health === "unavailable") {
    traceHealth = "degraded";
  }

  // Evaluation summary status for this run if present
  let evaluationStatus: EvaluationSummaryStatus | undefined;
  if (evidence.evaluations && evidence.evaluations.length > 0) {
    const projectedEvals = evidence.evaluations.map(projectEvaluationSummary);
    if (projectedEvals.some((e) => e.status === "FAILED")) {
      evaluationStatus = "FAILED";
    } else if (projectedEvals.every((e) => e.status === "PASSED")) {
      evaluationStatus = "PASSED";
    } else {
      evaluationStatus = projectedEvals[0]?.status;
    }
  }

  const startedAt = validatedRun?.createdAt ?? traceInspection.startedAt;
  const finishedAt =
    validatedRun &&
    (validatedRun.status === "COMPLETED" ||
      validatedRun.status === "FAILED" ||
      validatedRun.status === "CANCELLED")
      ? validatedRun.updatedAt
      : traceInspection.finishedAt;

  const summary: RunSummary = {
    runId: evidence.runId,
    workflowId,
    workflowVersion,
    ...(evidence.companyId ? { companyId: evidence.companyId } : {}),
    ...(evidence.packIdentity ? { packIdentity: evidence.packIdentity } : {}),
    status,
    statusSource,
    ...(statusReason ? { statusReason } : {}),
    ...(validatedRun?.currentNodeId ? { currentNodeId: validatedRun.currentNodeId } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    traceAvailable: traceInspection.health === "healthy" && traceInspection.eventCount > 0,
    traceHealth,
    ...(traceInspection.eventCount > 0 ? { traceEventCount: traceInspection.eventCount } : {}),
    approvalIds: [...approvalIdSet].sort(),
    ...(evaluationStatus ? { evaluationStatus } : {}),
  };

  return assertSafeInspectionPayload(RunSummarySchema.parse(summary));
}

export function projectRunInspection(
  evidence: KnownRunEvidence,
  provenance?: OperatorSourceProvenance
): RunInspection {
  const summary = projectRunSummary(evidence);
  const trace = projectTraceInspection({
    runId: evidence.runId,
    events: evidence.traceEvents,
    throwOnCorrupt: false,
  });

  const workflow = evidence.workflow
    ? projectWorkflowSummary(evidence.workflow)
    : undefined;

  // Authoritative approvals ONLY: never fabricate an ApprovalSummary from a trace event!
  const approvals: ApprovalSummary[] = (evidence.approvalRecords ?? [])
    .filter((r) => r.runId === evidence.runId)
    .map(projectApprovalSummary)
    .sort((a, b) => a.approvalId.localeCompare(b.approvalId));

  const authoritativeApprovalIds = new Set(approvals.map((a) => a.approvalId));

  const evaluations: EvaluationSummary[] = (evidence.evaluations ?? [])
    .map(projectEvaluationSummary)
    .sort((a, b) => a.evalProfileRef.localeCompare(b.evalProfileRef));

  const diagnostics: string[] = [];
  if (summary.statusSource === "unavailable") {
    diagnostics.push(
      `Authoritative Run state is unavailable for '${evidence.runId}'; Run status is reported as UNKNOWN and is not inferred from Trace events.`
    );
  }
  if (trace.health === "corrupt") {
    diagnostics.push(
      `Trace for '${evidence.runId}' failed integrity checks (${trace.diagnostics.map((d) => d.code).join(", ")}); events are withheld.`
    );
  } else if (!summary.traceAvailable) {
    diagnostics.push(`Trace events are unavailable for Run '${evidence.runId}'.`);
  }

  for (const approvalId of summary.approvalIds) {
    if (!authoritativeApprovalIds.has(approvalId)) {
      diagnostics.push(
        `Approval '${approvalId}' was referenced in Trace events, but its authoritative ApprovalRecord is unavailable; approval status is not inferred from Trace.`
      );
    }
  }

  const inspection: RunInspection = {
    ...(provenance ? { provenance } : {}),
    summary,
    ...(workflow ? { workflow } : {}),
    trace,
    approvals,
    evaluations,
    diagnostics,
  };

  return assertSafeInspectionPayload(RunInspectionSchema.parse(inspection));
}

// --- 9. Guided Integration Diagnostics Projection ---

export interface ProjectIntegrationDiagnosticsInput {
  readonly companyManifest: CompanyManifestV1 | unknown;
  readonly pack: CapabilityPack | CapabilityPackManifestV1 | unknown;
  readonly selectedByCompany?: boolean;
  readonly registrationEvidence?: TrustedProofRegistrationEvidence;
  readonly provenance?: OperatorSourceProvenance;
}

export function projectIntegrationDiagnostics(
  input: ProjectIntegrationDiagnosticsInput
): IntegrationDiagnosticReport {
  let validatedCompany;
  try {
    validatedCompany = validateCompanyManifest(input.companyManifest);
  } catch (err) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      err instanceof Error ? err.message : "Invalid company manifest for diagnostics",
      { cause: err }
    );
  }

  let pack: CapabilityPack;
  try {
    pack =
      input.pack !== null &&
      typeof input.pack === "object" &&
      "manifest" in input.pack &&
      "fingerprint" in input.pack
        ? defineCapabilityPack((input.pack as CapabilityPack).manifest)
        : defineCapabilityPack(input.pack);
  } catch (err) {
    throw new OperatorInspectionError(
      "INSPECTION_EVIDENCE_INVALID",
      err instanceof Error ? err.message : "Invalid capability pack manifest for diagnostics",
      { cause: err }
    );
  }

  const cManifest = validatedCompany.manifest;
  const pManifest = pack.manifest;
  const provenance: OperatorSourceProvenance = input.provenance ?? {
    mode: "demo",
    label: "DEMO DATA — NOT LIVE OPERATIONS",
    description: "Canonical AAO demonstration fixtures",
  };

  const compat = projectPackCompatibilitySummary({
    companyManifest: input.companyManifest,
    pack,
    selectedByCompany: input.selectedByCompany,
    registrationEvidence: input.registrationEvidence,
  });

  let reportStatus: "READY" | "BLOCKED" | "NOT_VERIFIED" | "UNAVAILABLE";
  if (compat.status === "COMPATIBLE" && compat.verified) {
    reportStatus = "READY";
  } else if (compat.status === "INCOMPATIBLE") {
    reportStatus = "BLOCKED";
  } else if (compat.status === "NOT_VERIFIED") {
    reportStatus = "NOT_VERIFIED";
  } else {
    reportStatus = "UNAVAILABLE";
  }

  // Per-requirement evidence. Each status is checked against that requirement's own
  // evidence, independently of the canonical verdict above (which stops at the first
  // failure). These diagnostics explain the verdict; they never grant readiness.
  const requirements = diagnoseRequirementsIndependently({
    company: cManifest,
    manifest: pManifest,
    evidence: input.registrationEvidence,
  });

  // Diagnostics and next steps
  const diagnostics: IntegrationDiagnostic[] = [];
  const nextSteps: string[] = [];

  if (reportStatus === "READY") {
    nextSteps.push("Capability Pack is verified and ready for governed workflow execution by this company.");
  } else if (reportStatus === "BLOCKED") {
    diagnostics.push({
      code: compat.reasonCode ?? "PACK_INCOMPATIBLE",
      category: "compatibility",
      message: compat.diagnostic ?? `Pack '${pack.identity}' is incompatible with company '${cManifest.companyId}'.`,
      remediation: getRemediationForCode(compat.reasonCode),
    });
    nextSteps.push(getRemediationForCode(compat.reasonCode));
  } else if (reportStatus === "NOT_VERIFIED") {
    diagnostics.push({
      code: "PACK_EVIDENCE_UNAVAILABLE",
      category: "verification",
      message: compat.diagnostic ?? `Trusted ProofRegistrationSnapshot evidence is unavailable for '${cManifest.companyId}' (${pack.identity}).`,
      remediation: getRemediationForCode("PACK_EVIDENCE_UNAVAILABLE"),
    });
    nextSteps.push("Supply trusted ProofRegistrationSnapshot evidence before claiming readiness.");
  } else {
    diagnostics.push({
      code: "INSPECTION_SOURCE_UNAVAILABLE",
      category: "source",
      message: "Inspection source is unavailable.",
      remediation: "Verify inspection source connectivity.",
    });
    nextSteps.push("Verify inspection source connectivity and configuration.");
  }

  const report: IntegrationDiagnosticReport = {
    companyId: cManifest.companyId,
    companyDisplayName: cManifest.displayName,
    packIdentity: pack.identity,
    packName: pManifest.name,
    workflowId: pManifest.workflow.id,
    workflowVersion: pManifest.workflow.version,
    planFingerprint: pManifest.workflow.planFingerprint,
    status: reportStatus,
    ...(compat.reasonCode ? { reasonCode: compat.reasonCode } : {}),
    requirements,
    diagnostics,
    nextSteps,
    sourceProvenance: provenance,
  };

  return assertSafeInspectionPayload(IntegrationDiagnosticReportSchema.parse(report));
}


// --- 9a. Independent per-requirement evidence ---

interface RequirementDiagnosisInput {
  readonly company: CompanyManifestV1;
  readonly manifest: CapabilityPack["manifest"];
  readonly evidence?: TrustedProofRegistrationEvidence;
}

function requirement(
  category: IntegrationRequirementDiagnostic["category"],
  name: string,
  requiredRef: string,
  status: IntegrationRequirementDiagnostic["status"],
  diagnostic?: string,
  reasonCode?: string
): IntegrationRequirementDiagnostic {
  return {
    category,
    name: name.slice(0, INSPECTION_LIMITS.MAX_STRING_LENGTH),
    requiredRef: requiredRef.slice(0, INSPECTION_LIMITS.MAX_STRING_LENGTH),
    status,
    ...(reasonCode ? { reasonCode } : {}),
    ...(diagnostic ? { diagnostic: diagnostic.slice(0, INSPECTION_LIMITS.MAX_STRING_LENGTH) } : {}),
    ...(reasonCode && status !== "SATISFIED" ? { remediation: getRemediationForCode(reasonCode) } : {}),
  };
}

/**
 * SATISFIED only with that requirement's own supporting evidence; MISSING only when
 * the evidence source is present and confirms absence; NOT_VERIFIED when the
 * evidence that would decide it is absent. Pure and deterministic.
 */
export function diagnoseRequirementsIndependently(input: RequirementDiagnosisInput): IntegrationRequirementDiagnostic[] {
  const { company, manifest: m, evidence } = input;
  const snapshot = evidence?.snapshot;
  const workflow = snapshot?.workflow ?? evidence?.workflow;
  const tools = snapshot?.tools ?? evidence?.registeredTools ?? evidence?.tools;
  const policies = snapshot?.modelPolicies ?? evidence?.registeredModelPolicies ?? evidence?.modelPolicies;
  const bindings = snapshot?.modelBindings ?? evidence?.registeredModelBindings ?? evidence?.modelBindings;
  const adapters = snapshot?.modelAdapters ?? evidence?.registeredModelAdapters ?? evidence?.modelAdapters;
  const evalProfiles = evidence?.registeredEvalProfiles;
  const out: IntegrationRequirementDiagnostic[] = [];

  // Workflow identity and pinned plan fingerprint.
  const wfRef = `${m.workflow.id}@${m.workflow.version}`;
  if (!workflow) out.push(requirement("workflow", "Workflow Pinned Plan Fingerprint", wfRef, "NOT_VERIFIED", "Prepared workflow registration evidence is unavailable."));
  else if (workflow.id !== m.workflow.id || workflow.version !== m.workflow.version || workflow.planFingerprint !== m.workflow.planFingerprint) {
    out.push(requirement("workflow", "Workflow Pinned Plan Fingerprint", wfRef, "INCOMPATIBLE", `Prepared workflow is '${workflow.id}@${workflow.version}' with a different identity or plan fingerprint.`, "PACK_WORKFLOW_MISMATCH"));
  } else out.push(requirement("workflow", "Workflow Pinned Plan Fingerprint", wfRef, "SATISFIED", "Prepared workflow identity and plan fingerprint match."));

  // Company proof enablement.
  const proof = getRequiredProofName(m.id);
  out.push((company.enabledProofs as readonly string[]).includes(proof)
    ? requirement("governance", `Proof Enabled: ${proof}`, proof, "SATISFIED", `Company enables proof '${proof}'.`)
    : requirement("governance", `Proof Enabled: ${proof}`, proof, "INCOMPATIBLE", `Company '${company.companyId}' does not enable proof '${proof}'.`, "PACK_PROOF_DISABLED"));

  // Tools: exact id@version, each independently.
  for (const t of m.requirements.toolRefs) {
    const key = `${t.id}@${t.version}`;
    if (!tools) out.push(requirement("tool", `Tool: ${key}`, key, "NOT_VERIFIED", "Tool registration evidence is unavailable."));
    else if (tools.some((r) => r.id === t.id && r.version === t.version)) out.push(requirement("tool", `Tool: ${key}`, key, "SATISFIED", "Exact Tool version is registered."));
    else if (tools.some((r) => r.id === t.id)) out.push(requirement("tool", `Tool: ${key}`, key, "INCOMPATIBLE", `Tool '${t.id}' is registered only at version(s) ${tools.filter((r) => r.id === t.id).map((r) => r.version).join(", ")}.`, "PACK_REQUIREMENT_MISSING"));
    else out.push(requirement("tool", `Tool: ${key}`, key, "MISSING", `Tool '${key}' is not registered in the host proof environment.`, "PACK_REQUIREMENT_MISSING"));
  }

  // Model policies, each independently.
  for (const pol of m.requirements.modelPolicyRefs) {
    if (!policies) out.push(requirement("model_policy", `Model Policy: ${pol}`, pol, "NOT_VERIFIED", "Model policy registration evidence is unavailable."));
    else if (policies.includes(pol)) out.push(requirement("model_policy", `Model Policy: ${pol}`, pol, "SATISFIED", "Model policy is registered."));
    else out.push(requirement("model_policy", `Model Policy: ${pol}`, pol, "MISSING", `Model policy '${pol}' is not registered in the host proof environment.`, "PACK_REQUIREMENT_MISSING"));
  }

  // Model capabilities: only real binding/adapter pairs count, and all required
  // capabilities must be met by one pair (never combined across unrelated bindings).
  const required = m.requirements.modelCapabilities;
  const pairs = (bindings ?? []).map((b) => {
    // Registered adapter list present but lacking this adapter: confirmed unsupported ([]).
    // No adapter list and no attached adapter: unverifiable (undefined).
    const adapter = adapters !== undefined
      ? adapters.find((a) => a.id === b.adapterRef.id && a.version === b.adapterRef.version)
      : b.adapter;
    if (!adapter) return adapters !== undefined ? [] : undefined;
    return b.capabilities.filter((c) => adapter.capabilities.some((ac) => ac.capability === c && ac.support === "supported"));
  });
  const singlePair = pairs.some((caps) => caps !== undefined && required.every((c) => caps.includes(c)));
  for (const cap of required) {
    if (!bindings) out.push(requirement("model_capability", `Model Capability: ${cap}`, cap, "NOT_VERIFIED", "Model binding registration evidence is unavailable."));
    else if (singlePair) out.push(requirement("model_capability", `Model Capability: ${cap}`, cap, "SATISFIED", "A single registered binding/adapter pair supports all required capabilities."));
    else if (pairs.some((caps) => caps?.includes(cap))) out.push(requirement("model_capability", `Model Capability: ${cap}`, cap, "INCOMPATIBLE", `Capability '${cap}' is supported only by a binding that does not cover all required capabilities.`, "PACK_CAPABILITY_INCOMPATIBLE"));
    else if (pairs.some((caps) => caps === undefined)) out.push(requirement("model_capability", `Model Capability: ${cap}`, cap, "NOT_VERIFIED", "A registered binding's adapter evidence is unavailable, so its support cannot be verified.", "PACK_EVIDENCE_UNAVAILABLE"));
    else out.push(requirement("model_capability", `Model Capability: ${cap}`, cap, "INCOMPATIBLE", `No registered binding/adapter pair supports '${cap}'.`, "PACK_CAPABILITY_INCOMPATIBLE"));
  }

  // Integration slots: a configured provider reference is not proof of a usable provider.
  for (const slot of m.requirements.integrationSlots) {
    const boundRef =
      slot.slot === "public_web" ? company.integrations.publicWebProviderRef
        : slot.slot === "document_source" ? company.integrations.documentSourceProviderRef
          : slot.slot === "draft_repository" ? company.integrations.draftRepositoryRef
            : undefined;
    out.push(boundRef
      ? requirement("integration", `Integration Slot: ${slot.slot}`, `${slot.slot} -> ${boundRef}`, "NOT_VERIFIED", `Provider '${boundRef}' is configured; its live availability is not verified by inspection.`)
      : requirement("integration", `Integration Slot: ${slot.slot}`, slot.slot, "MISSING", `Integration slot '${slot.slot}' is not configured for company '${company.companyId}'.`, "PACK_REQUIREMENT_MISSING"));
  }

  // Preliminary permissions: enforced by Authorization per principal at run time; role
  // configuration alone is not proof of authorization.
  out.push(requirement("governance", "Preliminary Permissions", `[${m.requirements.preliminaryPermissions.join(", ")}]`, "NOT_VERIFIED", "Permissions are authorized per principal at run time; compatibility does not verify them."));

  // Approval role configuration (not any particular Run's approval decision).
  if (m.requirements.approval?.required) {
    const roles = m.requirements.approval.requiredRoleIds;
    const undefinedRoles = roles.filter((id) => !company.governance.roles.some((r) => r.id === id));
    out.push(undefinedRoles.length === 0
      ? requirement("approval", "Human Approval Role Gate", `Roles: [${roles.join(", ")}]`, "SATISFIED", "Required approver roles are defined in company governance.")
      : requirement("approval", "Human Approval Role Gate", `Roles: [${roles.join(", ")}]`, "INCOMPATIBLE", `Approver role(s) not defined in governance: ${undefinedRoles.join(", ")}.`, "PACK_GOVERNANCE_INCOMPATIBLE"));
  }

  // Evaluation profile: registration only. Registered does not mean its Evals passed,
  // and grader definitions are not part of the registration evidence.
  const profile = m.verification.evalProfileRef;
  const profileId = profile.split("@")[0];
  if (!evalProfiles) out.push(requirement("evaluation", "Verification Profile", profile, "NOT_VERIFIED", "Evaluation profile registration evidence is unavailable."));
  else if (evalProfiles.includes(profile)) out.push(requirement("evaluation", "Verification Profile", profile, "SATISFIED", "Profile is registered (registration only; not an Eval pass)."));
  else if (evalProfiles.some((r) => r.split("@")[0] === profileId)) out.push(requirement("evaluation", "Verification Profile", profile, "INCOMPATIBLE", `Profile '${profileId}' is registered at a different version.`, "PACK_VERIFICATION_PROFILE_MISSING"));
  else out.push(requirement("evaluation", "Verification Profile", profile, "MISSING", `Evaluation profile '${profile}' is not registered.`, "PACK_VERIFICATION_PROFILE_MISSING"));

  return out;
}

// --- 10. Advanced Run Inspection Projection ---

/**
 * Token accounting over the model invocations found in `events`. One invocation is
 * one `model.call.started`; usage is read only from its single terminal
 * `model.call.completed` (a valid Trace cannot carry a duplicate). Completeness
 * follows Observability's MetricCompleteness rules, and additionally treats an
 * invocation that never finished as unknown usage.
 */
export function summarizeTokenUsage(events: readonly TraceEvent[]): TokenUsageSummary {
  let invocations = 0;
  let completed = 0;
  let failed = 0;
  let withUsage = 0;
  let anyReported = false;
  const known = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const missing = { inputTokens: false, outputTokens: false, totalTokens: false };
  for (const event of events) {
    if (event.type === "model.call.started") invocations += 1;
    else if (event.type === "model.call.failed") failed += 1;
    else if (event.type === "model.call.completed") {
      completed += 1;
      const usage = ((event.payload as Record<string, unknown>).usage ?? {}) as Partial<Record<keyof typeof known, number>>;
      for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
        const value = usage[field];
        if (value === undefined) missing[field] = true;
        else { known[field] += value; anyReported = true; }
      }
      if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) withUsage += 1;
    }
  }
  // Failed or unfinished invocations have unknown usage.
  const unknownCalls = invocations - completed;
  const exact = (field: keyof typeof known) => unknownCalls === 0 && !missing[field];
  const status: TokenUsageSummary["status"] =
    invocations === 0 || (exact("inputTokens") && exact("outputTokens") && exact("totalTokens"))
      ? "complete"
      : anyReported ? "partial" : "unavailable";
  return {
    status,
    modelInvocations: invocations,
    callsCompleted: completed,
    callsFailed: failed,
    callsWithUsage: withUsage,
    callsWithoutUsage: invocations - withUsage,
    ...(exact("inputTokens") ? { inputTokens: known.inputTokens } : {}),
    ...(exact("outputTokens") ? { outputTokens: known.outputTokens } : {}),
    ...(exact("totalTokens") ? { totalTokens: known.totalTokens } : {}),
    knownInputTokens: known.inputTokens,
    knownOutputTokens: known.outputTokens,
    knownTotalTokens: known.totalTokens,
  };
}

/** Events that belong to a node attempt; anything else (run, state, checkpoint, recovery) is run-scoped. */
const ATTEMPT_SCOPED_EVENT = /^(node\.(completed|failed|waiting)|retry\.|tool\.call\.|model\.call\.|agent\.|approval\.requested$)/;

const TERMINAL_RUN_STATUSES: readonly OperatorRunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

export function projectAdvancedRunInspection(
  evidence: KnownRunEvidence,
  provenance?: OperatorSourceProvenance
): AdvancedRunInspection {
  const baseInspection = projectRunInspection(evidence, provenance);
  const { summary, trace, approvals, evaluations, workflow } = baseInspection;

  // 1. Canonical correlation. Only a valid Trace yields attempts, counters or tokens;
  //    a corrupt or missing Trace yields none of them (never normal-looking numbers).
  interface AttemptDraft { nodeId: string; record: { kind: NodeAttemptInspection["kind"]; step: number; attempt: number; recoveryReplay: boolean; outcome: NodeAttemptInspection["status"]; startedAt: string; durationMs: number | null }; spanId: string; events: TraceEvent[] }
  const drafts: AttemptDraft[] = [];
  const unattributed: TraceEvent[] = [];
  let counters: ExecutionCounters | undefined;
  let tokenUsage: TokenUsageSummary | undefined;

  if (trace.health === "healthy" && evidence.traceEvents) {
    const metrics = deriveRunMetrics({ trace: evidence.traceEvents });
    if (!metrics.ok) {
      throw new OperatorInspectionError("INSPECTION_TRACE_CORRUPT", `Run metrics could not be derived for '${evidence.runId}' (${metrics.code}).`);
    }
    const m = metrics.metrics;
    counters = {
      traceEvents: evidence.traceEvents.length,
      nodeExecutionOccurrences: m.nodes.executions,
      nodeAttempts: m.nodes.attempts,
      recoveryReplayAttempts: m.nodes.recoveryReplayAttempts,
      toolPhysicalInvocations: m.tools.physicalInvocations,
      toolLogicalExecutions: m.tools.logicalExecutions,
      toolBlocked: m.tools.blocked,
      modelInvocations: m.models.callsStarted,
      scheduledRetries: m.retries.scheduled,
      exhaustedRetries: m.retries.exhausted,
    };
    tokenUsage = summarizeTokenUsage(evidence.traceEvents);

    // deriveRunMetrics emits one attempt record per `node.started`, in Trace order; pair
    // each with its span, then attach evidence by span (a recovery replay re-opens its
    // logical span, so later evidence belongs to the replay).
    const records = m.nodes.attemptDetails;
    const owner = new Map<string, AttemptDraft>();
    for (const event of evidence.traceEvents) {
      if (event.type === "node.started") {
        const record = records[drafts.length]!;
        const draft: AttemptDraft = { nodeId: record.nodeId, record: { ...record }, spanId: event.spanId, events: [event] };
        drafts.push(draft);
        owner.set(event.spanId, draft);
        continue;
      }
      if (!ATTEMPT_SCOPED_EVENT.test(event.type)) continue;
      const draft = (event.parentSpanId !== undefined ? owner.get(event.parentSpanId) : undefined) ?? owner.get(event.spanId);
      if (!draft) { unattributed.push(event); continue; }
      draft.events.push(event);
      owner.set(event.spanId, draft);
    }
    if (drafts.length !== records.length) {
      throw new OperatorInspectionError("INSPECTION_TRACE_CORRUPT", `Attempt correlation mismatch for '${evidence.runId}'.`);
    }
  }

  const attemptOf = (draft: AttemptDraft): NodeAttemptInspection => {
    const r = draft.record;
    const summaries = draft.events.map(projectSingleTraceEvent);
    const find = <K extends keyof TraceEventSummary>(key: K) => summaries.find((e) => e[key] !== undefined)?.[key];
    const failureCodes = summaries.filter((e) => e.reasonCode && (e.type.endsWith(".failed") || e.type.startsWith("retry.") || e.type === "tool.call.blocked"));
    const waiting = draft.events.find((e) => e.type === "node.waiting");
    const approvalId = find("approvalId") ?? (waiting ? ((waiting.payload as Record<string, unknown>).referenceId as string) : undefined);
    const toolPhysicalInvocations = draft.events.filter((e) => e.type === "tool.call.started").length;
    const modelEvents = draft.events.filter((e) => e.type.startsWith("model.call."));
    const finishedAt = r.durationMs !== null ? new Date(Date.parse(r.startedAt) + r.durationMs).toISOString() : undefined;
    const toolRef = find("toolRef");
    const modelPolicyRef = find("modelPolicyRef");
    const modelBindingId = find("modelBindingId");
    const reasonCode = failureCodes[failureCodes.length - 1]?.reasonCode;
    return {
      nodeId: draft.nodeId,
      kind: r.kind,
      step: r.step,
      attempt: r.attempt,
      spanId: draft.spanId,
      status: r.outcome,
      recoveryReplay: r.recoveryReplay,
      startedAt: r.startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      ...(r.durationMs !== null ? { durationMs: r.durationMs } : {}),
      ...(toolRef ? { toolRef } : {}),
      ...(modelPolicyRef ? { modelPolicyRef } : {}),
      ...(modelBindingId ? { modelBindingId } : {}),
      ...(approvalId ? { approvalId } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      toolPhysicalInvocations,
      modelInvocations: modelEvents.filter((e) => e.type === "model.call.started").length,
      ...(modelEvents.length > 0 ? { tokenUsage: summarizeTokenUsage(modelEvents) } : {}),
      evidenceEventIds: draft.events.slice(0, INSPECTION_LIMITS.MAX_TRACE_EVENTS).map((e) => e.eventId),
    };
  };

  const allAttempts = drafts.map(attemptOf);
  const runTerminal = TERMINAL_RUN_STATUSES.includes(summary.status) || trace.terminalEventType !== undefined;

  // 2. Node-by-node view: one entry per planned node, plus any observed unplanned node.
  const processNode = (nodeId: string, wNode: WorkflowNodeSummary | undefined, planned: boolean): NodeExecutionInspection => {
    const mine = drafts.filter((d) => d.nodeId === nodeId);
    const attempts = allAttempts.filter((a) => a.nodeId === nodeId);
    const last = attempts[attempts.length - 1];
    const executed = attempts.length > 0;
    const status: NodeExecutionInspection["status"] = !last
      ? "NOT_OBSERVED"
      : last.status === "completed"
        ? "OBSERVED_COMPLETED"
        : last.status === "failed"
          ? "OBSERVED_FAILED"
          : runTerminal ? "EVIDENCE_INCOMPLETE" : "OBSERVED_STARTED";
    const executionCount = new Set(attempts.map((a) => a.step)).size;
    const attemptCount = attempts.filter((a) => !a.recoveryReplay).length;
    const recoveryReplayCount = attempts.length - attemptCount;
    const scheduledRetries = mine.reduce((n, d) => n + d.events.filter((e) => e.type === "retry.scheduled").length, 0);
    const latest = <K extends "toolRef" | "modelPolicyRef" | "modelBindingId" | "approvalId">(key: K) => [...attempts].reverse().find((a) => a[key] !== undefined)?.[key];
    const toolRef = latest("toolRef") ?? wNode?.toolRef;
    const modelPolicyRef = latest("modelPolicyRef") ?? wNode?.modelPolicyId;
    const modelBindingId = latest("modelBindingId");
    const approvalId = latest("approvalId");
    const approvalStatus = approvalId ? approvals.find((a) => a.approvalId === approvalId)?.status : undefined;
    const modelEvents = mine.flatMap((d) => d.events.filter((e) => e.type.startsWith("model.call.")));
    const startedAt = attempts[0]?.startedAt;
    const finishedAt = last?.finishedAt;
    const durationMs = startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : undefined;

    const diagnostics: string[] = [];
    if (!planned) diagnostics.push("Node executed was not present in the compiled workflow plan.");
    if (status === "OBSERVED_FAILED") diagnostics.push(`Node execution failed${last?.reasonCode ? ` (${last.reasonCode})` : ""}.`);
    if (scheduledRetries > 0) diagnostics.push(`Node recorded ${attemptCount} attempts with ${scheduledRetries} explicitly scheduled retries.`);
    if (executionCount > 1) diagnostics.push(`Node executed at ${executionCount} distinct workflow steps (repeat executions, not retries).`);
    if (recoveryReplayCount > 0) diagnostics.push(`Node includes ${recoveryReplayCount} recovery replay attempt(s) of an already-recorded logical attempt.`);
    if (status === "EVIDENCE_INCOMPLETE") diagnostics.push("Node execution began but no terminal completion event was observed.");

    return {
      nodeId,
      nodeKind: wNode?.kind ?? last?.kind ?? "unknown",
      ...(wNode?.name ? { name: wNode.name } : {}),
      status,
      planned,
      executed,
      attempts,
      executionCount,
      attemptCount,
      recoveryReplayCount,
      scheduledRetries,
      ...(toolRef ? { toolRef } : {}),
      ...(modelPolicyRef ? { modelPolicyRef } : {}),
      ...(modelBindingId ? { modelBindingId } : {}),
      ...(approvalId ? { approvalId } : {}),
      ...(approvalStatus ? { approvalStatus } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(modelEvents.length > 0 ? { tokenUsage: summarizeTokenUsage(modelEvents) } : {}),
      diagnostics,
    };
  };

  const nodeInspections: NodeExecutionInspection[] = [];
  const plannedNodeIds = new Set<string>();
  for (const wNode of workflow?.nodes ?? []) {
    plannedNodeIds.add(wNode.id);
    nodeInspections.push(processNode(wNode.id, wNode, true));
  }
  for (const nodeId of new Set(drafts.map((d) => d.nodeId))) {
    if (!plannedNodeIds.has(nodeId)) nodeInspections.push(processNode(nodeId, undefined, false));
  }

  // 3. Run diagnostics.
  const diagnostics: RunDiagnostic[] = [];

  if (summary.statusSource === "unavailable") {
    diagnostics.push({
      code: "AUTHORITATIVE_STATE_UNAVAILABLE",
      severity: "warning",
      observed: `Authoritative Run state is unavailable for '${evidence.runId}'.`,
      explanation: "Run status is reported as UNKNOWN and is not inferred from Trace events alone.",
      suggestedCheck: "Verify runtime and durability store persistence for this run.",
    });
  }

  if (trace.health === "corrupt") {
    diagnostics.push({
      code: "TRACE_CORRUPT",
      severity: "error",
      observed: `Trace for '${evidence.runId}' failed integrity checks.`,
      explanation: `Trace integrity validation detected issues: ${trace.diagnostics.map((d) => d.code).join(", ")}. No attempts, counters or token totals are derived from corrupt evidence.`,
      suggestedCheck: "Inspect trace recorder logs and storage integrity.",
    });
  } else if (!summary.traceAvailable) {
    diagnostics.push({
      code: "TRACE_UNAVAILABLE",
      severity: "warning",
      observed: `Trace events are unavailable for Run '${evidence.runId}'.`,
      explanation: "No trace events were recorded or retrieved for this execution.",
      suggestedCheck: "Check trace recorder configuration and store connectivity.",
    });
  }

  if (
    trace.health === "healthy" &&
    trace.terminalEventType === undefined &&
    TERMINAL_RUN_STATUSES.includes(summary.status)
  ) {
    diagnostics.push({
      code: "TRACE_INCOMPLETE",
      severity: "warning",
      observed: "Trace does not record a terminal event (run.completed / run.failed).",
      explanation: "The run reached terminal status in runtime, but the trace buffer was not cleanly closed with a terminal event.",
      suggestedCheck: "Inspect worker process termination logs and trace flushing.",
    });
  }

  for (const n of nodeInspections) {
    if (n.status === "OBSERVED_FAILED") {
      const failedAttempt = [...n.attempts].reverse().find((a) => a.status === "failed");
      diagnostics.push(describeRunFailure(failedAttempt?.reasonCode, {
        nodeId: n.nodeId,
        toolRef: n.toolRef,
        modelPolicyRef: n.modelPolicyRef,
      }));
    }
    if (n.scheduledRetries > 0) {
      diagnostics.push({
        code: "RETRIES_OBSERVED",
        severity: "info",
        observed: `Node '${n.nodeId}' recorded ${n.attemptCount} attempts after ${n.scheduledRetries} explicitly scheduled retries.`,
        explanation: "The Runtime scheduled retries after retryable attempt failures (retry.scheduled evidence).",
        suggestedCheck: "Review upstream tool reliability and timeout settings.",
      });
    }
    if (n.executionCount > 1) {
      diagnostics.push({
        code: "NODE_REPEATED",
        severity: "info",
        observed: `Node '${n.nodeId}' executed at ${n.executionCount} distinct workflow steps.`,
        explanation: "Each workflow step is a separate execution occurrence; repeat executions are not retries.",
        suggestedCheck: "Confirm the workflow routing intends to revisit this node.",
      });
    }
  }

  for (const a of allAttempts) {
    if (a.status === "retried" && !allAttempts.some((b) => b.nodeId === a.nodeId && b.step === a.step && b.attempt === a.attempt + 1)) {
      diagnostics.push({
        code: "RETRY_NOT_STARTED",
        severity: "warning",
        observed: `Retry of node '${a.nodeId}' (step ${a.step}) to attempt ${a.attempt + 1} was scheduled but never observed starting.`,
        explanation: "The Trace ends before the scheduled attempt began; its outcome is unknown.",
        suggestedCheck: "Inspect worker termination and durable recovery for this run.",
      });
    }
  }

  if (unattributed.length > 0) {
    diagnostics.push({
      code: "UNATTRIBUTED_EVIDENCE",
      severity: "warning",
      observed: `${unattributed.length} Trace event(s) could not be attributed to an observed node attempt.`,
      explanation: "These events carry no span relationship to any recorded node.started; they are listed separately and not counted against any node.",
      suggestedCheck: "Inspect span propagation in the emitting adapter.",
    });
  }

  if (tokenUsage && tokenUsage.status === "unavailable") {
    diagnostics.push({
      code: "TOKEN_USAGE_NOT_RECORDED",
      severity: "info",
      observed: `None of ${tokenUsage.modelInvocations} model invocation(s) recorded token usage.`,
      explanation: "The model adapter or provider did not report token usage metadata.",
      suggestedCheck: "Verify model adapter usage reporting configuration.",
    });
  } else if (tokenUsage && tokenUsage.status === "partial") {
    diagnostics.push({
      code: "TOKEN_USAGE_PARTIAL",
      severity: "info",
      observed: `${tokenUsage.callsWithUsage} of ${tokenUsage.modelInvocations} model invocation(s) recorded usage; totals are known recorded totals only.`,
      explanation: "Failed, unfinished, or usage-less invocations make run-level token accounting partial.",
      suggestedCheck: "Verify model adapter usage reporting configuration.",
    });
  }

  // Authoritative approval gap checks
  const authoritativeApprovalIds = new Set(approvals.map((a) => a.approvalId));
  for (const approvalId of summary.approvalIds) {
    if (!authoritativeApprovalIds.has(approvalId)) {
      diagnostics.push({
        code: "APPROVAL_RECORD_MISSING",
        severity: "warning",
        observed: `Approval '${approvalId}' was referenced in Trace events, but its authoritative ApprovalRecord is missing.`,
        explanation: "Approval decision status cannot be inferred from trace events alone.",
        suggestedCheck: "Inspect approval store and workflow approval bindings.",
      });
    }
  }

  const unattributedEvents: UnattributedEvent[] = unattributed.slice(0, INSPECTION_LIMITS.MAX_TRACE_EVENTS).map((e) => ({
    sequence: e.sequence,
    eventId: e.eventId,
    type: e.type,
    ...(e.nodeId ? { nodeId: e.nodeId } : {}),
  }));

  const advancedInspection: AdvancedRunInspection = {
    runId: summary.runId,
    workflowId: summary.workflowId,
    workflowVersion: summary.workflowVersion,
    ...(summary.companyId ? { companyId: summary.companyId } : {}),
    ...(summary.packIdentity ? { packIdentity: summary.packIdentity } : {}),
    authoritativeStatus: summary.status,
    statusSource: summary.statusSource,
    ...(summary.statusReason ? { statusReason: summary.statusReason } : {}),
    evidenceHealth: trace.health,
    eventCount: trace.eventCount,
    nodes: nodeInspections,
    attempts: allAttempts.slice(0, INSPECTION_LIMITS.MAX_TRACE_EVENTS),
    attemptsTruncated: allAttempts.length > INSPECTION_LIMITS.MAX_TRACE_EVENTS,
    ...(counters ? { counters } : {}),
    unattributedEvents,
    approvals,
    evaluations,
    ...(tokenUsage ? { tokenUsage } : {}),
    diagnostics,
    provenance: provenance ?? (baseInspection.provenance ?? {
      mode: "demo",
      label: "DEMO DATA — NOT LIVE OPERATIONS",
      description: "Canonical AAO demonstration fixtures",
    }),
  };

  return assertSafeInspectionPayload(AdvancedRunInspectionSchema.parse(advancedInspection));
}
