import { z } from "zod";
import { AgentIdSchema, ApprovalIdSchema, CheckpointIdSchema, ModelPolicyIdSchema, NodeIdSchema, RunIdSchema, ToolIdSchema, TraceEventIdSchema, WorkflowIdSchema, entityVersionSchema, identifierSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";
import { PermissionClassesSchema, PrincipalSchema } from "./governance.js";
import { FailureCategorySchema, ReliabilityPolicySchema } from "./reliability.js";
import { NodeKindSchema } from "./workflow.js";
import { RunStatusSchema } from "./run.js";

/**
 * Canonical AAO Trace contract, schema version 2 (ADR-020,
 * docs/architecture/trace-runtime.md). Sprint 2's placeholder `TraceEvent`
 * (schema version 1: an open `type` and an untyped `payload`) was migrated
 * here rather than duplicated: there is one TraceEvent contract.
 *
 * A Trace Event is an *observational projection* of what authoritative AAO
 * components (Runtime, Governance, Approval, Durability) already decided. It
 * never carries authority, and nothing in AAO reads it to make an execution
 * decision. Payloads are metadata-only by construction: every event type has
 * a strict, bounded schema with no field for prompts, model output, Tool
 * input/output, state values, approval subjects, reasoning, or raw errors.
 */

// --- Bounded building blocks ----------------------------------------------------

/** A machine-readable failure/reason code reused from an existing AAO taxonomy (Runtime, Tool, Model, Agent, Approval, Durability). Never free text. */
export const TraceCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const positive = z.number().int().min(1);
const stateKeySchema = identifierSchema;
const ToolRefTraceSchema = z.object({ id: ToolIdSchema, version: entityVersionSchema }).strict();
const AgentRefTraceSchema = z.object({ id: AgentIdSchema, version: entityVersionSchema }).strict();
const ExecutorFailureTraceSchema = z.object({ namespace: identifierSchema.max(64), code: TraceCodeSchema }).strict();
const UsageTraceSchema = z.object({ inputTokens: count.optional(), outputTokens: count.optional(), totalTokens: count.optional() }).strict();
/** Trusted registration metadata only (ModelBinding.identity); never parsed from a binding id or model output. */
const ModelIdentityTraceSchema = z.object({ provider: identifierSchema.max(128), model: z.string().min(1).max(128), revision: z.string().min(1).max(128).optional() }).strict();

/** OTel-compatible widths: a 16-byte trace id and an 8-byte span id, lowercase hex. */
export const TraceIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const SpanIdSchema = z.string().regex(/^[a-f0-9]{16}$/);

/** The small canonical status vocabulary. Fixed per event type (see TRACE_EVENT_STATUS); never chosen by an emitter. */
export const TraceStatusSchema = z.enum(["started", "succeeded", "failed", "waiting", "blocked", "cancelled"]);
export type TraceStatus = z.infer<typeof TraceStatusSchema>;

// --- Typed payloads, one strict schema per implemented event type -------------------

const ReliabilityPolicyTraceSchema = ReliabilityPolicySchema.extend({ nodeId: NodeIdSchema }).strict();

/**
 * Every event type AAO can truthfully emit today. Retrieval, eval, artifact,
 * memory, and side-effect events are deliberately absent: those systems do
 * not exist yet. The namespace stays extensible by adding a type here with
 * its own payload schema; the envelope never changes for it.
 */
export const TRACE_EVENT_PAYLOAD_SCHEMAS = {
  "run.started": z.object({
    entryNodeId: NodeIdSchema,
    initialStateRevision: count,
    nodeCount: positive,
    /** The trusted, explicitly configured reliability policies (nodes absent use the default single attempt). */
    reliabilityPolicies: z.array(ReliabilityPolicyTraceSchema).max(512),
    /** Recorder-derived: SHA-256 of the canonical reliability configuration. Not the durable plan fingerprint. */
    reliabilityPolicyFingerprint: hex64,
    /** Optional host-supplied release metadata; no deployment infrastructure is implied. */
    release: z.object({ releaseId: identifierSchema.optional(), gitSha: z.string().regex(/^[a-f0-9]{7,64}$/).optional(), environment: identifierSchema.max(64).optional() }).strict().optional(),
  }).strict(),
  "run.completed": z.object({ finalNodeId: NodeIdSchema, stateRevision: count, steps: count }).strict(),
  "run.failed": z.object({ code: TraceCodeSchema, category: FailureCategorySchema.optional(), nodeId: NodeIdSchema.optional(), stateRevision: count, steps: count }).strict(),
  "run.cancelled": z.object({ code: TraceCodeSchema, nodeId: NodeIdSchema.optional(), stateRevision: count, steps: count }).strict(),

  "node.started": z.object({ kind: NodeKindSchema, step: positive, attempt: positive, maxAttempts: positive, stateRevision: count, recoveryReplay: z.boolean() }).strict(),
  "node.completed": z.object({ kind: NodeKindSchema, step: positive, attemptCount: positive, stateRevisionBefore: count, stateRevisionAfter: count, outcomeSource: z.enum(["executor", "recovered", "approval_resolution"]) }).strict(),
  "node.failed": z.object({ kind: NodeKindSchema, step: positive, attemptCount: positive, code: TraceCodeSchema, category: FailureCategorySchema.optional(), retryable: z.boolean().optional(), causeCode: TraceCodeSchema.optional(), executorFailure: ExecutorFailureTraceSchema.optional() }).strict(),
  "node.waiting": z.object({ kind: NodeKindSchema, step: positive, waitKind: z.literal("approval"), referenceId: identifierSchema }).strict(),

  "route.selected": z.object({ sourceNodeId: NodeIdSchema, targetNodeId: NodeIdSchema, routeType: z.literal("unconditional") }).strict(),
  /** Key names only, sorted and unique. State values never enter a trace. */
  "state.updated": z.object({ step: positive, revisionBefore: count, revisionAfter: count, changedKeys: z.array(stateKeySchema).max(512) }).strict(),

  "model.call.started": z.object({ invocationId: identifierSchema, attempt: positive, modelPolicyRef: ModelPolicyIdSchema, modelBindingId: identifierSchema, outputKind: z.enum(["text", "structured"]), requiredCapabilityIds: z.array(identifierSchema).max(64), modelIdentity: ModelIdentityTraceSchema.optional(), recoveryReplay: z.boolean() }).strict(),
  "model.call.completed": z.object({ invocationId: identifierSchema, attempt: positive, modelBindingId: identifierSchema, outputKind: z.enum(["text", "structured"]), finishReason: z.enum(["stop", "length", "content_filter", "other"]).optional(), usage: UsageTraceSchema.optional(), modelIdentity: ModelIdentityTraceSchema.optional() }).strict(),
  "model.call.failed": z.object({ invocationId: identifierSchema, attempt: positive, modelBindingId: identifierSchema, code: TraceCodeSchema, adapterReason: z.enum(["provider_error", "unsupported_response", "unparseable_output"]).optional() }).strict(),

  "agent.started": z.object({ agentRef: AgentRefTraceSchema, agentExecutionId: identifierSchema, attempt: positive, modelPolicyRef: ModelPolicyIdSchema, maxIterations: positive }).strict(),
  /** Decision metadata only: the working output, rationale, and any reasoning are never traced. */
  "agent.iteration.completed": z.object({ agentRef: AgentRefTraceSchema, agentExecutionId: identifierSchema, attempt: positive, iteration: positive, action: z.enum(["CONTINUE", "COMPLETE"]), invocationId: identifierSchema, modelBindingId: identifierSchema, usage: UsageTraceSchema.optional() }).strict(),
  "agent.completed": z.object({ agentRef: AgentRefTraceSchema, agentExecutionId: identifierSchema, attempt: positive, iterationsUsed: positive, usage: UsageTraceSchema.optional() }).strict(),
  "agent.failed": z.object({ agentRef: AgentRefTraceSchema, agentExecutionId: identifierSchema, attempt: positive, code: TraceCodeSchema, iteration: positive.optional(), modelFailureCode: TraceCodeSchema.optional() }).strict(),

  "tool.call.started": z.object({ toolRef: ToolRefTraceSchema, toolExecutionId: identifierSchema, attempt: positive, permissionClasses: PermissionClassesSchema, access: z.object({ decision: z.literal("allow"), principalId: identifierSchema, agentCeilingApplied: z.boolean() }).strict(), recoveryReplay: z.boolean() }).strict(),
  "tool.call.completed": z.object({ toolRef: ToolRefTraceSchema, toolExecutionId: identifierSchema, attempt: positive, permissionClasses: PermissionClassesSchema, result: z.literal("success") }).strict(),
  "tool.call.failed": z.object({ toolRef: ToolRefTraceSchema, toolExecutionId: identifierSchema, attempt: positive, code: TraceCodeSchema, handlerFailureCode: TraceCodeSchema.optional(), retryable: z.boolean(), category: FailureCategorySchema }).strict(),
  /** The handler was never invoked (handler calls = 0): support gate, authorization, or request/input validation stopped it. */
  "tool.call.blocked": z.object({ toolRef: ToolRefTraceSchema, toolExecutionId: identifierSchema, attempt: positive, code: TraceCodeSchema, category: FailureCategorySchema, permissionClasses: PermissionClassesSchema.optional(), access: z.object({ decision: z.literal("deny"), reasonCode: TraceCodeSchema }).strict().optional() }).strict(),

  "retry.scheduled": z.object({ step: positive, failedAttempt: positive, nextAttempt: positive, maxAttempts: positive, category: FailureCategorySchema, causeCode: TraceCodeSchema, delayMs: count }).strict(),
  "retry.exhausted": z.object({ step: positive, attempt: positive, maxAttempts: positive, category: FailureCategorySchema, causeCode: TraceCodeSchema }).strict(),

  /** The approval subject and its payload are never traced; `requestFingerprint` binds the request without copying it. */
  "approval.requested": z.object({ approvalId: ApprovalIdSchema, step: positive, requestedBy: PrincipalSchema, requiredApproverRoleIds: z.array(identifierSchema).min(1).max(64), permissionClasses: PermissionClassesSchema, allowSelfApproval: z.boolean(), requestFingerprint: hex64 }).strict(),
  "approval.resolved": z.object({ approvalId: ApprovalIdSchema, status: z.enum(["approved", "rejected", "expired", "cancelled"]), resolvedBy: PrincipalSchema.optional(), resolvedAt: isoTimestampSchema }).strict(),

  "checkpoint.created": z.object({ checkpointId: CheckpointIdSchema, checkpointSequence: count, runStatus: RunStatusSchema, stateRevision: count, step: count, currentNodeId: NodeIdSchema.optional(), planFingerprint: hex64 }).strict(),

  "recovery.started": z.object({ checkpointId: CheckpointIdSchema, checkpointSequence: count, runStatus: RunStatusSchema, stateRevision: count, currentNodeId: NodeIdSchema.optional() }).strict(),
  "recovery.replayed": z.object({ operationId: identifierSchema, step: positive, attempt: positive, recoveryReplayCount: positive }).strict(),
  "recovery.outcome_reused": z.object({ operationId: identifierSchema, step: positive, attempt: positive, outcomeKind: z.enum(["success", "wait", "failure"]) }).strict(),
  "recovery.completed": z.object({ fromCheckpointSequence: count, toCheckpointSequence: count }).strict(),
  "recovery.blocked": z.object({ operationId: identifierSchema, step: positive, attempt: positive, code: TraceCodeSchema }).strict(),

  "cancellation.requested": z.object({ requestedAt: isoTimestampSchema }).strict(),
  "cancellation.applied": z.object({ code: TraceCodeSchema, step: count }).strict(),

  "failure.detected": z.object({ source: z.enum(["runtime", "durability"]), code: TraceCodeSchema, category: FailureCategorySchema.optional(), step: count.optional(), attempt: positive.optional(), causeCode: TraceCodeSchema.optional(), executorFailure: ExecutorFailureTraceSchema.optional() }).strict(),
} as const;

export type TraceEventType = keyof typeof TRACE_EVENT_PAYLOAD_SCHEMAS;
export const TRACE_EVENT_TYPES = Object.freeze(Object.keys(TRACE_EVENT_PAYLOAD_SCHEMAS).sort() as TraceEventType[]);
export const TraceEventTypeSchema = z.enum(TRACE_EVENT_TYPES as unknown as [TraceEventType, ...TraceEventType[]]);
export type TracePayload<T extends TraceEventType> = z.infer<(typeof TRACE_EVENT_PAYLOAD_SCHEMAS)[T]>;

/** The canonical status of each type; absent where a status has no meaning (routing, state, retry, checkpoint, recovery bookkeeping). */
export const TRACE_EVENT_STATUS: Readonly<Partial<Record<TraceEventType, TraceStatus>>> = Object.freeze({
  "run.started": "started",
  "run.completed": "succeeded",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "node.started": "started",
  "node.completed": "succeeded",
  "node.failed": "failed",
  "node.waiting": "waiting",
  "model.call.started": "started",
  "model.call.completed": "succeeded",
  "model.call.failed": "failed",
  "agent.started": "started",
  "agent.completed": "succeeded",
  "agent.failed": "failed",
  "tool.call.started": "started",
  "tool.call.completed": "succeeded",
  "tool.call.failed": "failed",
  "tool.call.blocked": "blocked",
  "approval.requested": "waiting",
  "recovery.blocked": "blocked",
});

/** Terminal Run events. At most one per trace. */
export const TRACE_TERMINAL_EVENT_TYPES: readonly TraceEventType[] = Object.freeze(["run.completed", "run.failed", "run.cancelled"]);

// --- Span references (semantic span identity; the recorder derives span ids) ------------

/**
 * Stable semantic identity of a span. Span ids are derived from these, never
 * random, so a durable recovery replay of the same logical operation keeps
 * its identity: Run → traceId; Node attempt → node + step + attempt; Tool →
 * toolExecutionId + attempt; Model → invocationId + attempt; Agent →
 * agentExecutionId + attempt.
 */
export const TraceSpanRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run") }).strict(),
  z.object({ kind: z.literal("node"), nodeId: NodeIdSchema, step: positive, attempt: positive }).strict(),
  z.object({ kind: z.literal("tool"), toolExecutionId: identifierSchema, attempt: positive }).strict(),
  z.object({ kind: z.literal("model"), invocationId: identifierSchema, attempt: positive }).strict(),
  z.object({ kind: z.literal("agent"), agentExecutionId: identifierSchema, attempt: positive }).strict(),
]);
export type TraceSpanRef = z.infer<typeof TraceSpanRefSchema>;

/** Small, flat, JSON-safe discriminator of one logical event within its type and Node (e.g. step, attempt, replay). It determines the event id. */
export const TraceEventKeySchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/), z.union([z.string().max(256), z.number().int(), z.boolean()])).refine((key) => Object.keys(key).length <= 16, "at most 16 key fields");
export type TraceEventKey = z.infer<typeof TraceEventKeySchema>;

// --- Draft: what an authoritative component hands to a trace port -------------------

const draftBase = {
  runId: RunIdSchema,
  workflowId: WorkflowIdSchema,
  workflowVersion: entityVersionSchema,
  nodeId: NodeIdSchema.optional(),
  span: TraceSpanRefSchema,
  parentSpan: TraceSpanRefSchema.optional(),
  key: TraceEventKeySchema,
};

/** Recorder-derived/host-supplied fields of `run.started`; an emitter never supplies them. */
const RunStartedDraftPayloadSchema = TRACE_EVENT_PAYLOAD_SCHEMAS["run.started"].omit({ reliabilityPolicyFingerprint: true, release: true });

/**
 * One typed observation from an authoritative component, before the trace
 * recorder assigns identity (trace id, event id, span ids), ordering
 * (sequence), and time. Every draft is schema-validated before storage.
 */
export const TraceEventDraftSchema = z.discriminatedUnion(
  "type",
  TRACE_EVENT_TYPES.map((type) => z.object({ ...draftBase, type: z.literal(type), payload: type === "run.started" ? RunStartedDraftPayloadSchema : TRACE_EVENT_PAYLOAD_SCHEMAS[type] }).strict()) as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]],
);
type DraftPayload<T extends TraceEventType> = T extends "run.started" ? z.infer<typeof RunStartedDraftPayloadSchema> : TracePayload<T>;
export type TraceEventDraft = {
  [T in TraceEventType]: { type: T; runId: string; workflowId: string; workflowVersion: string; nodeId?: string; span: TraceSpanRef; parentSpan?: TraceSpanRef; key: TraceEventKey; payload: DraftPayload<T> };
}[TraceEventType];

// --- Envelope ----------------------------------------------------------------------

/** Maximum serialized size of one Trace Event. Typed metadata events are far smaller; anything larger is a trace issue, never truncated. */
export const MAX_TRACE_EVENT_BYTES = 32 * 1024;

/**
 * The canonical Trace Event envelope, schema version 2. `sequence` (per-Run,
 * contiguous from 0) is the authoritative order; `occurredAt` is descriptive
 * time only. `status` is the type's canonical status, present exactly when
 * the type has one. The payload is validated against the type's schema.
 */
export const TraceEventSchema = z
  .object({
    schemaVersion: schemaVersionSchema(2),
    eventId: TraceEventIdSchema,
    traceId: TraceIdSchema,
    runId: RunIdSchema,
    sequence: z.number().int().nonnegative(),
    occurredAt: isoTimestampSchema,
    type: TraceEventTypeSchema,
    workflowId: WorkflowIdSchema,
    workflowVersion: entityVersionSchema,
    nodeId: NodeIdSchema.optional(),
    spanId: SpanIdSchema,
    parentSpanId: SpanIdSchema.optional(),
    status: TraceStatusSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((event, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const parsed = TRACE_EVENT_PAYLOAD_SCHEMAS[event.type].safeParse(event.payload);
    if (!parsed.success) issue("payload", `payload does not match the "${event.type}" schema`);
    if (event.status !== TRACE_EVENT_STATUS[event.type]) issue("status", `status must be the canonical status of "${event.type}"`);
    if (event.parentSpanId !== undefined && event.parentSpanId === event.spanId) issue("parentSpanId", "a span cannot be its own parent");
  });
export type TraceEvent = Omit<z.infer<typeof TraceEventSchema>, "payload"> & { payload: Record<string, unknown> };
