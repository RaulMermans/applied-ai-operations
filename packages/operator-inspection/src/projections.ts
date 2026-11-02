import { createHash } from "node:crypto";
import {
  ApprovalRecordSchema,
  RunRecordSchema,
  TRACE_TERMINAL_EVENT_TYPES,
  WorkflowSchema,
  canonicalJsonStringify,
  type ApprovalRecord,
  type ApprovalStatus,
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
import { validateTrace } from "@aao/observability";
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
  type ExecutionAttemptSummary,
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
  const evalProfiles = evidence.registeredEvalProfiles ?? [];

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
      registeredEvalProfiles: evalProfiles as readonly string[],
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

  const requirements: IntegrationRequirementDiagnostic[] = [];

  // 1. Workflow
  const wfMismatch = compat.reasonCode === "PACK_WORKFLOW_MISMATCH";
  const proofDisabled = compat.reasonCode === "PACK_PROOF_DISABLED";
  requirements.push({
    category: "workflow",
    name: "Workflow Pinned Plan Fingerprint",
    requiredRef: `${pManifest.workflow.id}@${pManifest.workflow.version}`,
    status:
      reportStatus === "READY"
        ? "SATISFIED"
        : wfMismatch || proofDisabled
          ? "INCOMPATIBLE"
          : reportStatus === "NOT_VERIFIED"
            ? "NOT_VERIFIED"
            : "SATISFIED",
    ...(wfMismatch ? { reasonCode: "PACK_WORKFLOW_MISMATCH", diagnostic: compat.diagnostic, remediation: getRemediationForCode("PACK_WORKFLOW_MISMATCH") } : {}),
  });

  // 2. Tools
  const evidenceTools = input.registrationEvidence?.snapshot?.tools ?? input.registrationEvidence?.registeredTools ?? input.registrationEvidence?.tools;
  const registeredToolKeys = new Set(
    (evidenceTools ?? []).map((t) => `${t.id}@${t.version}`)
  );
  for (const t of pManifest.requirements.toolRefs) {
    const key = `${t.id}@${t.version}`;
    const missing =
      compat.reasonCode === "PACK_REQUIREMENT_MISSING" &&
      (!evidenceTools || !registeredToolKeys.has(key));
    requirements.push({
      category: "tool",
      name: `Tool: ${key}`,
      requiredRef: key,
      status:
        reportStatus === "READY"
          ? "SATISFIED"
          : missing
            ? "MISSING"
            : proofDisabled
              ? "INCOMPATIBLE"
              : reportStatus === "NOT_VERIFIED"
                ? "NOT_VERIFIED"
                : "SATISFIED",
      ...(missing ? { reasonCode: "PACK_REQUIREMENT_MISSING", diagnostic: `Tool '${key}' is not registered in the host proof environment.`, remediation: getRemediationForCode("PACK_REQUIREMENT_MISSING") } : {}),
    });
  }

  // 3. Model Policies
  const evidencePolicies = input.registrationEvidence?.snapshot?.modelPolicies ?? input.registrationEvidence?.registeredModelPolicies ?? input.registrationEvidence?.modelPolicies;
  const registeredPolicies = new Set(evidencePolicies ?? []);
  for (const pol of pManifest.requirements.modelPolicyRefs) {
    const missing =
      compat.reasonCode === "PACK_REQUIREMENT_MISSING" &&
      (!evidencePolicies || !registeredPolicies.has(pol));
    requirements.push({
      category: "model_policy",
      name: `Model Policy: ${pol}`,
      requiredRef: pol,
      status:
        reportStatus === "READY"
          ? "SATISFIED"
          : missing
            ? "MISSING"
            : proofDisabled
              ? "INCOMPATIBLE"
              : reportStatus === "NOT_VERIFIED"
                ? "NOT_VERIFIED"
                : "SATISFIED",
      ...(missing ? { reasonCode: "PACK_REQUIREMENT_MISSING", diagnostic: `Model policy '${pol}' is not registered in the host proof environment.`, remediation: getRemediationForCode("PACK_REQUIREMENT_MISSING") } : {}),
    });
  }

  // 4. Model Capabilities
  const capIncompatible = compat.reasonCode === "PACK_CAPABILITY_INCOMPATIBLE";
  for (const cap of pManifest.requirements.modelCapabilities) {
    requirements.push({
      category: "model_capability",
      name: `Model Capability: ${cap}`,
      requiredRef: cap,
      status:
        reportStatus === "READY"
          ? "SATISFIED"
          : capIncompatible || proofDisabled
            ? "INCOMPATIBLE"
            : reportStatus === "NOT_VERIFIED"
              ? "NOT_VERIFIED"
              : "SATISFIED",
      ...(capIncompatible ? { reasonCode: "PACK_CAPABILITY_INCOMPATIBLE", diagnostic: compat.diagnostic, remediation: getRemediationForCode("PACK_CAPABILITY_INCOMPATIBLE") } : {}),
    });
  }

  // 5. Integration Slots
  for (const slot of pManifest.requirements.integrationSlots) {
    let boundRef: string | undefined;
    if (slot.slot === "public_web") boundRef = cManifest.integrations.publicWebProviderRef;
    else if (slot.slot === "document_source") boundRef = cManifest.integrations.documentSourceProviderRef;
    else if (slot.slot === "draft_repository") boundRef = cManifest.integrations.draftRepositoryRef;

    const isSlotMissing = !boundRef;
    requirements.push({
      category: "integration",
      name: `Integration Slot: ${slot.slot}`,
      requiredRef: boundRef ? `${slot.slot} -> ${boundRef}` : slot.slot,
      status:
        isSlotMissing
          ? "MISSING"
          : reportStatus === "READY"
            ? "SATISFIED"
            : reportStatus === "NOT_VERIFIED"
              ? "NOT_VERIFIED"
              : "SATISFIED",
      ...(isSlotMissing
        ? {
            reasonCode: "PACK_REQUIREMENT_MISSING",
            diagnostic: `Integration slot '${slot.slot}' is not configured for company '${cManifest.companyId}'.`,
            remediation: getRemediationForCode("PACK_REQUIREMENT_MISSING"),
          }
        : reportStatus === "NOT_VERIFIED"
          ? {
              diagnostic: `Provider binding '${boundRef}' is configured, but registration snapshot evidence is unavailable.`,
            }
          : {}),
    });
  }

  // 6. Governance Preliminary Permissions
  requirements.push({
    category: "governance",
    name: "Preliminary Permissions",
    requiredRef: `[${pManifest.requirements.preliminaryPermissions.join(", ")}]`,
    status:
      reportStatus === "READY"
        ? "SATISFIED"
        : proofDisabled
          ? "INCOMPATIBLE"
          : reportStatus === "NOT_VERIFIED"
            ? "NOT_VERIFIED"
            : "SATISFIED",
  });

  // 7. Approval Requirements
  if (pManifest.requirements.approval && pManifest.requirements.approval.required) {
    const govIncompatible = compat.reasonCode === "PACK_GOVERNANCE_INCOMPATIBLE";
    requirements.push({
      category: "approval",
      name: "Human Approval Role Gate",
      requiredRef: `Roles: [${pManifest.requirements.approval.requiredRoleIds.join(", ")}]`,
      status:
        reportStatus === "READY"
          ? "SATISFIED"
          : govIncompatible || proofDisabled
            ? "INCOMPATIBLE"
            : reportStatus === "NOT_VERIFIED"
              ? "NOT_VERIFIED"
              : "SATISFIED",
      ...(govIncompatible ? { reasonCode: "PACK_GOVERNANCE_INCOMPATIBLE", diagnostic: compat.diagnostic, remediation: getRemediationForCode("PACK_GOVERNANCE_INCOMPATIBLE") } : {}),
    });
  }

  // 8. Evaluation Profile
  const evalMissing = compat.reasonCode === "PACK_VERIFICATION_PROFILE_MISSING";
  requirements.push({
    category: "evaluation",
    name: "Verification Profile",
    requiredRef: pManifest.verification.evalProfileRef,
    status:
      reportStatus === "READY"
        ? "SATISFIED"
        : evalMissing
          ? "MISSING"
          : proofDisabled
            ? "INCOMPATIBLE"
            : reportStatus === "NOT_VERIFIED"
              ? "NOT_VERIFIED"
              : "SATISFIED",
    ...(evalMissing ? { reasonCode: "PACK_VERIFICATION_PROFILE_MISSING", diagnostic: compat.diagnostic, remediation: getRemediationForCode("PACK_VERIFICATION_PROFILE_MISSING") } : {}),
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

// --- 10. Advanced Run Inspection Projection ---

export function projectAdvancedRunInspection(
  evidence: KnownRunEvidence,
  provenance?: OperatorSourceProvenance
): AdvancedRunInspection {
  const baseInspection = projectRunInspection(evidence, provenance);
  const summary = baseInspection.summary;
  const trace = baseInspection.trace;
  const approvals = baseInspection.approvals;
  const evaluations = baseInspection.evaluations;
  const workflow = baseInspection.workflow;

  // 1. Token usage aggregation
  let hasTokenUsage = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;

  for (const ev of trace.events) {
    if (ev.tokenUsage) {
      hasTokenUsage = true;
      if (typeof ev.tokenUsage.inputTokens === "number") totalInputTokens += ev.tokenUsage.inputTokens;
      if (typeof ev.tokenUsage.outputTokens === "number") totalOutputTokens += ev.tokenUsage.outputTokens;
      if (typeof ev.tokenUsage.totalTokens === "number") totalTokens += ev.tokenUsage.totalTokens;
    }
  }

  const tokenUsage: TokenUsageSummary = hasTokenUsage
    ? {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalTokens,
        recorded: true,
      }
    : { recorded: false };

  // 2. Map trace events by nodeId and collect attempts
  const eventsByNodeId = new Map<string, TraceEventSummary[]>();
  const executionAttempts: ExecutionAttemptSummary[] = [];

  for (const ev of trace.events) {
    if (ev.nodeId) {
      let list = eventsByNodeId.get(ev.nodeId);
      if (!list) {
        list = [];
        eventsByNodeId.set(ev.nodeId, list);
      }
      list.push(ev);
    }

    if (
      ev.type.startsWith("tool.call.") ||
      ev.type.startsWith("model.call.") ||
      ev.type.startsWith("node.") ||
      ev.type.startsWith("approval.")
    ) {
      let kind = "node";
      if (ev.type.startsWith("tool.call.")) kind = "tool";
      else if (ev.type.startsWith("model.call.")) kind = "model";
      else if (ev.type.startsWith("approval.")) kind = "approval";

      executionAttempts.push({
        sequence: ev.sequence,
        ...(ev.nodeId ? { nodeId: ev.nodeId } : {}),
        kind,
        attempt: ev.attempt ?? 1,
        status: ev.status ?? ev.type,
        ...(ev.reasonCode ? { reasonCode: ev.reasonCode } : {}),
        ...(ev.recoveryReplay !== undefined ? { recoveryReplay: ev.recoveryReplay } : {}),
        occurredAt: ev.occurredAt,
      });
    }
  }

  // 3. Node-by-node execution inspection
  const nodeInspections: NodeExecutionInspection[] = [];
  const plannedNodeIds = new Set<string>();

  const processNodeEvents = (
    nodeId: string,
    wNode: WorkflowNodeSummary | undefined,
    planned: boolean
  ): NodeExecutionInspection => {
    const nodeEvents = eventsByNodeId.get(nodeId) ?? [];
    const executed = nodeEvents.length > 0;

    // Group events by attempt
    const attemptMap = new Map<number, TraceEventSummary[]>();
    for (const ev of nodeEvents) {
      const attNum = ev.attempt ?? 1;
      let attEvents = attemptMap.get(attNum);
      if (!attEvents) {
        attEvents = [];
        attemptMap.set(attNum, attEvents);
      }
      attEvents.push(ev);
    }

    const attempts: NodeAttemptInspection[] = [];
    const attemptNumbers = [...attemptMap.keys()].sort((a, b) => a - b);

    let nodeStartedAt: string | undefined;
    let nodeFinishedAt: string | undefined;
    let nodeToolRef: string | undefined = wNode?.toolRef;
    let nodeModelPolicyRef = wNode?.modelPolicyId;
    let nodeModelBindingId: string | undefined;
    let nodeApprovalId: string | undefined;
    let nodeApprovalStatus: ApprovalStatus | undefined;
    let nodeHasTokenUsage = false;
    let nodeInputTokens = 0;
    let nodeOutputTokens = 0;
    let nodeTotalTokens = 0;
    let nodeFailedCode: string | undefined;

    for (const attNum of attemptNumbers) {
      const attEvents = attemptMap.get(attNum)!;
      const first = attEvents[0]!;
      const last = attEvents[attEvents.length - 1]!;

      if (!nodeStartedAt) nodeStartedAt = first.occurredAt;

      let attKind: NodeAttemptInspection["kind"] = "unknown";
      if (wNode?.kind === "tool" || attEvents.some((e) => e.type.startsWith("tool.") || e.toolRef)) {
        attKind = "tool";
      } else if (wNode?.kind === "model" || attEvents.some((e) => e.type.startsWith("model.") || e.modelPolicyRef)) {
        attKind = "model";
      } else if (wNode?.kind === "approval" || attEvents.some((e) => e.type.startsWith("approval.") || e.approvalId)) {
        attKind = "approval";
      } else if (wNode?.kind) {
        attKind = "node";
      }

      let attStatus: NodeAttemptInspection["status"] = "started";
      if (attEvents.some((e) => e.type === "node.completed" || e.type.endsWith(".completed") || e.status === "succeeded")) {
        attStatus = "completed";
        nodeFinishedAt = last.occurredAt;
      } else if (attEvents.some((e) => e.type === "node.failed" || e.type.endsWith(".failed") || e.status === "failed")) {
        attStatus = "failed";
        nodeFinishedAt = last.occurredAt;
      } else if (attEvents.some((e) => e.type === "node.waiting" || e.type === "approval.requested")) {
        attStatus = "waiting";
      }

      const attToolRef = attEvents.find((e) => e.toolRef)?.toolRef ?? wNode?.toolRef;
      if (attToolRef) nodeToolRef = attToolRef;

      const attModelPolicyRef = attEvents.find((e) => e.modelPolicyRef)?.modelPolicyRef ?? wNode?.modelPolicyId;
      if (attModelPolicyRef) nodeModelPolicyRef = attModelPolicyRef;

      const attModelBindingId = attEvents.find((e) => e.modelBindingId)?.modelBindingId;
      if (attModelBindingId) nodeModelBindingId = attModelBindingId;

      const attApprovalId = attEvents.find((e) => e.approvalId)?.approvalId;
      if (attApprovalId) nodeApprovalId = attApprovalId;

      const attReasonCode = attEvents.find((e) => e.reasonCode)?.reasonCode;
      if (attReasonCode && attStatus === "failed") nodeFailedCode = attReasonCode;

      const attRecoveryReplay = attEvents.some((e) => e.recoveryReplay === true);

      let attTokenUsage: TokenUsageSummary | undefined;
      const usageEv = attEvents.find((e) => e.tokenUsage);
      if (usageEv && usageEv.tokenUsage) {
        nodeHasTokenUsage = true;
        if (usageEv.tokenUsage.inputTokens !== undefined) nodeInputTokens += usageEv.tokenUsage.inputTokens;
        if (usageEv.tokenUsage.outputTokens !== undefined) nodeOutputTokens += usageEv.tokenUsage.outputTokens;
        if (usageEv.tokenUsage.totalTokens !== undefined) nodeTotalTokens += usageEv.tokenUsage.totalTokens;
        attTokenUsage = {
          ...(usageEv.tokenUsage.inputTokens !== undefined ? { inputTokens: usageEv.tokenUsage.inputTokens } : {}),
          ...(usageEv.tokenUsage.outputTokens !== undefined ? { outputTokens: usageEv.tokenUsage.outputTokens } : {}),
          ...(usageEv.tokenUsage.totalTokens !== undefined ? { totalTokens: usageEv.tokenUsage.totalTokens } : {}),
          recorded: true,
        };
      }

      const attStartedAt = first.occurredAt;
      const attFinishedAt = attStatus === "completed" || attStatus === "failed" ? last.occurredAt : undefined;
      let attDurationMs: number | undefined;
      if (attStartedAt && attFinishedAt) {
        const ms = Date.parse(attFinishedAt) - Date.parse(attStartedAt);
        if (!Number.isNaN(ms) && ms >= 0) attDurationMs = ms;
      }

      attempts.push({
        attempt: attNum,
        kind: attKind,
        status: attStatus,
        startedAt: attStartedAt,
        ...(attFinishedAt ? { finishedAt: attFinishedAt } : {}),
        ...(attDurationMs !== undefined ? { durationMs: attDurationMs } : {}),
        ...(attToolRef ? { toolRef: attToolRef } : {}),
        ...(attModelPolicyRef ? { modelPolicyRef: attModelPolicyRef } : {}),
        ...(attModelBindingId ? { modelBindingId: attModelBindingId } : {}),
        ...(attApprovalId ? { approvalId: attApprovalId } : {}),
        ...(attReasonCode ? { reasonCode: attReasonCode } : {}),
        ...(attRecoveryReplay ? { recoveryReplay: true } : {}),
        ...(attTokenUsage ? { tokenUsage: attTokenUsage } : {}),
      });
    }

    // Determine overall node status conservatively
    let nodeStatus: NodeExecutionInspection["status"];
    if (!executed) {
      nodeStatus = "NOT_OBSERVED";
    } else if (nodeEvents.some((e) => e.type === "node.completed")) {
      nodeStatus = "OBSERVED_COMPLETED";
    } else if (nodeEvents.some((e) => e.type === "node.failed") || attempts.some((a) => a.status === "failed")) {
      nodeStatus = "OBSERVED_FAILED";
    } else {
      const isTerminalRun =
        summary.status === "COMPLETED" ||
        summary.status === "FAILED" ||
        summary.status === "CANCELLED" ||
        trace.terminalEventType !== undefined;
      if (isTerminalRun) {
        nodeStatus = "EVIDENCE_INCOMPLETE";
      } else {
        nodeStatus = "OBSERVED_STARTED";
      }
    }

    // Approvals correlation
    if (nodeApprovalId) {
      const matchedApproval = approvals.find((a) => a.approvalId === nodeApprovalId);
      if (matchedApproval) {
        nodeApprovalStatus = matchedApproval.status;
      }
    }

    let nodeDurationMs: number | undefined;
    if (nodeStartedAt && nodeFinishedAt) {
      const ms = Date.parse(nodeFinishedAt) - Date.parse(nodeStartedAt);
      if (!Number.isNaN(ms) && ms >= 0) nodeDurationMs = ms;
    }

    const nodeDiagnostics: string[] = [];
    if (!planned) {
      nodeDiagnostics.push("Node executed was not present in the compiled workflow plan.");
    }
    if (nodeStatus === "OBSERVED_FAILED") {
      nodeDiagnostics.push(`Node execution failed${nodeFailedCode ? ` (${nodeFailedCode})` : ""}.`);
    }
    if (attempts.length > 1) {
      nodeDiagnostics.push(`Node recorded ${attempts.length} execution attempts (retries observed).`);
    }
    if (nodeStatus === "EVIDENCE_INCOMPLETE") {
      nodeDiagnostics.push("Node execution began but no terminal completion event was observed.");
    }

    return {
      nodeId,
      nodeKind: wNode?.kind ?? "unknown",
      ...(wNode?.name ? { name: wNode.name } : {}),
      status: nodeStatus,
      planned,
      executed,
      attempts,
      totalAttempts: attempts.length,
      ...(nodeToolRef ? { toolRef: nodeToolRef } : {}),
      ...(nodeModelPolicyRef ? { modelPolicyRef: nodeModelPolicyRef } : {}),
      ...(nodeModelBindingId ? { modelBindingId: nodeModelBindingId } : {}),
      ...(nodeApprovalId ? { approvalId: nodeApprovalId } : {}),
      ...(nodeApprovalStatus ? { approvalStatus: nodeApprovalStatus } : {}),
      ...(nodeStartedAt ? { startedAt: nodeStartedAt } : {}),
      ...(nodeFinishedAt ? { finishedAt: nodeFinishedAt } : {}),
      ...(nodeDurationMs !== undefined ? { durationMs: nodeDurationMs } : {}),
      ...(nodeHasTokenUsage
        ? {
            tokenUsage: {
              inputTokens: nodeInputTokens,
              outputTokens: nodeOutputTokens,
              totalTokens: nodeTotalTokens,
              recorded: true,
            },
          }
        : {}),
      diagnostics: nodeDiagnostics,
    };
  };

  if (workflow?.nodes) {
    for (const wNode of workflow.nodes) {
      plannedNodeIds.add(wNode.id);
      nodeInspections.push(processNodeEvents(wNode.id, wNode, true));
    }
  }

  // Include any extra nodes observed in trace that were not in planned nodes
  for (const [nodeId] of eventsByNodeId) {
    if (!plannedNodeIds.has(nodeId)) {
      nodeInspections.push(processNodeEvents(nodeId, undefined, false));
    }
  }

  // 4. Collect Run Diagnostics
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
      explanation: `Trace integrity validation detected issues: ${trace.diagnostics.map((d) => d.code).join(", ")}.`,
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
    (summary.status === "COMPLETED" || summary.status === "FAILED" || summary.status === "CANCELLED")
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
      const failedAttempt = n.attempts.find((a) => a.status === "failed");
      diagnostics.push(describeRunFailure(failedAttempt?.reasonCode, {
        nodeId: n.nodeId,
        toolRef: n.toolRef,
        modelPolicyRef: n.modelPolicyRef,
      }));
    }
    if (n.totalAttempts > 1) {
      diagnostics.push({
        code: "RETRIES_OBSERVED",
        severity: "info",
        observed: `Node '${n.nodeId}' required ${n.totalAttempts} attempts.`,
        explanation: "Transient or recoverable failures triggered execution retries.",
        suggestedCheck: "Review upstream tool reliability and timeout settings.",
      });
    }
  }

  const modelCallsObserved = trace.events.some((e) => e.type.startsWith("model.call."));
  if (modelCallsObserved && !tokenUsage.recorded) {
    diagnostics.push({
      code: "TOKEN_USAGE_NOT_RECORDED",
      severity: "info",
      observed: "Model invocation token usage was not recorded.",
      explanation: "The model adapter or provider did not report token usage metadata.",
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
    attempts: executionAttempts,
    approvals,
    evaluations,
    tokenUsage,
    diagnostics,
    provenance: provenance ?? (baseInspection.provenance ?? {
      mode: "demo",
      label: "DEMO DATA — NOT LIVE OPERATIONS",
      description: "Canonical AAO demonstration fixtures",
    }),
  };

  return assertSafeInspectionPayload(AdvancedRunInspectionSchema.parse(advancedInspection));
}
