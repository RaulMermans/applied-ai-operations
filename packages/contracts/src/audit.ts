import { z } from "zod";
import { AgentIdSchema, ApprovalIdSchema, NodeIdSchema, RunIdSchema, ToolIdSchema, entityVersionSchema, identifierSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";
import { PermissionClassesSchema, PrincipalSchema } from "./governance.js";

/**
 * Canonical AAO Audit contract, schema version 1 (ADR-021,
 * docs/architecture/audit.md). Audit is *accountability evidence*: who
 * requested, decided, or was refused a security/governance-relevant action,
 * and when. It is recorded at the authoritative source boundary (Approval
 * repository transition, Tool authorization decision, durable cancellation
 * request), never reconstructed from Trace.
 *
 * Audit is separate from Trace (chronology) and from every execution
 * authority. Nothing in AAO reads Audit to allow, deny, approve, replay, or
 * recover anything. Payloads are metadata-only and stricter than Trace:
 * identifiers, reason codes, permission classes, role ids, and fingerprints —
 * never subjects, Tool input/output, prompts, model output, state, raw
 * errors, credentials, or profile data.
 */

/** A bounded machine-readable reason code reused from an existing AAO taxonomy. Never free text. */
export const AuditCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().min(1);
const count = z.number().int().nonnegative();
const ToolAgentRefSchema = z.object({ id: AgentIdSchema, version: entityVersionSchema }).strict();

/** Fixed genesis value: the `previousHash` of every stream's first event. Never null or empty, so implementations cannot disagree. */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

/** Audit events are smaller than Trace events: metadata only, never truncated. */
export const MAX_AUDIT_EVENT_BYTES = 16 * 1024;

/** `aud.` followed by 32 lowercase hex characters derived from stream, type, and the emitter's semantic key. */
export const AuditEventIdSchema = z.string().regex(/^aud\.[a-f0-9]{32}$/);

/**
 * Explicit, deterministic audit streams. V1 implements only Run-bound
 * streams (`run:<runId>`); the `<kind>:` prefix leaves room for future
 * `system`, `policy`, or `deployment` streams without changing the envelope.
 */
export const AUDIT_STREAM_KINDS = ["run"] as const;
export const AuditStreamIdSchema = z.string().max(300).refine((value) => value.startsWith("run:") && RunIdSchema.safeParse(value.slice(4)).success, "must be run:<runId>");
export function auditStreamIdForRun(runId: string): string {
  return `run:${runId}`;
}

/** Reasons an Approval resolution attempt was refused. Existing Approval Engine codes only. */
export const ApprovalResolutionDenialCodeSchema = z.enum(["APPROVAL_HUMAN_REQUIRED", "APPROVAL_RESOLVER_NOT_ELIGIBLE", "APPROVAL_SELF_APPROVAL_FORBIDDEN", "APPROVAL_ALREADY_RESOLVED"]);
export type ApprovalResolutionDenialCode = z.infer<typeof ApprovalResolutionDenialCodeSchema>;

/**
 * The V1 audit catalog: only actions AAO performs today. Policy changes,
 * operator overrides, kill switches, side-effect execution, deployment, and
 * secret rotation are absent because those capabilities do not exist.
 */
export const AUDIT_EVENT_PAYLOAD_SCHEMAS = {
  /** The Approval subject is never recorded; `requestFingerprint` binds it. `occurredAt` is the record's `requestedAt`. */
  "approval.requested": z.object({ approvalId: ApprovalIdSchema, nodeId: NodeIdSchema, requiredApproverRoleIds: z.array(identifierSchema).min(1).max(64), permissionClasses: PermissionClassesSchema, allowSelfApproval: z.boolean(), requestFingerprint: hex64 }).strict(),
  /** The authoritative `pending → approved | rejected` transition. `occurredAt` is the record's `resolvedAt`; the actor is `resolvedBy`. */
  "approval.resolved": z.object({ approvalId: ApprovalIdSchema, nodeId: NodeIdSchema, decision: z.enum(["approved", "rejected"]), requestFingerprint: hex64 }).strict(),
  /** A refused resolution attempt. The Approval stays as it was; the actor is the attempted resolver. */
  "approval.resolution_denied": z.object({ approvalId: ApprovalIdSchema, nodeId: NodeIdSchema, attemptedDecision: z.enum(["approved", "rejected"]), reasonCode: ApprovalResolutionDenialCodeSchema }).strict(),
  /** Authorization allowed the Tool invocation path to continue. It does not mean the Tool succeeded. */
  "tool.access.allowed": z.object({ toolExecutionId: identifierSchema, attempt: positive, nodeId: NodeIdSchema.optional(), permissionClasses: PermissionClassesSchema, agentRef: ToolAgentRefSchema.optional(), agentCeilingApplied: z.boolean() }).strict(),
  /** Authorization denied the Tool invocation; the handler was never invoked. */
  "tool.access.denied": z.object({ toolExecutionId: identifierSchema, attempt: positive, nodeId: NodeIdSchema.optional(), permissionClasses: PermissionClassesSchema, agentRef: ToolAgentRefSchema.optional(), reasonCode: AuditCodeSchema }).strict(),
  /** A durable cancellation request was accepted. `occurredAt` is the record's `requestedAt`. No free-text reason. */
  "run.cancellation.requested": z.object({ reasonCode: AuditCodeSchema.optional() }).strict(),
  /** The Runtime reached the safe boundary and the Run became CANCELLED. The actor is the accountable requester. */
  "run.cancellation.applied": z.object({ step: count, nodeId: NodeIdSchema.optional(), requestedAt: isoTimestampSchema }).strict(),
} as const;

export type AuditEventType = keyof typeof AUDIT_EVENT_PAYLOAD_SCHEMAS;
export const AUDIT_EVENT_TYPES = Object.freeze(Object.keys(AUDIT_EVENT_PAYLOAD_SCHEMAS).sort() as AuditEventType[]);
export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES as unknown as [AuditEventType, ...AuditEventType[]]);
export type AuditPayload<T extends AuditEventType> = z.infer<(typeof AUDIT_EVENT_PAYLOAD_SCHEMAS)[T]>;

/** The canonical action each type records. Fixed: never chosen by an emitter. */
export const AUDIT_EVENT_ACTION: Readonly<Record<AuditEventType, string>> = Object.freeze({
  "approval.requested": "approval.request",
  "approval.resolved": "approval.resolve",
  "approval.resolution_denied": "approval.resolve",
  "tool.access.allowed": "tool.execute",
  "tool.access.denied": "tool.execute",
  "run.cancellation.requested": "run.cancel",
  "run.cancellation.applied": "run.cancel",
});

export const AuditOutcomeSchema = z.enum(["requested", "approved", "rejected", "denied", "allowed", "applied"]);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/** The canonical outcome of an event: fixed per type, except an Approval resolution, whose outcome is its decision. */
export function auditOutcomeOf(type: AuditEventType, payload: Record<string, unknown>): AuditOutcome {
  switch (type) {
    case "approval.requested":
    case "run.cancellation.requested":
      return "requested";
    case "approval.resolved":
      return payload.decision === "rejected" ? "rejected" : "approved";
    case "approval.resolution_denied":
    case "tool.access.denied":
      return "denied";
    case "tool.access.allowed":
      return "allowed";
    case "run.cancellation.applied":
      return "applied";
  }
}

/** What the action was performed on. Identity only. */
export const AuditTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approval"), approvalId: ApprovalIdSchema }).strict(),
  z.object({ kind: z.literal("tool"), toolId: ToolIdSchema, toolVersion: entityVersionSchema }).strict(),
  z.object({ kind: z.literal("run"), runId: RunIdSchema }).strict(),
]);
export type AuditTarget = z.infer<typeof AuditTargetSchema>;

const TARGET_KIND: Readonly<Record<AuditEventType, AuditTarget["kind"]>> = Object.freeze({
  "approval.requested": "approval",
  "approval.resolved": "approval",
  "approval.resolution_denied": "approval",
  "tool.access.allowed": "tool",
  "tool.access.denied": "tool",
  "run.cancellation.requested": "run",
  "run.cancellation.applied": "run",
});

/**
 * Types whose time is an authoritative fact of the source record
 * (`requestedAt`, `resolvedAt`). Their drafts must carry `occurredAt`; the
 * recorder never substitutes its own clock for them.
 */
export const AUDIT_SOURCE_TIMED_EVENT_TYPES: readonly AuditEventType[] = Object.freeze(["approval.requested", "approval.resolved", "run.cancellation.requested", "run.cancellation.applied"]);

/** Small, flat discriminator of one logical event within its stream and type. It determines the event id. */
export const AuditEventKeySchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/), z.union([z.string().max(256), z.number().int(), z.boolean()])).refine((key) => Object.keys(key).length <= 16, "at most 16 key fields");
export type AuditEventKey = z.infer<typeof AuditEventKeySchema>;

// --- Draft: what an authoritative boundary hands to an Audit port -------------------

/**
 * One accountability observation from an authoritative boundary, before the
 * recorder assigns identity, sequence, and the hash chain. The actor is the
 * host-attested principal (id + type only). `occurredAt` is required for
 * source-timed types and optional otherwise (the recorder's trusted clock
 * then stamps the decision time in the same call stack).
 */
export const AuditEventDraftSchema = z.discriminatedUnion(
  "type",
  AUDIT_EVENT_TYPES.map((type) =>
    z.object({ type: z.literal(type), runId: RunIdSchema, actor: PrincipalSchema, target: AuditTargetSchema, occurredAt: isoTimestampSchema.optional(), key: AuditEventKeySchema, payload: AUDIT_EVENT_PAYLOAD_SCHEMAS[type] }).strict(),
  ) as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]],
).superRefine((draft, ctx) => {
  const type = draft.type as AuditEventType;
  if ((draft.target as AuditTarget).kind !== TARGET_KIND[type]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: `target must be a ${TARGET_KIND[type]}` });
  if (AUDIT_SOURCE_TIMED_EVENT_TYPES.includes(type) && draft.occurredAt === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["occurredAt"], message: `"${type}" requires its authoritative source time` });
});
export type AuditEventDraft = {
  [T in AuditEventType]: { type: T; runId: string; actor: { id: string; type: "user" | "service" | "system" }; target: AuditTarget; occurredAt?: string; key: AuditEventKey; payload: AuditPayload<T> };
}[AuditEventType];

/**
 * The emit-only Audit port an authoritative boundary may receive (Approval
 * Engine, Tool Runtime, durable host). Implemented by `@aao/observability`'s
 * Audit recorder; execution packages never import it. There is
 * deliberately no read method, so no execution decision can consult Audit.
 * `emit` must not throw into its caller; callers use `emitAuditSafely`.
 */
export interface AuditPort {
  emit(draft: AuditEventDraft): void | Promise<void>;
}

/**
 * Fire-and-forget emission that can never change the caller's behavior: a
 * missing port is a no-op, and a throwing or rejecting port is swallowed.
 * The authoritative action has already happened; Audit failure never rolls
 * it back or causes a retry.
 */
export function emitAuditSafely(port: AuditPort | undefined, draft: AuditEventDraft): void {
  if (port === undefined) return;
  try {
    const pending = port.emit(draft);
    if (pending && typeof (pending as Promise<void>).then === "function") (pending as Promise<void>).then(undefined, () => undefined);
  } catch {
    // Audit failure is never execution truth.
  }
}

// --- Envelope ----------------------------------------------------------------------

/**
 * The canonical Audit Event envelope, schema version 1. `sequence`
 * (contiguous from 0 per stream) is the authoritative order. `previousHash`
 * is the prior event's `eventHash` (or `AUDIT_GENESIS_HASH`), and
 * `eventHash` is SHA-256 over the canonical event without `eventHash`
 * (computed and verified by `@aao/observability`). `action`, `outcome`, and
 * the target kind are fixed by the type.
 */
export const AuditEventSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    eventId: AuditEventIdSchema,
    streamId: AuditStreamIdSchema,
    sequence: z.number().int().nonnegative(),
    occurredAt: isoTimestampSchema,
    type: AuditEventTypeSchema,
    runId: RunIdSchema,
    actor: PrincipalSchema,
    action: z.string().min(1).max(64),
    target: AuditTargetSchema,
    outcome: AuditOutcomeSchema,
    payload: z.record(z.string(), z.unknown()),
    previousHash: hex64,
    eventHash: hex64,
  })
  .strict()
  .superRefine((event, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (!AUDIT_EVENT_PAYLOAD_SCHEMAS[event.type].safeParse(event.payload).success) issue("payload", `payload does not match the "${event.type}" schema`);
    if (event.streamId !== auditStreamIdForRun(event.runId)) issue("streamId", "a Run-bound event belongs to the run:<runId> stream");
    if (event.action !== AUDIT_EVENT_ACTION[event.type]) issue("action", `action must be the canonical action of "${event.type}"`);
    if (event.outcome !== auditOutcomeOf(event.type, event.payload)) issue("outcome", `outcome must be the canonical outcome of "${event.type}"`);
    if (event.target.kind !== TARGET_KIND[event.type]) issue("target", `target must be a ${TARGET_KIND[event.type]}`);
    if (event.target.kind === "run" && event.target.runId !== event.runId) issue("target", "a Run target must be the event's Run");
    if (event.target.kind === "approval" && event.target.approvalId !== event.payload.approvalId) issue("target", "an Approval target must match the payload approvalId");
    if (event.sequence === 0 && event.previousHash !== AUDIT_GENESIS_HASH) issue("previousHash", "the first event of a stream chains from the genesis hash");
  });
export type AuditEvent = Omit<z.infer<typeof AuditEventSchema>, "payload"> & { payload: Record<string, unknown> };
