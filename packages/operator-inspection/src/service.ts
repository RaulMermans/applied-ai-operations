import { z } from "zod";
import {
  ApprovalIdSchema,
  RunIdSchema,
  identifierSchema,
  type ApprovalRecord,
  type TraceEvent,
  type Workflow,
} from "@aao/contracts";
import type { CompanyManifestV1 } from "@aao/config";
import {
  getRequiredProofName,
  type CapabilityPack,
  type CapabilityPackManifestV1,
} from "@aao/capability-packs";
import type { TraceStore } from "@aao/observability";
import {
  ApprovalSummarySchema,
  CapabilityPackSummarySchema,
  CompanySummarySchema,
  EvaluationSummarySchema,
  INSPECTION_LIMITS,
  OperatorRunStatusSchema,
  OverviewInspectionSchema,
  PackCompatibilitySummarySchema,
  RunInspectionSchema,
  RunSummarySchema,
  SourceStatusSummarySchema,
  TraceInspectionSchema,
  WorkflowSummarySchema,
  type ApprovalSummary,
  type CapabilityPackSummary,
  type CompanySummary,
  type EvaluationSummary,
  type OverviewInspection,
  type PackCompatibilitySummary,
  type RunInspection,
  type RunSummary,
  type SourceStatusSummary,
  type TraceInspection,
  type WorkflowSummary,
} from "./contracts.js";
import { OperatorInspectionError, normalizeInspectionError } from "./errors.js";
import {
  assertSafeInspectionPayload,
  projectApprovalSummary,
  projectCapabilityPackSummary,
  projectCompanySummary,
  projectEvaluationSummary,
  projectPackCompatibilitySummary,
  projectRunInspection,
  projectRunSummary,
  projectTraceInspection,
  projectWorkflowSummary,
  type KnownRunEvidence,
  type RawEvaluationEvidence,
  type TrustedProofRegistrationEvidence,
} from "./projections.js";

export interface OperatorInspectionSource {
  getSourceStatuses?(): Promise<readonly SourceStatusSummary[]>;
  listCompanies?(): Promise<readonly CompanySummary[]>;
  listCapabilityPacks?(): Promise<readonly CapabilityPackSummary[]>;
  getCompanyPackCompatibility?(
    companyId?: string
  ): Promise<readonly PackCompatibilitySummary[]>;
  listWorkflows?(): Promise<readonly WorkflowSummary[]>;
  listKnownRuns?(): Promise<readonly RunSummary[]>;
  getRunInspection?(runId: string): Promise<RunInspection | undefined>;
  getRunTraceInspection?(
    runId: string,
    options?: { limit?: number }
  ): Promise<TraceInspection | undefined>;
  listKnownApprovals?(): Promise<readonly ApprovalSummary[]>;
  getApprovalSummary?(approvalId: string): Promise<ApprovalSummary | undefined>;
  listKnownEvaluationResults?(): Promise<readonly EvaluationSummary[]>;
}

export const ListPacksQuerySchema = z
  .object({
    companyId: identifierSchema.optional(),
  })
  .strict();
export type ListPacksQuery = z.infer<typeof ListPacksQuerySchema>;

export const ListRunsQuerySchema = z
  .object({
    companyId: identifierSchema.optional(),
    status: OperatorRunStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(INSPECTION_LIMITS.MAX_LISTED_RUNS)
      .optional(),
  })
  .strict();
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;

export const GetTraceQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(INSPECTION_LIMITS.MAX_TRACE_EVENTS)
      .optional(),
  })
  .strict();
export type GetTraceQuery = z.infer<typeof GetTraceQuerySchema>;

export const ListEvaluationsQuerySchema = z
  .object({
    companyId: identifierSchema.optional(),
    packIdentity: z.string().min(3).max(200).optional(),
    runId: RunIdSchema.optional(),
  })
  .strict();
export type ListEvaluationsQuery = z.infer<typeof ListEvaluationsQuerySchema>;

function assertBoundedResponseSize<T>(payload: T): T {
  assertSafeInspectionPayload(payload);
  const serialized = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > INSPECTION_LIMITS.MAX_RESPONSE_BYTES) {
    throw new OperatorInspectionError(
      "INSPECTION_LIMIT_EXCEEDED",
      `Inspection response size (${byteLength} bytes) exceeds limit of ${INSPECTION_LIMITS.MAX_RESPONSE_BYTES} bytes.`
    );
  }
  return payload;
}

export interface OperatorInspectionService {
  getOverview(): Promise<OverviewInspection>;
  listCompanies(): Promise<CompanySummary[]>;
  listCapabilityPacks(query?: unknown): Promise<{
    packs: CapabilityPackSummary[];
    compatibility: PackCompatibilitySummary[];
  }>;
  getCompanyPackCompatibility(companyId?: string): Promise<PackCompatibilitySummary[]>;
  listWorkflows(): Promise<WorkflowSummary[]>;
  listKnownRuns(query?: unknown): Promise<RunSummary[]>;
  getRunInspection(runId: unknown): Promise<RunInspection>;
  getRunTraceInspection(runId: unknown, query?: unknown): Promise<TraceInspection>;
  listKnownApprovals(): Promise<ApprovalSummary[]>;
  getApprovalSummary(approvalId: unknown): Promise<ApprovalSummary>;
  listKnownEvaluationResults(query?: unknown): Promise<EvaluationSummary[]>;
}

export function createOperatorInspectionService(
  source: OperatorInspectionSource
): OperatorInspectionService {
  const ensureSourceMethod = <K extends keyof OperatorInspectionSource>(
    methodName: K,
    sourceLabel: string
  ): NonNullable<OperatorInspectionSource[K]> => {
    const fn = source[methodName];
    if (typeof fn !== "function") {
      throw new OperatorInspectionError(
        "INSPECTION_SOURCE_UNAVAILABLE",
        `Inspection source '${sourceLabel}' is not configured or unavailable.`
      );
    }
    return fn.bind(source) as NonNullable<OperatorInspectionSource[K]>;
  };

  const listCompanies = async (): Promise<CompanySummary[]> => {
    const fn = ensureSourceMethod("listCompanies", "companies");
    try {
      const items = await fn();
      const validated = items
        .map((c) => CompanySummarySchema.parse(c))
        .sort((a, b) => a.companyId.localeCompare(b.companyId));
      return assertBoundedResponseSize(validated);
    } catch (err) {
      throw normalizeInspectionError(err);
    }
  };

  const getCompanyPackCompatibility = async (
    companyId?: string
  ): Promise<PackCompatibilitySummary[]> => {
    if (companyId !== undefined) {
      const parsedId = identifierSchema.safeParse(companyId);
      if (!parsedId.success) {
        throw new OperatorInspectionError(
          "INSPECTION_INVALID_REQUEST",
          `Invalid companyId '${String(companyId)}'.`
        );
      }
      if (typeof source.listCompanies === "function") {
        const companies = await listCompanies();
        if (!companies.some((c) => c.companyId === parsedId.data)) {
          throw new OperatorInspectionError(
            "INSPECTION_NOT_FOUND",
            `Unknown company '${parsedId.data}'.`
          );
        }
      }
    }

    const fn = ensureSourceMethod("getCompanyPackCompatibility", "packCompatibility");
    try {
      const items = await fn(companyId);
      const filtered = companyId
        ? items.filter((item) => item.companyId === companyId)
        : items;
      const validated = filtered
        .map((item) => PackCompatibilitySummarySchema.parse(item))
        .sort(
          (a, b) =>
            a.companyId.localeCompare(b.companyId) ||
            a.packIdentity.localeCompare(b.packIdentity)
        );
      return assertBoundedResponseSize(validated);
    } catch (err) {
      throw normalizeInspectionError(err);
    }
  };

  const listCapabilityPacks = async (
    rawQuery?: unknown
  ): Promise<{
    packs: CapabilityPackSummary[];
    compatibility: PackCompatibilitySummary[];
  }> => {
    const queryParsed = ListPacksQuerySchema.safeParse(rawQuery ?? {});
    if (!queryParsed.success) {
      throw new OperatorInspectionError(
        "INSPECTION_INVALID_REQUEST",
        `Invalid pack inspection query parameters: ${queryParsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }
    const { companyId } = queryParsed.data;

    const fn = ensureSourceMethod("listCapabilityPacks", "capabilityPacks");
    try {
      const rawPacks = await fn();
      const packs = rawPacks
        .map((p) => CapabilityPackSummarySchema.parse(p))
        .sort((a, b) => a.identity.localeCompare(b.identity));

      let compatibility: PackCompatibilitySummary[] = [];
      if (typeof source.getCompanyPackCompatibility === "function") {
        compatibility = await getCompanyPackCompatibility(companyId);
      } else if (companyId !== undefined) {
        throw new OperatorInspectionError(
          "INSPECTION_SOURCE_UNAVAILABLE",
          "Pack compatibility source is unavailable."
        );
      }

      return assertBoundedResponseSize({ packs, compatibility });
    } catch (err) {
      throw normalizeInspectionError(err);
    }
  };

  const listWorkflows = async (): Promise<WorkflowSummary[]> => {
    const fn = ensureSourceMethod("listWorkflows", "workflows");
    try {
      const items = await fn();
      const validated = items
        .map((w) => WorkflowSummarySchema.parse(w))
        .sort(
          (a, b) =>
            a.workflowId.localeCompare(b.workflowId) ||
            a.version.localeCompare(b.version)
        );
      return assertBoundedResponseSize(validated);
    } catch (err) {
      throw normalizeInspectionError(err);
    }
  };

  const listKnownRuns = async (rawQuery?: unknown): Promise<RunSummary[]> => {
    if (
      rawQuery !== null &&
      typeof rawQuery === "object" &&
      "limit" in (rawQuery as Record<string, unknown>)
    ) {
      const rawLimit = Number((rawQuery as Record<string, unknown>).limit);
      if (Number.isFinite(rawLimit) && rawLimit > INSPECTION_LIMITS.MAX_LISTED_RUNS) {
        throw new OperatorInspectionError(
          "INSPECTION_LIMIT_EXCEEDED",
          `Requested run limit (${rawLimit}) exceeds maximum allowed (${INSPECTION_LIMITS.MAX_LISTED_RUNS}).`
        );
      }
    }

    const queryParsed = ListRunsQuerySchema.safeParse(rawQuery ?? {});
    if (!queryParsed.success) {
      throw new OperatorInspectionError(
        "INSPECTION_INVALID_REQUEST",
        `Invalid runs query parameters: ${queryParsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }
    const { companyId, status, limit } = queryParsed.data;
    const maxItems = limit ?? INSPECTION_LIMITS.MAX_LISTED_RUNS;

    const fn = ensureSourceMethod("listKnownRuns", "runs");
    try {
      const items = await fn();
      let validated = items.map((r) => RunSummarySchema.parse(r));
      if (companyId) {
        validated = validated.filter((r) => r.companyId === companyId);
      }
      if (status) {
        validated = validated.filter((r) => r.status === status);
      }
      validated.sort((a, b) => a.runId.localeCompare(b.runId));
      return assertBoundedResponseSize(validated.slice(0, maxItems));
    } catch (err) {
      throw normalizeInspectionError(err);
    }
  };

  const getRunInspection = async (rawRunId: unknown): Promise<RunInspection> => {
    const parsedId = RunIdSchema.safeParse(rawRunId);
    if (!parsedId.success) {
      throw new OperatorInspectionError(
        "INSPECTION_INVALID_REQUEST",
        `Invalid runId '${String(rawRunId)}'.`
      );
    }
    const fn = ensureSourceMethod("getRunInspection", "runs");
    try {
      const found = await fn(parsedId.data);
      if (!found) {
        throw new OperatorInspectionError(
          "INSPECTION_NOT_FOUND",
          `Run '${parsedId.data}' was not found in known inspection sources.`
        );
      }
      const validated = RunInspectionSchema.parse(found);
      return assertBoundedResponseSize(validated);
    } catch (err) {
      throw normalizeInspectionError(err);
    }
  };

  const getRunTraceInspection = async (
    rawRunId: unknown,
    rawQuery?: unknown
  ): Promise<TraceInspection> => {
    const parsedId = RunIdSchema.safeParse(rawRunId);
    if (!parsedId.success) {
      throw new OperatorInspectionError(
        "INSPECTION_INVALID_REQUEST",
        `Invalid runId '${String(rawRunId)}'.`
      );
    }

    if (
      rawQuery !== null &&
      typeof rawQuery === "object" &&
      "limit" in (rawQuery as Record<string, unknown>)
    ) {
      const rawLimit = Number((rawQuery as Record<string, unknown>).limit);
      if (Number.isFinite(rawLimit) && rawLimit > INSPECTION_LIMITS.MAX_TRACE_EVENTS) {
        throw new OperatorInspectionError(
          "INSPECTION_LIMIT_EXCEEDED",
          `Requested trace event limit (${rawLimit}) exceeds maximum allowed (${INSPECTION_LIMITS.MAX_TRACE_EVENTS}).`
        );
      }
    }

    const queryParsed = GetTraceQuerySchema.safeParse(rawQuery ?? {});
    if (!queryParsed.success) {
      throw new OperatorInspectionError(
        "INSPECTION_INVALID_REQUEST",
        `Invalid trace query parameters: ${queryParsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }

    if (typeof source.getRunTraceInspection === "function") {
      try {
        const trace = await source.getRunTraceInspection(parsedId.data, {
          limit: queryParsed.data.limit,
        });
        if (!trace) {
          throw new OperatorInspectionError(
            "INSPECTION_NOT_FOUND",
            `Trace for run '${parsedId.data}' was not found.`
          );
        }
        if (trace.health === "corrupt") {
          throw new OperatorInspectionError(
            "INSPECTION_TRACE_CORRUPT",
            `Trace for run '${parsedId.data}' failed integrity validation (${trace.diagnostics.map((d) => d.code).join(", ")}).`,
            {
              details: {
                runId: parsedId.data,
                diagnosticCodes: trace.diagnostics.map((d) => d.code),
              },
            }
          );
        }
        return assertBoundedResponseSize(TraceInspectionSchema.parse(trace));
      } catch (err) {
        throw normalizeInspectionError(err);
      }
    }

    // Fallback to getRunInspection if dedicated getRunTraceInspection is not implemented
    const runInspection = await getRunInspection(parsedId.data);
    if (runInspection.trace.health === "corrupt") {
      throw new OperatorInspectionError(
        "INSPECTION_TRACE_CORRUPT",
        `Trace for run '${parsedId.data}' failed integrity validation (${runInspection.trace.diagnostics.map((d) => d.code).join(", ")}).`,
        {
          details: {
            runId: parsedId.data,
            diagnosticCodes: runInspection.trace.diagnostics.map((d) => d.code),
          },
        }
      );
    }
    const maxEvents = queryParsed.data.limit ?? INSPECTION_LIMITS.MAX_TRACE_EVENTS;
    const slicedEvents = runInspection.trace.events.slice(0, maxEvents);
    const traceResult: TraceInspection = {
      ...runInspection.trace,
      returnedEventCount: slicedEvents.length,
      truncated: runInspection.trace.eventCount > slicedEvents.length,
      events: slicedEvents,
    };
    return assertBoundedResponseSize(TraceInspectionSchema.parse(traceResult));
  };

  const listKnownApprovals = async (): Promise<ApprovalSummary[]> => {
    const fn = ensureSourceMethod("listKnownApprovals", "approvals");
    try {
      const items = await fn();
      const validated = items
        .map((a) => ApprovalSummarySchema.parse(a))
        .sort((a, b) => a.approvalId.localeCompare(b.approvalId));
      return assertBoundedResponseSize(validated);
    } catch (err) {
      throw normalizeInspectionError(err);
    }
  };

  const getApprovalSummary = async (rawApprovalId: unknown): Promise<ApprovalSummary> => {
    const parsedId = ApprovalIdSchema.safeParse(rawApprovalId);
    if (!parsedId.success) {
      throw new OperatorInspectionError(
        "INSPECTION_INVALID_REQUEST",
        `Invalid approvalId '${String(rawApprovalId)}'.`
      );
    }
    const fn = ensureSourceMethod("getApprovalSummary", "approvals");
    try {
      const found = await fn(parsedId.data);
      if (!found) {
        throw new OperatorInspectionError(
          "INSPECTION_NOT_FOUND",
          `Approval '${parsedId.data}' was not found in authoritative Approval records.`
        );
      }
      return assertBoundedResponseSize(ApprovalSummarySchema.parse(found));
    } catch (err) {
      throw normalizeInspectionError(err);
    }
  };

  const listKnownEvaluationResults = async (
    rawQuery?: unknown
  ): Promise<EvaluationSummary[]> => {
    const queryParsed = ListEvaluationsQuerySchema.safeParse(rawQuery ?? {});
    if (!queryParsed.success) {
      throw new OperatorInspectionError(
        "INSPECTION_INVALID_REQUEST",
        `Invalid evaluation query parameters: ${queryParsed.error.issues.map((i) => i.message).join("; ")}`
      );
    }
    const { companyId, packIdentity, runId } = queryParsed.data;

    const fn = ensureSourceMethod("listKnownEvaluationResults", "evaluations");
    try {
      const items = await fn();
      let validated = items.map((e) => EvaluationSummarySchema.parse(e));
      if (companyId) {
        validated = validated.filter((e) => e.companyId === companyId);
      }
      if (packIdentity) {
        validated = validated.filter((e) => e.packIdentity === packIdentity);
      }
      if (runId) {
        validated = validated.filter((e) => e.runId === runId);
      }
      validated.sort(
        (a, b) =>
          a.evalProfileRef.localeCompare(b.evalProfileRef) ||
          (a.runId ?? "").localeCompare(b.runId ?? "")
      );
      return assertBoundedResponseSize(validated);
    } catch (err) {
      throw normalizeInspectionError(err);
    }
  };

  const getOverview = async (): Promise<OverviewInspection> => {
    const sources: SourceStatusSummary[] = [];

    const safeCollect = async <T>(
      sourceId: SourceStatusSummary["sourceId"],
      hasMethod: boolean,
      loader: () => Promise<T[]>
    ): Promise<{ available: boolean; items: T[] }> => {
      if (!hasMethod) {
        sources.push({
          sourceId,
          status: "unavailable",
          reasonCode: "SOURCE_NOT_CONFIGURED",
          diagnostic: `Inspection source '${sourceId}' is not configured on this host.`,
        });
        return { available: false, items: [] };
      }
      try {
        const items = await loader();
        sources.push({ sourceId, status: "available" });
        return { available: true, items };
      } catch (err) {
        const normalized = normalizeInspectionError(err);
        sources.push({
          sourceId,
          status:
            normalized.code === "INSPECTION_SOURCE_UNAVAILABLE"
              ? "unavailable"
              : "invalid",
          reasonCode: normalized.code,
          diagnostic: normalized.message,
        });
        return { available: false, items: [] };
      }
    };

    const companiesRes = await safeCollect(
      "companies",
      typeof source.listCompanies === "function",
      () => listCompanies()
    );
    const packsRes = await safeCollect(
      "capabilityPacks",
      typeof source.listCapabilityPacks === "function",
      async () => {
        const fn = ensureSourceMethod("listCapabilityPacks", "capabilityPacks");
        const raw = await fn();
        return raw
          .map((p) => CapabilityPackSummarySchema.parse(p))
          .sort((a, b) => a.identity.localeCompare(b.identity));
      }
    );
    const compatRes = await safeCollect(
      "packCompatibility",
      typeof source.getCompanyPackCompatibility === "function",
      () => getCompanyPackCompatibility()
    );
    const workflowsRes = await safeCollect(
      "workflows",
      typeof source.listWorkflows === "function",
      () => listWorkflows()
    );
    const runsRes = await safeCollect(
      "runs",
      typeof source.listKnownRuns === "function",
      () => listKnownRuns({ limit: 25 })
    );

    // Determine traces source status from runs & source capabilities
    if (
      typeof source.getRunTraceInspection === "function" ||
      typeof source.getRunInspection === "function"
    ) {
      const hasCorruptTrace = runsRes.items.some((r) => r.traceHealth === "corrupt");
      const hasUnavailableTrace = runsRes.items.some(
        (r) => r.traceHealth === "unavailable" || r.traceHealth === "degraded"
      );
      sources.push({
        sourceId: "traces",
        status: hasCorruptTrace
          ? "degraded"
          : hasUnavailableTrace && runsRes.items.every((r) => !r.traceAvailable) && runsRes.items.length > 0
            ? "degraded"
            : "available",
        ...(hasCorruptTrace
          ? {
              reasonCode: "INSPECTION_TRACE_CORRUPT",
              diagnostic: "One or more known runs have corrupt trace evidence.",
            }
          : {}),
      });
    } else {
      sources.push({
        sourceId: "traces",
        status: "unavailable",
        reasonCode: "SOURCE_NOT_CONFIGURED",
        diagnostic: "Trace inspection source is not configured on this host.",
      });
    }

    const approvalsRes = await safeCollect(
      "approvals",
      typeof source.listKnownApprovals === "function",
      () => listKnownApprovals()
    );
    const evalsRes = await safeCollect(
      "evaluations",
      typeof source.listKnownEvaluationResults === "function",
      () => listKnownEvaluationResults()
    );

    // Override with explicit host source statuses if provided
    if (typeof source.getSourceStatuses === "function") {
      const explicitStatuses = await source.getSourceStatuses();
      for (const explicit of explicitStatuses) {
        const parsed = SourceStatusSummarySchema.parse(explicit);
        const idx = sources.findIndex((s) => s.sourceId === parsed.sourceId);
        if (idx >= 0) {
          sources[idx] = parsed;
        } else {
          sources.push(parsed);
        }
      }
    }

    // Never invent aggregate counts when a source is unavailable: use null!
    const overview: OverviewInspection = {
      readOnly: true,
      sources,
      counts: {
        companies: companiesRes.available ? companiesRes.items.length : null,
        capabilityPacks: packsRes.available ? packsRes.items.length : null,
        compatiblePackBindings: compatRes.available
          ? compatRes.items.filter((c) => c.status === "COMPATIBLE").length
          : null,
        incompatiblePackBindings: compatRes.available
          ? compatRes.items.filter((c) => c.status === "INCOMPATIBLE").length
          : null,
        unverifiedPackBindings: compatRes.available
          ? compatRes.items.filter((c) => c.status === "NOT_VERIFIED").length
          : null,
        workflows: workflowsRes.available ? workflowsRes.items.length : null,
        knownRuns: runsRes.available ? runsRes.items.length : null,
        knownApprovals: approvalsRes.available ? approvalsRes.items.length : null,
        knownEvaluations: evalsRes.available ? evalsRes.items.length : null,
      },
      companies: companiesRes.items,
      capabilityPacks: packsRes.items,
      compatibility: compatRes.items,
      workflows: workflowsRes.items,
      recentRuns: runsRes.items,
      approvals: approvalsRes.items,
      evaluations: evalsRes.items,
    };

    return assertBoundedResponseSize(OverviewInspectionSchema.parse(overview));
  };

  return Object.freeze({
    getOverview,
    listCompanies,
    listCapabilityPacks,
    getCompanyPackCompatibility,
    listWorkflows,
    listKnownRuns,
    getRunInspection,
    getRunTraceInspection,
    listKnownApprovals,
    getApprovalSummary,
    listKnownEvaluationResults,
  });
}

// --- Evidence-Backed Inspection Source Builder ---

export interface CompanyInspectionRegistration {
  readonly manifest: CompanyManifestV1 | unknown;
  readonly selectedPackRefs?: readonly { id: string; version: string }[];
  /**
   * Keyed by pack category ("company_research" | "document_intelligence" | "operational_request")
   * or pack identity ("aao.company-research@1.0.0").
   * When omitted for a pack, compatibility is reported as NOT_VERIFIED.
   */
  readonly registrationEvidenceByPack?: Readonly<
    Record<string, TrustedProofRegistrationEvidence | undefined>
  >;
}

export interface EvidenceBackedInspectionSourceConfig {
  readonly companies?: readonly CompanyInspectionRegistration[];
  readonly capabilityPacks?: readonly (CapabilityPack | CapabilityPackManifestV1)[];
  readonly workflows?: readonly Workflow[];
  readonly knownRuns?: readonly KnownRunEvidence[];
  readonly traceStore?: TraceStore;
  readonly approvalRecords?: readonly ApprovalRecord[];
  readonly evaluationResults?: readonly RawEvaluationEvidence[];
  readonly sourceStatuses?: readonly SourceStatusSummary[];
}

export function createEvidenceBackedInspectionSource(
  config: EvidenceBackedInspectionSourceConfig
): OperatorInspectionSource {
  const resolveRunTraceEvents = async (
    runEvidence: KnownRunEvidence
  ): Promise<readonly TraceEvent[] | undefined> => {
    if (runEvidence.traceEvents !== undefined) {
      return runEvidence.traceEvents;
    }
    if (config.traceStore) {
      const fromStore = await config.traceStore.getRunTrace(runEvidence.runId);
      return fromStore.length > 0 ? fromStore : undefined;
    }
    return undefined;
  };

  const computeCompatibilityAll = (): PackCompatibilitySummary[] => {
    if (!config.companies || !config.capabilityPacks) {
      throw new OperatorInspectionError(
        "INSPECTION_SOURCE_UNAVAILABLE",
        "Companies or Capability Packs source is unavailable for compatibility inspection."
      );
    }
    const results: PackCompatibilitySummary[] = [];
    for (const companyReg of config.companies) {
      const selectedIdentities = new Set(
        (companyReg.selectedPackRefs ?? []).map((r) => `${r.id}@${r.version}`)
      );
      for (const pack of config.capabilityPacks) {
        const packSummary = projectCapabilityPackSummary(pack);
        const proofName = getRequiredProofName(packSummary.id);
        const evidence =
          companyReg.registrationEvidenceByPack?.[packSummary.identity] ??
          companyReg.registrationEvidenceByPack?.[packSummary.id] ??
          companyReg.registrationEvidenceByPack?.[proofName] ??
          companyReg.registrationEvidenceByPack?.[packSummary.category];

        const selectedByCompany =
          companyReg.selectedPackRefs !== undefined
            ? selectedIdentities.has(packSummary.identity)
            : undefined;

        results.push(
          projectPackCompatibilitySummary({
            companyManifest: companyReg.manifest,
            pack,
            selectedByCompany,
            registrationEvidence: evidence,
          })
        );
      }
    }
    return results.sort(
      (a, b) =>
        a.companyId.localeCompare(b.companyId) ||
        a.packIdentity.localeCompare(b.packIdentity)
    );
  };

  const source: OperatorInspectionSource = {
    ...(config.sourceStatuses
      ? {
          getSourceStatuses: async () => config.sourceStatuses!,
        }
      : {}),

    ...(config.companies
      ? {
          listCompanies: async () => {
            const compat =
              config.capabilityPacks !== undefined ? computeCompatibilityAll() : [];
            return config.companies!
              .map((c) =>
                projectCompanySummary({
                  manifest: c.manifest,
                  selectedPackRefs: c.selectedPackRefs,
                  compatibilitySummaries: compat,
                })
              )
              .sort((a, b) => a.companyId.localeCompare(b.companyId));
          },
        }
      : {}),

    ...(config.capabilityPacks
      ? {
          listCapabilityPacks: async () =>
            config.capabilityPacks!
              .map((p) => projectCapabilityPackSummary(p))
              .sort((a, b) => a.identity.localeCompare(b.identity)),
        }
      : {}),

    ...(config.companies && config.capabilityPacks
      ? {
          getCompanyPackCompatibility: async (companyId?: string) => {
            const all = computeCompatibilityAll();
            return companyId ? all.filter((c) => c.companyId === companyId) : all;
          },
        }
      : {}),

    ...(config.workflows
      ? {
          listWorkflows: async () =>
            config.workflows!
              .map((w) => projectWorkflowSummary(w))
              .sort(
                (a, b) =>
                  a.workflowId.localeCompare(b.workflowId) ||
                  a.version.localeCompare(b.version)
              ),
        }
      : {}),

    ...(config.knownRuns
      ? {
          listKnownRuns: async () => {
            const summaries: RunSummary[] = [];
            for (const runEv of config.knownRuns!) {
              const traceEvents = await resolveRunTraceEvents(runEv);
              const approvalRecords =
                runEv.approvalRecords ??
                config.approvalRecords?.filter((a) => a.runId === runEv.runId);
              const evaluations =
                runEv.evaluations ??
                config.evaluationResults?.filter((e) => e.runId === runEv.runId);
              const workflow =
                runEv.workflow ??
                config.workflows?.find(
                  (w) =>
                    w.id ===
                    (runEv.authoritativeRun?.workflowId ??
                      traceEvents?.[0]?.workflowId)
                );

              summaries.push(
                projectRunSummary({
                  ...runEv,
                  traceEvents,
                  approvalRecords,
                  evaluations,
                  workflow,
                })
              );
            }
            return summaries.sort((a, b) => a.runId.localeCompare(b.runId));
          },

          getRunInspection: async (runId: string) => {
            const runEv = config.knownRuns!.find((r) => r.runId === runId);
            if (!runEv) {
              return undefined;
            }
            const traceEvents = await resolveRunTraceEvents(runEv);
            const approvalRecords =
              runEv.approvalRecords ??
              config.approvalRecords?.filter((a) => a.runId === runEv.runId);
            const evaluations =
              runEv.evaluations ??
              config.evaluationResults?.filter((e) => e.runId === runEv.runId);
            const workflow =
              runEv.workflow ??
              config.workflows?.find(
                (w) =>
                  w.id ===
                  (runEv.authoritativeRun?.workflowId ??
                    traceEvents?.[0]?.workflowId)
              );

            return projectRunInspection({
              ...runEv,
              traceEvents,
              approvalRecords,
              evaluations,
              workflow,
            });
          },

          getRunTraceInspection: async (
            runId: string,
            options?: { limit?: number }
          ) => {
            const runEv = config.knownRuns!.find((r) => r.runId === runId);
            if (!runEv) {
              return undefined;
            }
            const traceEvents = await resolveRunTraceEvents(runEv);
            return projectTraceInspection({
              runId,
              events: traceEvents,
              maxEvents: options?.limit,
              throwOnCorrupt: true,
            });
          },
        }
      : {}),

    ...(config.approvalRecords
      ? {
          listKnownApprovals: async () =>
            config.approvalRecords!
              .map((a) => projectApprovalSummary(a))
              .sort((a, b) => a.approvalId.localeCompare(b.approvalId)),

          getApprovalSummary: async (approvalId: string) => {
            const record = config.approvalRecords!.find(
              (a) => a.approvalId === approvalId
            );
            return record ? projectApprovalSummary(record) : undefined;
          },
        }
      : {}),

    ...(config.evaluationResults
      ? {
          listKnownEvaluationResults: async () =>
            config.evaluationResults!
              .map((e) => projectEvaluationSummary(e))
              .sort(
                (a, b) =>
                  a.evalProfileRef.localeCompare(b.evalProfileRef) ||
                  (a.runId ?? "").localeCompare(b.runId ?? "")
              ),
        }
      : {}),
  };

  return Object.freeze(source);
}
