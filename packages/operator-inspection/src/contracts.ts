import { z } from "zod";
import {
  ApprovalIdSchema,
  ApprovalStatusSchema,
  CapabilityIdSchema,
  ModelPolicyIdSchema,
  NodeIdSchema,
  NodeKindSchema,
  PermissionClassesSchema,
  PrincipalSchema,
  RunIdSchema,
  SpanIdSchema,
  ToolIdSchema,
  TraceEventIdSchema,
  TraceEventTypeSchema,
  TraceIdSchema,
  TraceStatusSchema,
  WorkflowIdSchema,
  entityVersionSchema,
  identifierSchema,
  isoTimestampSchema,
} from "@aao/contracts";
import { FORBIDDEN_TRACE_KEYS } from "@aao/observability";

export const INSPECTION_LIMITS = Object.freeze({
  MAX_LISTED_RUNS: 100,
  MAX_TRACE_EVENTS: 500,
  MAX_RESPONSE_BYTES: 512 * 1024,
  MAX_STRING_LENGTH: 512,
  MAX_COLLECTION_ITEMS: 200,
});

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/);
const boundedTextSchema = z.string().min(1).max(INSPECTION_LIMITS.MAX_STRING_LENGTH);

export const SourceAvailabilityStatusSchema = z.enum([
  "available",
  "unavailable",
  "degraded",
  "invalid",
]);
export type SourceAvailabilityStatus = z.infer<typeof SourceAvailabilityStatusSchema>;

export const OperatorSourceModeSchema = z.enum(["demo", "live", "unavailable"]);
export type OperatorSourceMode = z.infer<typeof OperatorSourceModeSchema>;

export const OperatorSourceProvenanceSchema = z
  .object({
    mode: OperatorSourceModeSchema,
    label: z.string().min(1).max(INSPECTION_LIMITS.MAX_STRING_LENGTH),
    description: boundedTextSchema.optional(),
  })
  .strict();
export type OperatorSourceProvenance = z.infer<typeof OperatorSourceProvenanceSchema>;

export const SourceStatusSummarySchema = z
  .object({
    sourceId: z.enum([
      "companies",
      "capabilityPacks",
      "packCompatibility",
      "workflows",
      "runs",
      "traces",
      "approvals",
      "evaluations",
    ]),
    status: SourceAvailabilityStatusSchema,
    reasonCode: z.string().max(128).optional(),
    diagnostic: boundedTextSchema.optional(),
  })
  .strict();
export type SourceStatusSummary = z.infer<typeof SourceStatusSummarySchema>;

// --- 1. Company Inspection ---

export const CompanyIntegrationRefsSummarySchema = z
  .object({
    publicWebProviderRef: identifierSchema.optional(),
    documentSourceProviderRef: identifierSchema.optional(),
    draftRepositoryRef: identifierSchema.optional(),
  })
  .strict();
export type CompanyIntegrationRefsSummary = z.infer<typeof CompanyIntegrationRefsSummarySchema>;

export const CompanySummarySchema = z
  .object({
    companyId: identifierSchema,
    displayName: z.string().min(1).max(120),
    schemaVersion: z.literal(1),
    configurationFingerprint: hex64Schema,
    enabledProofs: z.array(
      z.enum(["company_research", "document_intelligence", "operational_request"])
    ),
    enabledPackCount: z.number().int().nonnegative(),
    verifiedCompatiblePackCount: z.number().int().nonnegative(),
    modelBindingRefs: z.array(identifierSchema),
    integrationRefs: CompanyIntegrationRefsSummarySchema,
  })
  .strict();
export type CompanySummary = z.infer<typeof CompanySummarySchema>;

// --- 2. Capability Pack Inspection ---

export const PackToolRefSummarySchema = z
  .object({
    id: ToolIdSchema,
    version: entityVersionSchema,
  })
  .strict();

export const PackIntegrationSlotSummarySchema = z
  .object({
    slot: z.string().min(1).max(64),
    description: z.string().min(1).max(300),
  })
  .strict();

export const PackApprovalRequirementSummarySchema = z
  .object({
    required: z.boolean(),
    requiredRoleIds: z.array(identifierSchema).optional(),
    permissionClasses: PermissionClassesSchema.optional(),
  })
  .strict();

export const CapabilityPackSummarySchema = z
  .object({
    id: identifierSchema,
    version: entityVersionSchema,
    identity: z.string().min(3).max(200),
    packFingerprint: hex64Schema,
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(1000),
    category: z.string().min(1).max(64),
    tags: z.array(z.string().min(1).max(64)),
    outcomeClass: z.enum(["read_only", "draft_only"]),
    workflow: z
      .object({
        id: WorkflowIdSchema,
        version: entityVersionSchema,
        planFingerprint: hex64Schema,
      })
      .strict(),
    requirements: z
      .object({
        toolRefs: z.array(PackToolRefSummarySchema),
        modelPolicyRefs: z.array(ModelPolicyIdSchema),
        modelCapabilities: z.array(CapabilityIdSchema),
        integrationSlots: z.array(PackIntegrationSlotSummarySchema),
        preliminaryPermissions: PermissionClassesSchema,
        approval: PackApprovalRequirementSummarySchema,
      })
      .strict(),
    evalProfileRef: z.string().min(3).max(200),
  })
  .strict();
export type CapabilityPackSummary = z.infer<typeof CapabilityPackSummarySchema>;

// --- 3. Verified Compatibility Inspection ---

export const PackCompatibilityStatusSchema = z.enum([
  "COMPATIBLE",
  "INCOMPATIBLE",
  "NOT_VERIFIED",
  "UNAVAILABLE",
]);
export type PackCompatibilityStatus = z.infer<typeof PackCompatibilityStatusSchema>;

export const VerifiedRequirementsSummarySchema = z
  .object({
    tools: z.number().int().nonnegative(),
    modelPolicies: z.number().int().nonnegative(),
    modelCapabilities: z.number().int().nonnegative(),
    integrations: z.number().int().nonnegative(),
    evalProfiles: z.number().int().nonnegative(),
  })
  .strict();
export type VerifiedRequirementsSummary = z.infer<typeof VerifiedRequirementsSummarySchema>;

export const PackCompatibilitySummarySchema = z
  .object({
    companyId: identifierSchema,
    packId: identifierSchema,
    packVersion: entityVersionSchema,
    packIdentity: z.string().min(3).max(200),
    packName: z.string().min(1).max(128),
    packFingerprint: hex64Schema,
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    planFingerprint: hex64Schema,
    enabledByCompany: z.boolean(),
    selectedByCompany: z.boolean(),
    verified: z.boolean(),
    status: PackCompatibilityStatusSchema,
    reasonCode: z.string().max(128).optional(),
    diagnostic: boundedTextSchema.optional(),
    verifiedRequirements: VerifiedRequirementsSummarySchema.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.status === "COMPATIBLE" && !item.verified) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "COMPATIBLE status requires verified=true with validated registration evidence",
      });
    }
    if (item.status === "COMPATIBLE" && !item.verifiedRequirements) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifiedRequirements"],
        message: "COMPATIBLE status requires verifiedRequirements summary",
      });
    }
  });
export type PackCompatibilitySummary = z.infer<typeof PackCompatibilitySummarySchema>;

// --- 4. Workflow Inspection ---

export const WorkflowNodeSummarySchema = z
  .object({
    id: NodeIdSchema,
    kind: NodeKindSchema,
    name: z.string().min(1).max(200).optional(),
    toolRef: z.string().max(200).optional(),
    modelPolicyId: ModelPolicyIdSchema.optional(),
    agentRef: z.string().max(200).optional(),
    executorRef: z.string().max(200).optional(),
    requiredApproverRoleIds: z.array(identifierSchema).optional(),
    permissionClasses: PermissionClassesSchema.optional(),
  })
  .strict();
export type WorkflowNodeSummary = z.infer<typeof WorkflowNodeSummarySchema>;

export const WorkflowEdgeSummarySchema = z
  .object({
    sourceNodeId: NodeIdSchema,
    targetNodeId: NodeIdSchema,
    conditional: z.boolean(),
  })
  .strict();
export type WorkflowEdgeSummary = z.infer<typeof WorkflowEdgeSummarySchema>;

export const WorkflowSummarySchema = z
  .object({
    workflowId: WorkflowIdSchema,
    version: entityVersionSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    planFingerprint: hex64Schema,
    nodeCount: z.number().int().min(1),
    entryNodeId: NodeIdSchema,
    terminalNodeIds: z.array(NodeIdSchema).min(1),
    nodeKinds: z.array(NodeKindSchema),
    nodeIds: z.array(NodeIdSchema),
    nodes: z.array(WorkflowNodeSummarySchema),
    edges: z.array(WorkflowEdgeSummarySchema),
    toolRefs: z.array(z.string().max(200)),
    modelPolicyRefs: z.array(ModelPolicyIdSchema),
    agentRefs: z.array(z.string().max(200)),
    requiredApproverRoleIds: z.array(identifierSchema),
  })
  .strict();
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

// --- 5. Approval Inspection ---

export const ApprovalActorSummarySchema = PrincipalSchema;

export const ApprovalSummarySchema = z
  .object({
    approvalId: ApprovalIdSchema,
    runId: RunIdSchema,
    nodeId: NodeIdSchema,
    status: ApprovalStatusSchema,
    requiredApproverRoleIds: z.array(identifierSchema).min(1),
    permissionClasses: PermissionClassesSchema,
    allowSelfApproval: z.boolean(),
    requestedBy: ApprovalActorSummarySchema,
    requestedAt: isoTimestampSchema,
    resolvedBy: ApprovalActorSummarySchema.optional(),
    resolvedAt: isoTimestampSchema.optional(),
    requestFingerprint: hex64Schema,
  })
  .strict();
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

// --- 6. Evaluation Inspection ---

export const EvaluationSummaryStatusSchema = z.enum([
  "REGISTERED",
  "NOT_RUN",
  "PASSED",
  "FAILED",
  "UNAVAILABLE",
]);
export type EvaluationSummaryStatus = z.infer<typeof EvaluationSummaryStatusSchema>;

export const BaselineComparisonStatusSchema = z.enum([
  "MATCHED",
  "REGRESSED",
  "IMPROVED",
  "NOT_COMPARED",
]);
export type BaselineComparisonStatus = z.infer<typeof BaselineComparisonStatusSchema>;

export const EvaluationSummarySchema = z
  .object({
    evalProfileRef: z.string().min(3).max(200),
    packIdentity: z.string().min(3).max(200).optional(),
    workflowId: WorkflowIdSchema.optional(),
    companyId: identifierSchema.optional(),
    runId: RunIdSchema.optional(),
    datasetRef: z.string().max(200).optional(),
    graderRefs: z.array(z.string().max(200)),
    status: EvaluationSummaryStatusSchema,
    executed: z.boolean(),
    executedAt: isoTimestampSchema.optional(),
    totalCases: z.number().int().nonnegative().optional(),
    passedCases: z.number().int().nonnegative().optional(),
    failedCases: z.number().int().nonnegative().optional(),
    passRate: z.number().min(0).max(1).optional(),
    failureCodes: z.array(z.string().max(128)),
    baselineComparisonStatus: BaselineComparisonStatusSchema.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if ((item.status === "PASSED" || item.status === "FAILED") && !item.executed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executed"],
        message: "PASSED or FAILED evaluation status requires executed=true",
      });
    }
    if ((item.status === "REGISTERED" || item.status === "NOT_RUN") && item.executed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executed"],
        message: "REGISTERED or NOT_RUN evaluation status must have executed=false",
      });
    }
  });
export type EvaluationSummary = z.infer<typeof EvaluationSummarySchema>;

// --- 7. Trace Inspection ---

export const TraceHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "corrupt",
  "unavailable",
]);
export type TraceHealthStatus = z.infer<typeof TraceHealthStatusSchema>;

export const TraceEventSummarySchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    eventId: TraceEventIdSchema,
    traceId: TraceIdSchema,
    runId: RunIdSchema,
    type: TraceEventTypeSchema,
    occurredAt: isoTimestampSchema,
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    nodeId: NodeIdSchema.optional(),
    spanId: SpanIdSchema,
    parentSpanId: SpanIdSchema.optional(),
    status: TraceStatusSchema.optional(),
    reasonCode: z.string().max(128).optional(),
    toolRef: z.string().max(200).optional(),
    modelPolicyRef: ModelPolicyIdSchema.optional(),
    modelBindingId: identifierSchema.optional(),
    agentRef: z.string().max(200).optional(),
    approvalId: ApprovalIdSchema.optional(),
    approvalDecisionStatus: z
      .enum(["approved", "rejected", "expired", "cancelled"])
      .optional(),
    tokenUsage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    attempt: z.number().int().min(1).optional(),
    maxAttempts: z.number().int().min(1).optional(),
    recoveryReplay: z.boolean().optional(),
  })
  .strict();
export type TraceEventSummary = z.infer<typeof TraceEventSummarySchema>;

export const TraceDiagnosticSummarySchema = z
  .object({
    code: z.string().min(1).max(128),
    message: boundedTextSchema,
    sequence: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TraceDiagnosticSummary = z.infer<typeof TraceDiagnosticSummarySchema>;

export const TraceInspectionSchema = z
  .object({
    runId: RunIdSchema,
    traceId: TraceIdSchema.optional(),
    workflowId: WorkflowIdSchema.optional(),
    workflowVersion: entityVersionSchema.optional(),
    health: TraceHealthStatusSchema,
    eventCount: z.number().int().nonnegative(),
    returnedEventCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    terminalEventType: z
      .enum(["run.completed", "run.failed", "run.cancelled"])
      .optional(),
    startedAt: isoTimestampSchema.optional(),
    finishedAt: isoTimestampSchema.optional(),
    diagnostics: z.array(TraceDiagnosticSummarySchema),
    events: z.array(TraceEventSummarySchema),
  })
  .strict();
export type TraceInspection = z.infer<typeof TraceInspectionSchema>;

// --- 8. Run Inspection ---

export const OperatorRunStatusSchema = z.enum([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "WAITING",
  "RUNNING",
  "UNKNOWN",
]);
export type OperatorRunStatus = z.infer<typeof OperatorRunStatusSchema>;

export const RunSummarySchema = z
  .object({
    runId: RunIdSchema,
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    companyId: identifierSchema.optional(),
    packIdentity: z.string().min(3).max(200).optional(),
    status: OperatorRunStatusSchema,
    statusSource: z.enum(["authoritative_runtime", "unavailable"]),
    statusReason: z.string().max(256).optional(),
    currentNodeId: NodeIdSchema.optional(),
    startedAt: isoTimestampSchema.optional(),
    finishedAt: isoTimestampSchema.optional(),
    traceAvailable: z.boolean(),
    traceHealth: TraceHealthStatusSchema,
    traceEventCount: z.number().int().nonnegative().optional(),
    approvalIds: z.array(ApprovalIdSchema),
    evaluationStatus: EvaluationSummaryStatusSchema.optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.statusSource === "unavailable" && run.status !== "UNKNOWN") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message:
          "When authoritative_runtime statusSource is unavailable, status must be UNKNOWN",
      });
    }
  });
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunInspectionSchema = z
  .object({
    provenance: OperatorSourceProvenanceSchema.optional(),
    summary: RunSummarySchema,
    workflow: WorkflowSummarySchema.optional(),
    trace: TraceInspectionSchema,
    approvals: z.array(ApprovalSummarySchema),
    evaluations: z.array(EvaluationSummarySchema),
    diagnostics: z.array(boundedTextSchema),
  })
  .strict();
export type RunInspection = z.infer<typeof RunInspectionSchema>;

// --- 9. Overview Inspection ---

export const OverviewCountsSchema = z
  .object({
    companies: z.number().int().nonnegative().nullable(),
    capabilityPacks: z.number().int().nonnegative().nullable(),
    compatiblePackBindings: z.number().int().nonnegative().nullable(),
    incompatiblePackBindings: z.number().int().nonnegative().nullable(),
    unverifiedPackBindings: z.number().int().nonnegative().nullable(),
    workflows: z.number().int().nonnegative().nullable(),
    knownRuns: z.number().int().nonnegative().nullable(),
    knownApprovals: z.number().int().nonnegative().nullable(),
    knownEvaluations: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type OverviewCounts = z.infer<typeof OverviewCountsSchema>;

export const OverviewInspectionSchema = z
  .object({
    readOnly: z.literal(true),
    provenance: OperatorSourceProvenanceSchema,
    sources: z.array(SourceStatusSummarySchema),
    counts: OverviewCountsSchema,
    companies: z.array(CompanySummarySchema),
    capabilityPacks: z.array(CapabilityPackSummarySchema),
    compatibility: z.array(PackCompatibilitySummarySchema),
    workflows: z.array(WorkflowSummarySchema),
    recentRuns: z.array(RunSummarySchema),
    approvals: z.array(ApprovalSummarySchema),
    evaluations: z.array(EvaluationSummarySchema),
  })
  .strict();
export type OverviewInspection = z.infer<typeof OverviewInspectionSchema>;

// --- 10. Privacy & Redaction Guard ---

const ADDITIONAL_FORBIDDEN_INSPECTION_KEYS = new Set<string>([
  ...FORBIDDEN_TRACE_KEYS,
  "credential",
  "credentials",
  "privateKey",
  "clientSecret",
  "accessToken",
  "refreshToken",
  "rawGovernance",
  "actors",
  "policies",
  "bindings",
  "rawPayload",
  "toolInput",
  "toolOutput",
  "modelPrompt",
  "modelOutput",
  "approvalSubject",
  "workflowState",
]);

export function findForbiddenInspectionKeys(
  value: unknown,
  path = ""
): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    const found: string[] = [];
    for (let i = 0; i < value.length; i++) {
      found.push(...findForbiddenInspectionKeys(value[i], `${path}[${i}]`));
    }
    return found;
  }
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (ADDITIONAL_FORBIDDEN_INSPECTION_KEYS.has(key)) {
      found.push(keyPath);
    }
    found.push(...findForbiddenInspectionKeys(child, keyPath));
  }
  return found;
}

// --- 11. Guided Integration Diagnostics ---

export const IntegrationDiagnosticStatusSchema = z.enum([
  "READY",
  "BLOCKED",
  "NOT_VERIFIED",
  "UNAVAILABLE",
]);
export type IntegrationDiagnosticStatus = z.infer<typeof IntegrationDiagnosticStatusSchema>;

export const IntegrationRequirementCategorySchema = z.enum([
  "workflow",
  "tool",
  "model_policy",
  "model_capability",
  "integration",
  "governance",
  "approval",
  "evaluation",
]);
export type IntegrationRequirementCategory = z.infer<typeof IntegrationRequirementCategorySchema>;

export const IntegrationRequirementStatusSchema = z.enum([
  "SATISFIED",
  "MISSING",
  "INCOMPATIBLE",
  "NOT_VERIFIED",
  "UNAVAILABLE",
]);
export type IntegrationRequirementStatus = z.infer<typeof IntegrationRequirementStatusSchema>;

export const IntegrationRequirementDiagnosticSchema = z
  .object({
    category: IntegrationRequirementCategorySchema,
    name: z.string().min(1).max(INSPECTION_LIMITS.MAX_STRING_LENGTH),
    requiredRef: z.string().min(1).max(INSPECTION_LIMITS.MAX_STRING_LENGTH),
    status: IntegrationRequirementStatusSchema,
    reasonCode: z.string().max(128).optional(),
    diagnostic: boundedTextSchema.optional(),
    remediation: boundedTextSchema.optional(),
  })
  .strict();
export type IntegrationRequirementDiagnostic = z.infer<typeof IntegrationRequirementDiagnosticSchema>;

export const IntegrationDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(128),
    category: z.string().min(1).max(64),
    message: boundedTextSchema,
    remediation: boundedTextSchema.optional(),
  })
  .strict();
export type IntegrationDiagnostic = z.infer<typeof IntegrationDiagnosticSchema>;

export const IntegrationDiagnosticReportSchema = z
  .object({
    companyId: identifierSchema,
    companyDisplayName: z.string().min(1).max(120).optional(),
    packIdentity: z.string().min(3).max(200),
    packName: z.string().min(1).max(128).optional(),
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    planFingerprint: hex64Schema,
    status: IntegrationDiagnosticStatusSchema,
    reasonCode: z.string().max(128).optional(),
    requirements: z.array(IntegrationRequirementDiagnosticSchema),
    diagnostics: z.array(IntegrationDiagnosticSchema),
    nextSteps: z.array(boundedTextSchema),
    sourceProvenance: OperatorSourceProvenanceSchema,
  })
  .strict();
export type IntegrationDiagnosticReport = z.infer<typeof IntegrationDiagnosticReportSchema>;

// --- 12. Advanced Run Inspection ---

export const NodeExecutionStatusSchema = z.enum([
  "OBSERVED_COMPLETED",
  "OBSERVED_FAILED",
  "OBSERVED_STARTED",
  "NOT_OBSERVED",
  "EVIDENCE_INCOMPLETE",
]);
export type NodeExecutionStatus = z.infer<typeof NodeExecutionStatusSchema>;

/**
 * Token accounting over distinct model invocations (never over lifecycle events).
 * `status` reuses Observability's MetricCompleteness semantics:
 * - complete: every invocation finished and reported input, output and total tokens
 *   (also complete, trivially, when there were zero invocations);
 * - partial: some usage was reported, but at least one invocation failed, never
 *   finished, or omitted a field;
 * - unavailable: invocations occurred and none reported usage.
 * Exact totals (`inputTokens`…) are present only when that field is known for every
 * invocation; `known*` fields are the sums of what was actually recorded. An unknown
 * value is omitted, never zero.
 */
export const TokenUsageSummarySchema = z
  .object({
    status: z.enum(["complete", "partial", "unavailable"]),
    modelInvocations: z.number().int().nonnegative(),
    callsCompleted: z.number().int().nonnegative(),
    callsFailed: z.number().int().nonnegative(),
    callsWithUsage: z.number().int().nonnegative(),
    callsWithoutUsage: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    knownInputTokens: z.number().int().nonnegative(),
    knownOutputTokens: z.number().int().nonnegative(),
    knownTotalTokens: z.number().int().nonnegative(),
  })
  .strict();
export type TokenUsageSummary = z.infer<typeof TokenUsageSummarySchema>;

/**
 * One observed node attempt: exactly one `node.started` event, identified by
 * node + step + attempt + canonical span. Lifecycle and child events attach to it;
 * they never create further attempts.
 */
export const NodeAttemptInspectionSchema = z
  .object({
    nodeId: NodeIdSchema,
    kind: NodeKindSchema,
    step: z.number().int().min(1),
    attempt: z.number().int().min(1),
    spanId: z.string().min(1).max(200),
    status: z.enum(["completed", "failed", "waiting", "retried", "open"]),
    recoveryReplay: z.boolean(),
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    toolRef: z.string().max(200).optional(),
    modelPolicyRef: ModelPolicyIdSchema.optional(),
    modelBindingId: identifierSchema.optional(),
    approvalId: ApprovalIdSchema.optional(),
    reasonCode: z.string().max(128).optional(),
    toolPhysicalInvocations: z.number().int().nonnegative(),
    modelInvocations: z.number().int().nonnegative(),
    tokenUsage: TokenUsageSummarySchema.optional(),
    evidenceEventIds: z.array(z.string().min(1).max(200)).max(INSPECTION_LIMITS.MAX_TRACE_EVENTS),
  })
  .strict();
export type NodeAttemptInspection = z.infer<typeof NodeAttemptInspectionSchema>;

export const NodeExecutionInspectionSchema = z
  .object({
    nodeId: NodeIdSchema,
    nodeKind: NodeKindSchema.or(z.literal("unknown")),
    name: z.string().min(1).max(200).optional(),
    status: NodeExecutionStatusSchema,
    planned: z.boolean(),
    executed: z.boolean(),
    attempts: z.array(NodeAttemptInspectionSchema).max(INSPECTION_LIMITS.MAX_TRACE_EVENTS),
    /** Distinct workflow steps at which this node executed (a repeat is not a retry). */
    executionCount: z.number().int().nonnegative(),
    /** Observed attempts, excluding recovery replays. */
    attemptCount: z.number().int().nonnegative(),
    recoveryReplayCount: z.number().int().nonnegative(),
    scheduledRetries: z.number().int().nonnegative(),
    toolRef: z.string().max(200).optional(),
    modelPolicyRef: ModelPolicyIdSchema.optional(),
    modelBindingId: identifierSchema.optional(),
    approvalId: ApprovalIdSchema.optional(),
    approvalStatus: ApprovalStatusSchema.optional(),
    startedAt: isoTimestampSchema.optional(),
    finishedAt: isoTimestampSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    tokenUsage: TokenUsageSummarySchema.optional(),
    diagnostics: z.array(boundedTextSchema),
  })
  .strict();
export type NodeExecutionInspection = z.infer<typeof NodeExecutionInspectionSchema>;

/** Run-wide node attempts, in `node.started` order. Same record as a node's attempts. */
export const ExecutionAttemptSummarySchema = NodeAttemptInspectionSchema;
export type ExecutionAttemptSummary = NodeAttemptInspection;

/**
 * Distinct execution counters, all derived by Observability's `deriveRunMetrics`
 * from a valid canonical Trace. Present only when the Trace is valid.
 */
export const ExecutionCountersSchema = z
  .object({
    traceEvents: z.number().int().nonnegative(),
    nodeExecutionOccurrences: z.number().int().nonnegative(),
    nodeAttempts: z.number().int().nonnegative(),
    recoveryReplayAttempts: z.number().int().nonnegative(),
    toolPhysicalInvocations: z.number().int().nonnegative(),
    toolLogicalExecutions: z.number().int().nonnegative(),
    toolBlocked: z.number().int().nonnegative(),
    modelInvocations: z.number().int().nonnegative(),
    scheduledRetries: z.number().int().nonnegative(),
    exhaustedRetries: z.number().int().nonnegative(),
  })
  .strict();
export type ExecutionCounters = z.infer<typeof ExecutionCountersSchema>;

/** Valid Trace evidence that could not be attributed to any observed node attempt. */
export const UnattributedEventSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    eventId: z.string().min(1).max(200),
    type: z.string().min(1).max(64),
    nodeId: NodeIdSchema.optional(),
  })
  .strict();
export type UnattributedEvent = z.infer<typeof UnattributedEventSchema>;

export const RunDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(128),
    severity: z.enum(["info", "warning", "error"]),
    observed: boundedTextSchema,
    explanation: boundedTextSchema,
    suggestedCheck: boundedTextSchema,
  })
  .strict();
export type RunDiagnostic = z.infer<typeof RunDiagnosticSchema>;

export const AdvancedRunInspectionSchema = z
  .object({
    runId: RunIdSchema,
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    companyId: identifierSchema.optional(),
    packIdentity: z.string().min(3).max(200).optional(),
    authoritativeStatus: OperatorRunStatusSchema,
    statusSource: z.enum(["authoritative_runtime", "unavailable"]),
    statusReason: z.string().max(256).optional(),
    evidenceHealth: TraceHealthStatusSchema,
    eventCount: z.number().int().nonnegative(),
    nodes: z.array(NodeExecutionInspectionSchema),
    attempts: z.array(ExecutionAttemptSummarySchema).max(INSPECTION_LIMITS.MAX_TRACE_EVENTS),
    attemptsTruncated: z.boolean(),
    counters: ExecutionCountersSchema.optional(),
    unattributedEvents: z.array(UnattributedEventSchema).max(INSPECTION_LIMITS.MAX_TRACE_EVENTS),
    approvals: z.array(ApprovalSummarySchema),
    evaluations: z.array(EvaluationSummarySchema),
    tokenUsage: TokenUsageSummarySchema.optional(),
    diagnostics: z.array(RunDiagnosticSchema),
    provenance: OperatorSourceProvenanceSchema,
  })
  .strict();
export type AdvancedRunInspection = z.infer<typeof AdvancedRunInspectionSchema>;
