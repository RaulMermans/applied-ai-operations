import { createHash } from "node:crypto";
import { z } from "zod";
import { ApprovalRecordSchema, PermissionClassesSchema, PrincipalSchema, RunIdSchema, NodeIdSchema, canonicalJsonStringify, emitAuditSafely, identifierSchema, isoTimestampSchema, type ApprovalRecord, type ApprovalResolutionDenialCode, type AuditPort, type JsonValue, type Principal } from "@aao/contracts";
import { resolveAuthority, resolveRoleMembership, type GovernanceRegistry } from "@aao/governance";
import { continueWaitingWorkflow, isJsonSafe, type ContinueWaitingWorkflowRequest, type NodeExecutor, type RuntimeClock, type RuntimeTracePort, type WorkflowExecutionResult } from "@aao/runtime";

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

/**
 * Approval storage port (ADR-019). The engine owns every Approval semantic —
 * validation, eligibility, immutability, exact-request idempotency — and the
 * repository only stores validated records. `compareAndSetResolution` is the
 * atomic `pending → terminal` step: it succeeds only while the stored record
 * is still `pending`, so two resolutions can never both win. Synchronous by
 * the Sprint 12 engine contract; `@aao/durability` provides a local
 * filesystem implementation, and this package never touches storage itself.
 */
export interface ApprovalRepository {
  get(approvalId: string): ApprovalRecord | undefined;
  /** Stores a new pending record. Returns the already-stored record instead when one exists for that id (no overwrite). */
  create(record: ApprovalRecord): ApprovalRecord;
  /** Replaces a `pending` record with its resolution. Returns false, writing nothing, when the stored record is no longer `pending`. */
  compareAndSetResolution(approvalId: string, resolved: ApprovalRecord): boolean;
}

/** Process-local repository: the Sprint 12 behavior, for nondurable use. A crash loses its approvals. */
export function createInMemoryApprovalRepository(): ApprovalRepository {
  const records = new Map<string, ApprovalRecord>();
  return Object.freeze({
    get: (approvalId: string) => records.get(approvalId),
    create(record: ApprovalRecord): ApprovalRecord {
      const existing = records.get(record.approvalId);
      if (existing) return existing;
      const stored = immutableRecord(record);
      records.set(stored.approvalId, stored);
      return stored;
    },
    compareAndSetResolution(approvalId: string, resolved: ApprovalRecord): boolean {
      if (records.get(approvalId)?.status !== "pending") return false;
      records.set(approvalId, immutableRecord(resolved));
      return true;
    },
  });
}

/** Deterministic evidence of the trusted Governance configuration (ADR-019). Evidence only: it never grants or restores authority. */
export function fingerprintGovernance(governance: GovernanceRegistry): string {
  return createHash("sha256").update(canonicalJsonStringify({ domain: "aao.governance.v1", configuration: governance.configuration as unknown as JsonValue })).digest("hex");
}

/**
 * Explicit storage and clock. The trusted host supplies its Governance
 * registry and, optionally, a repository (default: process-local memory)
 * and an emit-only Audit port (ADR-021).
 *
 * Audit is recorded at this authoritative boundary, from the stored record:
 * a request when it is created, a resolution only after the repository's
 * atomic `pending → approved | rejected` transition succeeded (at the
 * record's true `resolvedAt`, by its `resolvedBy`), and a refused resolution
 * attempt with its bounded reason. Audit is one-way evidence: the engine
 * never reads it, and an Audit failure never changes or rolls back an
 * Approval decision.
 */
export function createApprovalEngine(dependencies: { governance: GovernanceRegistry; clock: RuntimeClock; repository?: ApprovalRepository; audit?: AuditPort }) {
  const repository = dependencies.repository ?? createInMemoryApprovalRepository();
  const audit = dependencies.audit;
  const auditRequested = (record: ApprovalRecord) => emitAuditSafely(audit, { type: "approval.requested", runId: record.runId, actor: { id: record.requestedBy.id, type: record.requestedBy.type }, target: { kind: "approval", approvalId: record.approvalId }, occurredAt: record.requestedAt, key: { approvalId: record.approvalId }, payload: { approvalId: record.approvalId, nodeId: record.nodeId, requiredApproverRoleIds: [...record.requiredApproverRoleIds], permissionClasses: [...record.permissionClasses], allowSelfApproval: record.allowSelfApproval, requestFingerprint: record.requestFingerprint } });
  const auditResolved = (record: ApprovalRecord) => {
    if ((record.status !== "approved" && record.status !== "rejected") || !record.resolvedBy || !record.resolvedAt) return;
    emitAuditSafely(audit, { type: "approval.resolved", runId: record.runId, actor: { id: record.resolvedBy.id, type: record.resolvedBy.type }, target: { kind: "approval", approvalId: record.approvalId }, occurredAt: record.resolvedAt, key: { approvalId: record.approvalId }, payload: { approvalId: record.approvalId, nodeId: record.nodeId, decision: record.status, requestFingerprint: record.requestFingerprint } });
  };
  /** Only an attributable attempt (a well-formed principal) is auditable; the actor is the attempted resolver, never fabricated. */
  const auditDenied = (record: ApprovalRecord, decision: "approved" | "rejected", principal: unknown, reasonCode: ApprovalResolutionDenialCode) => {
    const actor = PrincipalSchema.safeParse(principal);
    if (!actor.success) return;
    const occurredAt = dependencies.clock.now();
    emitAuditSafely(audit, { type: "approval.resolution_denied", runId: record.runId, actor: { id: actor.data.id, type: actor.data.type }, target: { kind: "approval", approvalId: record.approvalId }, occurredAt, key: { approvalId: record.approvalId, resolverId: actor.data.id, decision, reasonCode, at: occurredAt }, payload: { approvalId: record.approvalId, nodeId: record.nodeId, attemptedDecision: decision, reasonCode } });
  };
  const continued = new Set<string>();
  const getApproval = (id: string) => repository.get(id);
  const sameRequest = (existing: ApprovalRecord, input: ApprovalRequest) =>
    existing.requestFingerprint === input.requestFingerprint && existing.runId === input.runId && existing.nodeId === input.nodeId &&
    canonicalJsonStringify({ requestedBy: existing.requestedBy, permissionClasses: existing.permissionClasses, requiredApproverRoleIds: existing.requiredApproverRoleIds, allowSelfApproval: existing.allowSelfApproval }) === canonicalJsonStringify({ requestedBy: input.requestedBy, permissionClasses: input.permissionClasses, requiredApproverRoleIds: input.requiredApproverRoleIds, allowSelfApproval: input.allowSelfApproval });
  /**
   * Exact-request idempotent: the same approval id with the same run, node,
   * fingerprint, and request metadata returns the stored record — including
   * an already-resolved one, which is never reopened or duplicated, so an
   * Approval Node can be replayed safely after a crash. Anything else under
   * that id is `APPROVAL_REQUEST_MISMATCH`.
   */
  const requestApproval = (input: ApprovalRequest): ApprovalRecord => {
    const parsed = RequestSchema.safeParse(input);
    if (!parsed.success) throw new ApprovalError("INVALID_APPROVAL_CONTEXT");
    if (resolveAuthority(dependencies.governance, parsed.data.requestedBy, parsed.data.permissionClasses).decision !== "ALLOW") throw new ApprovalError("APPROVAL_REQUESTER_NOT_AUTHORIZED");
    const existing = repository.get(parsed.data.approvalId);
    if (existing) {
      if (!sameRequest(existing, parsed.data)) throw new ApprovalError("APPROVAL_REQUEST_MISMATCH");
      // Same stored record, same audit event: the recorder deduplicates an exact-request replay.
      auditRequested(existing);
      return existing;
    }
    const record = ApprovalRecordSchema.parse({ schemaVersion: 2, ...parsed.data, status: "pending", requestedAt: dependencies.clock.now() });
    const stored = repository.create(record);
    if (!sameRequest(stored, parsed.data)) throw new ApprovalError("APPROVAL_REQUEST_MISMATCH");
    auditRequested(stored);
    return stored;
  };
  /** Eligibility = trusted registered human + current required-role membership + the self-approval rule. The approver need not hold the action's permissions. */
  const resolverIneligibility = (record: ApprovalRecord, principal: unknown): "APPROVAL_HUMAN_REQUIRED" | "APPROVAL_RESOLVER_NOT_ELIGIBLE" | "APPROVAL_SELF_APPROVAL_FORBIDDEN" | undefined => {
    const parsed = PrincipalSchema.safeParse(principal);
    if (!parsed.success || parsed.data.type !== "user") return "APPROVAL_HUMAN_REQUIRED";
    const membership = resolveRoleMembership(dependencies.governance, parsed.data);
    if (!membership || !membership.roleIds.some((role) => record.requiredApproverRoleIds.includes(role))) return "APPROVAL_RESOLVER_NOT_ELIGIBLE";
    if (!record.allowSelfApproval && record.requestedBy.id === parsed.data.id) return "APPROVAL_SELF_APPROVAL_FORBIDDEN";
    return undefined;
  };
  const resolve = (id: string, status: "approved" | "rejected" | "expired" | "cancelled", principal?: Principal): ApprovalRecord => {
    const prior = repository.get(id);
    if (!prior) throw new ApprovalError("APPROVAL_NOT_FOUND");
    const human = status === "approved" || status === "rejected";
    if (prior.status !== "pending") {
      if (human) auditDenied(prior, status, principal, "APPROVAL_ALREADY_RESOLVED");
      throw new ApprovalError("APPROVAL_ALREADY_RESOLVED");
    }
    if (human) {
      const ineligible = resolverIneligibility(prior, principal);
      if (ineligible) {
        auditDenied(prior, status, principal, ineligible);
        throw new ApprovalError(ineligible);
      }
    }
    const resolvedAt = dependencies.clock.now();
    if (!isoTimestampSchema.safeParse(resolvedAt).success) throw new ApprovalError("INVALID_APPROVAL_CONTEXT");
    const parsed = ApprovalRecordSchema.safeParse({ ...prior, status, resolvedAt, ...(principal ? { resolvedBy: principal } : {}) });
    if (!parsed.success) throw new ApprovalError("INVALID_APPROVAL_CONTEXT");
    // Atomic pending → terminal: a concurrent resolution that won first makes this one fail, never overwrite.
    if (!repository.compareAndSetResolution(id, parsed.data)) {
      if (human) auditDenied(prior, status, principal, "APPROVAL_ALREADY_RESOLVED");
      throw new ApprovalError("APPROVAL_ALREADY_RESOLVED");
    }
    const stored = repository.get(id)!;
    // Source-time Audit: emitted only after the authoritative transition committed, from the stored record.
    auditResolved(stored);
    return stored;
  };
  /**
   * A stored approval is evidence, never permanent authority. Before an
   * approved record is consumed, current Governance must still allow the
   * requester the stored permission classes and still find the resolver an
   * eligible registered human in a required role.
   */
  const revalidateApproved = (record: ApprovalRecord): "APPROVAL_REQUESTER_NOT_AUTHORIZED" | "APPROVAL_RESOLVER_NOT_ELIGIBLE" | undefined => {
    if (resolveAuthority(dependencies.governance, record.requestedBy, record.permissionClasses).decision !== "ALLOW") return "APPROVAL_REQUESTER_NOT_AUTHORIZED";
    if (record.status === "approved" && resolverIneligibility(record, record.resolvedBy) !== undefined) return "APPROVAL_RESOLVER_NOT_ELIGIBLE";
    return undefined;
  };
  const claimContinuation = (id: string): boolean => { if (continued.has(id)) return false; continued.add(id); return true; };
  const releaseContinuation = (id: string): void => { continued.delete(id); };
  return Object.freeze({ requestApproval, getApproval, claimContinuation, releaseContinuation, revalidateApproved, governanceFingerprint: fingerprintGovernance(dependencies.governance), approve: (id: string, principal: Principal) => resolve(id, "approved", principal), reject: (id: string, principal: Principal) => resolve(id, "rejected", principal), expire: (id: string) => resolve(id, "expired"), cancel: (id: string, principal?: Principal) => resolve(id, "cancelled", principal) });
}
export type ApprovalEngine = ReturnType<typeof createApprovalEngine>;

/** Host-only callback supplies the requester; workflow state and node config cannot do so. */
export function createApprovalNodeExecutor(engine: ApprovalEngine, requesterForRun: (runId: string) => Principal): NodeExecutor {
  return {
    kind: "approval",
    // Crash recovery (ADR-019): the approval id is derived from the exact request and creation is exact-request idempotent, so replay never duplicates.
    recoverySafety: () => "safe",
    validateConfig({ node }) { return ApprovalNodeConfigSchema.safeParse(node.config).success ? { ok: true } : { ok: false, issues: ["Invalid approval node configuration."] }; },
    async execute({ runId, node, state, step, trace }) {
      const config = ApprovalNodeConfigSchema.parse(node.config);
      const subject = state.values[config.subjectStateKey];
      if (subject === undefined || !isJsonSafe(subject)) return { ok: false, failure: { namespace: "approval", code: "INVALID_APPROVAL_CONTEXT", category: "VALIDATION" } };
      const requestedBy = PrincipalSchema.parse(requesterForRun(runId));
      const requestFingerprint = fingerprintApprovalSubject(runId, node.id, state.revision, subject);
      const approvalId = approvalIdForFingerprint(runId, node.id, requestFingerprint);
      const record = engine.requestApproval({ approvalId, runId, nodeId: node.id, requestFingerprint, requestedBy, requiredApproverRoleIds: config.requiredApproverRoleIds, permissionClasses: config.permissionClasses, allowSelfApproval: config.allowSelfApproval ?? false });
      // Request metadata only (ADR-020): the subject and its payload are never traced; the fingerprint binds them.
      await trace?.emit({ type: "approval.requested", span: trace.span, parentSpan: { kind: "run" }, key: { approvalId }, payload: { approvalId, step, requestedBy: { id: record.requestedBy.id, type: record.requestedBy.type }, requiredApproverRoleIds: [...record.requiredApproverRoleIds], permissionClasses: [...record.permissionClasses], allowSelfApproval: record.allowSelfApproval, requestFingerprint: record.requestFingerprint } });
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

/**
 * Trusted host bridge: read the engine's immutable record, recompute the
 * exact subject, and — for an approved record — revalidate current
 * requester authority and resolver eligibility before continuation. A
 * revoked approval leaves the Run waiting; it never continues.
 */
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
  if (record.status === "approved" && currentRequestFingerprint === record.requestFingerprint) {
    const revoked = engine.revalidateApproved(record);
    if (revoked) return { ok: false, failure: { code: revoked, message: revoked, category: "AUTHORIZATION", retryable: false }, execution: request.execution };
  }
  if (record.status !== "pending" && currentRequestFingerprint === record.requestFingerprint) {
    if (!engine.claimContinuation(record.approvalId)) return { ok: false, failure: { code: "INVALID_APPROVAL_CONTEXT", message: "INVALID_APPROVAL_CONTEXT" }, execution: request.execution };
  }
  if (record.status !== "pending" && currentRequestFingerprint === record.requestFingerprint) {
    await traceApprovalResolved(request.options?.trace, { runId: record.runId, workflowId: request.plan.workflow.id, workflowVersion: request.plan.workflow.version }, record);
  }
  try {
    const result = await continueWaitingWorkflow({ ...request, approval: record, currentRequestFingerprint });
    if (!result.ok && ["INVALID_APPROVAL_CONTEXT", "APPROVAL_REQUEST_MISMATCH", "APPROVAL_STILL_PENDING", "INVALID_RUNTIME_INPUT"].includes(result.failure.code)) engine.releaseContinuation(record.approvalId);
    return result;
  } catch (error) { engine.releaseContinuation(record.approvalId); throw error; }
}

/**
 * Reports a consumed Approval resolution (ADR-020): status, the resolver's
 * stable principal id/type for a human decision, and the authoritative
 * `resolvedAt`. No reason text, profile data, or subject. Observational
 * only: a trace failure is swallowed and never affects continuation.
 */
export async function traceApprovalResolved(trace: RuntimeTracePort | undefined, run: { runId: string; workflowId: string; workflowVersion: string }, record: ApprovalRecord): Promise<void> {
  if (!trace || record.status === "pending" || record.resolvedAt === undefined) return;
  try {
    await trace.emit({ type: "approval.resolved", ...run, nodeId: record.nodeId, span: { kind: "run" }, key: { approvalId: record.approvalId }, payload: { approvalId: record.approvalId, status: record.status, ...(record.resolvedBy ? { resolvedBy: { id: record.resolvedBy.id, type: record.resolvedBy.type } } : {}), resolvedAt: record.resolvedAt } });
  } catch {
    // Observability failure is never execution truth.
  }
}
