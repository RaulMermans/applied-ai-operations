import { createHash } from "node:crypto";
import { z } from "zod";
import { ApprovalRecordSchema, PermissionClassesSchema, PrincipalSchema, RunIdSchema, NodeIdSchema, canonicalJsonStringify, identifierSchema, isoTimestampSchema, type ApprovalRecord, type JsonValue, type Principal } from "@aao/contracts";
import { resolveAuthority, type GovernanceRegistry } from "@aao/governance";
import { continueWaitingWorkflow, isJsonSafe, type ContinueWaitingWorkflowRequest, type NodeExecutor, type RuntimeClock, type WorkflowExecutionResult } from "@aao/runtime";

const ApprovalNodeConfigSchema = z.object({
  subjectStateKey: identifierSchema,
  permissionClasses: PermissionClassesSchema,
  requiredApproverRoleIds: z.array(identifierSchema).min(1).refine((ids) => new Set(ids).size === ids.length),
  allowSelfApproval: z.boolean().optional(),
}).strict();
export type ApprovalNodeConfig = z.infer<typeof ApprovalNodeConfigSchema>;

const RequestSchema = z.object({
  approvalId: identifierSchema, runId: RunIdSchema, nodeId: NodeIdSchema,
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/), requestedBy: PrincipalSchema,
  requiredApproverRoleIds: z.array(identifierSchema).min(1).refine((ids) => new Set(ids).size === ids.length),
  permissionClasses: PermissionClassesSchema, allowSelfApproval: z.boolean(),
}).strict();
export type ApprovalRequest = z.infer<typeof RequestSchema>;

export class ApprovalError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ApprovalError"; }
}

/** SHA-256 of canonical JSON-safe run/node/revision/subject material. No payload enters the record. */
export function fingerprintApprovalSubject(runId: string, nodeId: string, revision: number, subject: unknown): string {
  if (!RunIdSchema.safeParse(runId).success || !NodeIdSchema.safeParse(nodeId).success || !Number.isSafeInteger(revision) || revision < 0 || !isJsonSafe(subject)) throw new ApprovalError("INVALID_APPROVAL_CONTEXT");
  return createHash("sha256").update(canonicalJsonStringify({ runId, nodeId, revision, subject: subject as JsonValue })).digest("hex");
}
export function approvalIdForFingerprint(runId: string, nodeId: string, fingerprint: string): string {
  return `approval:${createHash("sha256").update(canonicalJsonStringify({ runId, nodeId, fingerprint })).digest("hex")}`;
}

function immutableRecord(record: ApprovalRecord): ApprovalRecord {
  return Object.freeze({ ...record, requestedBy: Object.freeze({ ...record.requestedBy }), ...(record.resolvedBy ? { resolvedBy: Object.freeze({ ...record.resolvedBy }) } : {}), requiredApproverRoleIds: Object.freeze([...record.requiredApproverRoleIds]) as unknown as string[], permissionClasses: Object.freeze([...record.permissionClasses]) as unknown as ApprovalRecord["permissionClasses"] });
}

/** Explicit process-local storage and clock. The trusted host supplies its Governance registry. */
export function createApprovalEngine(dependencies: { governance: GovernanceRegistry; clock: RuntimeClock }) {
  const records = new Map<string, ApprovalRecord>();
  const continued = new Set<string>();
  const getApproval = (id: string) => records.get(id);
  const requestApproval = (input: ApprovalRequest): ApprovalRecord => {
    const parsed = RequestSchema.safeParse(input);
    if (!parsed.success) throw new ApprovalError("INVALID_APPROVAL_CONTEXT");
    if (resolveAuthority(dependencies.governance, parsed.data.requestedBy, parsed.data.permissionClasses).decision !== "ALLOW") throw new ApprovalError("APPROVAL_REQUESTER_NOT_AUTHORIZED");
    const existing = records.get(input.approvalId);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint || existing.runId !== input.runId || existing.nodeId !== input.nodeId) throw new ApprovalError("APPROVAL_REQUEST_MISMATCH");
      if (canonicalJsonStringify({ requestedBy: existing.requestedBy, permissionClasses: existing.permissionClasses, requiredApproverRoleIds: existing.requiredApproverRoleIds, allowSelfApproval: existing.allowSelfApproval }) !== canonicalJsonStringify({ requestedBy: input.requestedBy, permissionClasses: input.permissionClasses, requiredApproverRoleIds: input.requiredApproverRoleIds, allowSelfApproval: input.allowSelfApproval })) throw new ApprovalError("APPROVAL_REQUEST_MISMATCH");
      if (existing.status !== "pending") throw new ApprovalError("APPROVAL_ALREADY_RESOLVED");
      return existing;
    }
    const record = immutableRecord(ApprovalRecordSchema.parse({ schemaVersion: 2, ...parsed.data, status: "pending", requestedAt: dependencies.clock.now() }));
    records.set(record.approvalId, record);
    return record;
  };
  const resolve = (id: string, status: "approved" | "rejected" | "expired" | "cancelled", principal?: Principal): ApprovalRecord => {
    const prior = records.get(id);
    if (!prior) throw new ApprovalError("APPROVAL_NOT_FOUND");
    if (prior.status !== "pending") throw new ApprovalError("APPROVAL_ALREADY_RESOLVED");
    if (status === "approved" || status === "rejected") {
      const parsed = PrincipalSchema.safeParse(principal);
      if (!parsed.success || parsed.data.type !== "user") throw new ApprovalError("APPROVAL_HUMAN_REQUIRED");
      const decision = resolveAuthority(dependencies.governance, parsed.data, prior.permissionClasses);
      if (decision.decision !== "ALLOW" || !decision.authority || !decision.authority.roleIds.some((role) => prior.requiredApproverRoleIds.includes(role))) throw new ApprovalError("APPROVAL_RESOLVER_NOT_ELIGIBLE");
      if (!prior.allowSelfApproval && prior.requestedBy.id === parsed.data.id) throw new ApprovalError("APPROVAL_SELF_APPROVAL_FORBIDDEN");
    }
    const resolvedAt = dependencies.clock.now();
    if (!isoTimestampSchema.safeParse(resolvedAt).success) throw new ApprovalError("INVALID_APPROVAL_CONTEXT");
    const parsed = ApprovalRecordSchema.safeParse({ ...prior, status, resolvedAt, ...(principal ? { resolvedBy: principal } : {}) });
    if (!parsed.success) throw new ApprovalError("INVALID_APPROVAL_CONTEXT");
    const record = immutableRecord(parsed.data);
    records.set(id, record);
    return record;
  };
  const claimContinuation = (id: string): boolean => { if (continued.has(id)) return false; continued.add(id); return true; };
  const releaseContinuation = (id: string): void => { continued.delete(id); };
  return Object.freeze({ requestApproval, getApproval, claimContinuation, releaseContinuation, approve: (id: string, principal: Principal) => resolve(id, "approved", principal), reject: (id: string, principal: Principal) => resolve(id, "rejected", principal), expire: (id: string) => resolve(id, "expired"), cancel: (id: string, principal?: Principal) => resolve(id, "cancelled", principal) });
}
export type ApprovalEngine = ReturnType<typeof createApprovalEngine>;

/** Host-only callback supplies the requester; workflow state and node config cannot do so. */
export function createApprovalNodeExecutor(engine: ApprovalEngine, requesterForRun: (runId: string) => Principal): NodeExecutor {
  return {
    kind: "approval",
    validateConfig({ node }) { return ApprovalNodeConfigSchema.safeParse(node.config).success ? { ok: true } : { ok: false, issues: ["Invalid approval node configuration."] }; },
    async execute({ runId, node, state }) {
      const config = ApprovalNodeConfigSchema.parse(node.config);
      const subject = state.values[config.subjectStateKey];
      if (subject === undefined || !isJsonSafe(subject)) return { ok: false, failure: { namespace: "approval", code: "INVALID_APPROVAL_CONTEXT" } };
      const requestedBy = PrincipalSchema.parse(requesterForRun(runId));
      const requestFingerprint = fingerprintApprovalSubject(runId, node.id, state.revision, subject);
      const approvalId = approvalIdForFingerprint(runId, node.id, requestFingerprint);
      engine.requestApproval({ approvalId, runId, nodeId: node.id, requestFingerprint, requestedBy, requiredApproverRoleIds: config.requiredApproverRoleIds, permissionClasses: config.permissionClasses, allowSelfApproval: config.allowSelfApproval ?? false });
      return { ok: true, wait: { kind: "approval", referenceId: approvalId, requestFingerprint } };
    },
  };
}

/** Recompute against authoritative state before passing the current fingerprint to Runtime. */
export function currentApprovalFingerprint(execution: { run: { runId: string }; state: { revision: number; values: Record<string, JsonValue> }; wait?: { nodeId: string } }, config: ApprovalNodeConfig): string {
  if (!execution.wait) throw new ApprovalError("INVALID_APPROVAL_CONTEXT");
  const parsed = ApprovalNodeConfigSchema.parse(config);
  const subject = execution.state.values[parsed.subjectStateKey];
  return fingerprintApprovalSubject(execution.run.runId, execution.wait.nodeId, execution.state.revision, subject);
}

/** Trusted host bridge: read the engine's immutable record and recompute the exact subject before continuation. */
export async function continueApprovedWorkflow(engine: ApprovalEngine, request: Omit<ContinueWaitingWorkflowRequest, "approval" | "currentRequestFingerprint">): Promise<WorkflowExecutionResult> {
  const wait = request.execution.wait;
  const record = wait ? engine.getApproval(wait.referenceId) : undefined;
  if (!record) return { ok: false, failure: { code: "INVALID_APPROVAL_CONTEXT", message: "INVALID_APPROVAL_CONTEXT" }, execution: request.execution };
  const node = request.plan.nodesById[wait!.nodeId];
  const config = ApprovalNodeConfigSchema.safeParse(node?.config);
  if (!config.success) return { ok: false, failure: { code: "INVALID_APPROVAL_CONTEXT", message: "INVALID_APPROVAL_CONTEXT" }, execution: request.execution };
  let currentRequestFingerprint: string;
  try { currentRequestFingerprint = currentApprovalFingerprint(request.execution, config.data); }
  catch { return { ok: false, failure: { code: "APPROVAL_REQUEST_MISMATCH", message: "APPROVAL_REQUEST_MISMATCH" }, execution: request.execution }; }
  if (record.status !== "pending" && currentRequestFingerprint === record.requestFingerprint) {
    if (!engine.claimContinuation(record.approvalId)) return { ok: false, failure: { code: "INVALID_APPROVAL_CONTEXT", message: "INVALID_APPROVAL_CONTEXT" }, execution: request.execution };
  }
  try {
    const result = await continueWaitingWorkflow({ ...request, approval: record, currentRequestFingerprint });
    if (!result.ok && ["INVALID_APPROVAL_CONTEXT", "APPROVAL_REQUEST_MISMATCH", "APPROVAL_STILL_PENDING"].includes(result.failure.code)) engine.releaseContinuation(record.approvalId);
    return result;
  } catch (error) { engine.releaseContinuation(record.approvalId); throw error; }
}
