import { AuditCodeSchema, PrincipalSchema, RunIdSchema, emitAuditSafely, type ApprovalRecord, type AuditPort, type Principal, type RunState, type RunStatus, type TraceEventDraft } from "@aao/contracts";
import { continueApprovedWorkflow, traceApprovalResolved, type ApprovalEngine } from "@aao/approval";
import { createSystemClock, executeWorkflow, resumeWorkflow, type NodeRecoveryDirective, type NodeRegistry, type RuntimeClock, type RuntimeDurabilityHooks, type RuntimeExecutionState, type RuntimeFailure, type RuntimeOptions, type RuntimeReliabilityOptions, type RuntimeSleeper, type RuntimeTracePort, type WorkflowExecutionResult } from "@aao/runtime";
import { CompiledWorkflowPlanSchema, type CompiledWorkflowPlan } from "@aao/workflow-dsl";
import { DurabilityError, checkpointIdFor, durabilityCodeOf, operationIdFor, type CancellationRecord, type DurabilityFailureCode, type DurableCheckpoint, type DurableOperation, type RunManifest } from "./contracts.js";
import { planFingerprint } from "./fingerprint.js";
import { assertExecutionMatchesPlan, executionFromCheckpoint, planRecovery } from "./recovery.js";
import type { DurabilityStore } from "./store.js";

export interface DurableRuntimeHostOptions {
  store: DurabilityStore;
  /** The exact compiled plan this host executes. Durable Runs bind to its fingerprint. */
  plan: CompiledWorkflowPlan;
  registry: NodeRegistry;
  /** Required to resume a Run waiting for approval; must use a durable-capable repository to survive restart. */
  approvals?: ApprovalEngine;
  clock?: RuntimeClock;
  reliability?: RuntimeReliabilityOptions;
  sleeper?: RuntimeSleeper;
  maxSteps?: number;
  /**
   * Optional trace port (ADR-020), e.g. `@aao/observability`'s recorder.
   * Passed to the Runtime and used to report checkpoints, recovery, and
   * cancellation *after* durability decided them. Recovery never reads it:
   * the checkpoint chain and operation ledger stay the only recovery truth.
   */
  trace?: RuntimeTracePort;
  /**
   * Optional emit-only Audit port (ADR-021), e.g. `@aao/observability`'s
   * Audit recorder. The host reports accountable cancellation requests and
   * their application. Never read: recovery and cancellation decisions come
   * only from durable state, and Audit failure changes nothing.
   */
  audit?: AuditPort;
}

/** A trusted host's cancellation request: the accountable principal and an optional bounded reason code (never free text). */
export interface CancellationRequest {
  requestedBy: Principal;
  reasonCode?: string;
}

export interface DurabilityFailure {
  code: DurabilityFailureCode;
  message: string;
  /** The ambiguous operation behind a refused recovery. */
  operationId?: string;
}

/** A Runtime result, or a durability failure decided before or around Runtime execution. */
export type DurableRunResult = WorkflowExecutionResult | { ok: false; failure: DurabilityFailure; execution?: RuntimeExecutionState };

/** Read-only inspection of one durable Run. `execution.run.status` is the only lifecycle truth. */
export interface DurableRunView {
  manifest: RunManifest;
  execution: RuntimeExecutionState;
  status: RunStatus;
  checkpoint: { checkpointId: string; sequence: number; createdAt: string };
  failure?: RuntimeFailure;
  operations: DurableOperation[];
  cancellation?: CancellationRecord;
  /** Evidence recorded at an approval wait, and the current value: a change triggers nothing by itself because continuation always revalidates against current Governance. */
  governanceFingerprintAtWait?: string;
  currentGovernanceFingerprint?: string;
}

const MESSAGES: Record<DurabilityFailureCode, string> = {
  DURABLE_RUN_ALREADY_EXISTS: "A durable Run with this runId already exists; nothing executed.",
  DURABLE_RUN_NOT_FOUND: "No durable Run exists with this runId.",
  DURABLE_RUN_BUSY: "This host is already executing this Run.",
  DURABILITY_INVALID_INPUT: "The durability request is invalid.",
  DURABILITY_PLAN_MISMATCH: "The durable Run is bound to a different compiled plan; nothing executed.",
  DURABILITY_CORRUPT_STATE: "Durable Run state is corrupt or inconsistent; nothing executed.",
  DURABILITY_CONFLICT: "A durable write conflicted with existing state.",
  DURABILITY_IO_FAILED: "Durable storage failed.",
  DURABILITY_UNSAFE_REPLAY: "An operation's outcome is unknown after a crash and it is not recovery-safe; nothing was replayed.",
  DURABILITY_RECOVERY_REPLAY_EXHAUSTED: "An operation's outcome is still unknown after its bounded recovery replay; nothing was replayed.",
};

function failure(code: DurabilityFailureCode, extra: Partial<DurabilityFailure> = {}, execution?: RuntimeExecutionState): DurableRunResult {
  return { ok: false, failure: { code, message: MESSAGES[code], ...extra }, ...(execution ? { execution } : {}) };
}

/**
 * The durable execution host (ADR-019). It owns *when* and *what* is
 * persisted and how recovery decides; the Runtime still owns execution
 * semantics — every path below calls `executeWorkflow`, `resumeWorkflow`,
 * or the approval bridge over `continueWaitingWorkflow`, so there is one
 * Runtime loop and one commit path. Callers never handle checkpoint files,
 * operation ledgers, or recovery directives.
 *
 * Protocol per Node attempt: safe checkpoint → persist operation STARTED →
 * executor → Runtime validation → persist accepted outcome → Runtime commit
 * → persist next checkpoint. Recovery replays orchestration, never an
 * operation whose outcome is unknown unless trusted metadata makes the
 * replay safe. No exactly-once claim is made.
 */
export function createDurableRuntimeHost(options: DurableRuntimeHostOptions) {
  const parsedPlan = CompiledWorkflowPlanSchema.safeParse(options?.plan);
  if (!parsedPlan.success || typeof options.store !== "object" || options.store === null) throw new DurabilityError("DURABILITY_INVALID_INPUT");
  const { store, registry, approvals } = options;
  const plan = options.plan;
  const fingerprint = planFingerprint(plan);
  const clock = options.clock ?? createSystemClock();
  const trace = options.trace;
  const audit = options.audit;
  const runtimeOptions: RuntimeOptions = { clock, ...(trace ? { trace } : {}), ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}), ...(options.reliability ? { reliability: options.reliability } : {}), ...(options.sleeper ? { sleeper: options.sleeper } : {}) };
  // Single writer per Run inside this host; cross-process exclusion is out of scope (documented).
  const active = new Set<string>();

  type HostDraft = TraceEventDraft extends infer D ? (D extends unknown ? Omit<D, "runId" | "workflowId" | "workflowVersion"> : never) : never;
  /** Observational only: reports what durability already decided. Never awaited for a decision, never read back. */
  async function emit(runId: string, draft: HostDraft): Promise<void> {
    if (!trace) return;
    try { await trace.emit({ ...draft, runId, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version } as TraceEventDraft); } catch { /* trace failure is never durability truth */ }
  }

  function session(runId: string, nextSequence: number, replay?: { operationId: string; recoveryReplayCount: number }, recoveredFrom?: number) {
    let sequence = nextSequence;
    let recoveryOpen = recoveredFrom !== undefined;
    let lastError: DurabilityFailureCode | undefined;
    const record = async <T>(work: () => Promise<T>): Promise<T> => {
      try { return await work(); } catch (error) { lastError = durabilityCodeOf(error); throw error; }
    };
    const hooks: RuntimeDurabilityHooks = {
      persistCheckpoint: ({ execution, snapshot, failure: runFailure }) => record(async () => {
        const checkpoint: DurableCheckpoint = {
          schemaVersion: 1,
          checkpointId: checkpointIdFor(sequence),
          sequence,
          runId,
          workflowId: plan.workflow.id,
          workflowVersion: plan.workflow.version,
          planFingerprint: fingerprint,
          createdAt: snapshot.stateSnapshot.capturedAt,
          executionSnapshot: snapshot,
          executionHistory: execution.history,
          ...(runFailure ? { failure: runFailure } : {}),
          ...(snapshot.run.status === "WAITING_FOR_APPROVAL" && approvals ? { governanceFingerprint: approvals.governanceFingerprint } : {}),
        };
        if (sequence === 0) {
          await store.createRun({ schemaVersion: 1, runId, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version, planFingerprint: fingerprint, createdAt: execution.run.createdAt }, checkpoint);
        } else {
          await store.writeCheckpoint(checkpoint);
        }
        sequence += 1;
        const { run: runRecord, stateSnapshot, step } = snapshot;
        await emit(runId, { type: "checkpoint.created", span: { kind: "run" }, key: { checkpointSequence: checkpoint.sequence }, payload: { checkpointId: checkpoint.checkpointId, checkpointSequence: checkpoint.sequence, runStatus: runRecord.status, stateRevision: stateSnapshot.revision, step, ...(runRecord.currentNodeId ? { currentNodeId: runRecord.currentNodeId } : {}), planFingerprint: fingerprint } });
        if (recoveryOpen) {
          // Recovery is complete once it has made durable progress past its checkpoint.
          recoveryOpen = false;
          await emit(runId, { type: "recovery.completed", span: { kind: "run" }, key: { fromCheckpointSequence: recoveredFrom! }, payload: { fromCheckpointSequence: recoveredFrom!, toCheckpointSequence: checkpoint.sequence } });
        }
      }),
      beginAttempt: (intent) => record(async () => {
        const operationId = operationIdFor(intent.step, intent.attempt);
        if (intent.recoveryReplay) {
          if (!replay || replay.operationId !== operationId) throw new DurabilityError("DURABILITY_CONFLICT");
          await store.markOperationReplay(runId, operationId, replay.recoveryReplayCount);
          await emit(runId, { type: "recovery.replayed", nodeId: intent.nodeId, span: { kind: "run" }, key: { operationId, replay: replay.recoveryReplayCount + 1 }, payload: { operationId, step: intent.step, attempt: intent.attempt, recoveryReplayCount: replay.recoveryReplayCount + 1 } });
          return;
        }
        await store.beginOperation({ schemaVersion: 1, operationId, runId, nodeId: intent.nodeId, kind: intent.kind, step: intent.step, stateRevision: intent.stateRevision, attempt: intent.attempt, maxAttempts: intent.maxAttempts, recoveryReplayCount: 0, status: "STARTED", startedAt: clock.now() });
      }),
      recordAttemptOutcome: (intent, outcome) => record(() => store.recordOperationOutcome(runId, operationIdFor(intent.step, intent.attempt), outcome, clock.now())),
      isCancellationRequested: () => record(async () => (await store.getCancellation(runId)) !== undefined),
    };
    /** Names the durability cause of a Runtime `DURABILITY_PERSISTENCE_FAILED`; reports an applied cancellation to Audit. */
    const finish = async (result: WorkflowExecutionResult): Promise<DurableRunResult> => {
      if (!result.ok && result.failure.code === "RUN_CANCELLED" && result.execution?.run.status === "CANCELLED") await auditCancellationApplied(runId, result.execution, result.failure.nodeId);
      if (result.ok || result.failure.code !== "DURABILITY_PERSISTENCE_FAILED" || lastError === undefined) return result;
      if (lastError === "DURABLE_RUN_ALREADY_EXISTS") return failure("DURABLE_RUN_ALREADY_EXISTS");
      return { ...result, failure: { ...result.failure, details: { durabilityCode: lastError } } };
    };
    return { hooks, finish, options: { ...runtimeOptions, durability: hooks } };
  }

  /**
   * Accountability for the Runtime reaching the safe cancellation boundary:
   * when the Run became CANCELLED (`RunRecord.updatedAt`), attributed to the
   * durably recorded requester. Without recorded attribution (a pre-Sprint-16
   * record) nothing is emitted rather than inventing an actor.
   */
  async function auditCancellationApplied(runId: string, execution: RuntimeExecutionState, nodeId: string | undefined): Promise<void> {
    if (!audit) return;
    let cancellation: CancellationRecord | undefined;
    try { cancellation = await store.getCancellation(runId); } catch { return; }
    if (!cancellation?.requestedBy) return;
    emitAuditSafely(audit, { type: "run.cancellation.applied", runId, actor: { id: cancellation.requestedBy.id, type: cancellation.requestedBy.type }, target: { kind: "run", runId }, occurredAt: execution.run.updatedAt, key: { runId }, payload: { step: execution.step, ...(nodeId ? { nodeId } : {}), requestedAt: cancellation.requestedAt } });
  }

  async function exclusive(runId: unknown, work: (runId: string) => Promise<DurableRunResult>): Promise<DurableRunResult> {
    if (!RunIdSchema.safeParse(runId).success) return failure("DURABILITY_INVALID_INPUT");
    const id = runId as string;
    if (active.has(id)) return failure("DURABLE_RUN_BUSY");
    active.add(id);
    try {
      return await work(id);
    } catch (error) {
      if (error instanceof DurabilityError) return failure(error.code);
      throw error;
    } finally {
      active.delete(id);
    }
  }

  /** Loads and validates durable truth: manifest, plan binding, the checkpoint chain, and the reconstructed execution. */
  async function load(runId: string) {
    const manifest = await store.getRun(runId);
    if (!manifest) throw new DurabilityError("DURABLE_RUN_NOT_FOUND");
    if (manifest.workflowId !== plan.workflow.id || manifest.workflowVersion !== plan.workflow.version || manifest.planFingerprint !== fingerprint) throw new DurabilityError("DURABILITY_PLAN_MISMATCH");
    const checkpoint = await store.getLatestCheckpoint(runId);
    if (!checkpoint) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
    const execution = executionFromCheckpoint(checkpoint);
    assertExecutionMatchesPlan(execution, plan);
    const operations = await store.getOperationsForRun(runId);
    const cancellation = await store.getCancellation(runId);
    return { manifest, checkpoint, execution, operations, cancellation };
  }

  return Object.freeze({
    planFingerprint: fingerprint,

    /** Starts a new durable Run. A runId that already exists never executes again. */
    execute(request: { runId: string; initialState: RunState }): Promise<DurableRunResult> {
      return exclusive(request?.runId, async (runId) => {
        if (await store.getRun(runId)) return failure("DURABLE_RUN_ALREADY_EXISTS");
        const run = session(runId, 0);
        return await run.finish(await executeWorkflow({ runId, plan, registry, initialState: request.initialState, options: run.options }));
      });
    },

    /**
     * Continues a durable Run from durable truth after a restart (or at any
     * time). Terminal Runs return their persisted outcome without executing;
     * a waiting Run stays waiting until its durable Approval is resolved,
     * then continues only after the subject, plan, and current authority are
     * revalidated; a running Run resumes at its READY Node, reusing recorded
     * attempt outcomes and replaying an ambiguous attempt only when safe.
     */
    resume(runId: string): Promise<DurableRunResult> {
      return exclusive(runId, async (id) => {
        const { checkpoint, execution, operations, cancellation } = await load(id);
        const run = (replay?: { operationId: string; recoveryReplayCount: number }, recoveredFrom?: number) => session(id, checkpoint.sequence + 1, replay, recoveredFrom);
        const status = execution.run.status;

        if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
          const result = await resumeWorkflow({ plan, registry, execution, options: runtimeOptions });
          return !result.ok && checkpoint.failure ? { ...result, failure: checkpoint.failure } : result;
        }

        if (status === "WAITING_FOR_APPROVAL") {
          const wait = execution.wait!;
          if (cancellation) {
            const current = run();
            const result = await current.finish(await resumeWorkflow({ plan, registry, execution, options: current.options }));
            if (!result.ok && result.failure.code === "RUN_CANCELLED" && approvals?.getApproval(wait.referenceId)?.status === "pending") {
              const cancelled = approvals.cancel(wait.referenceId);
              await traceApprovalResolved(trace, { runId: id, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version }, cancelled);
            }
            return result;
          }
          if (!approvals) return failure("DURABILITY_INVALID_INPUT", {}, execution);
          const record: ApprovalRecord | undefined = approvals.getApproval(wait.referenceId);
          if (!record || record.runId !== id || record.nodeId !== wait.nodeId || record.requestFingerprint !== wait.requestFingerprint) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
          if (record.status === "pending") return { ok: true, execution, latestSnapshot: checkpoint.executionSnapshot };
          const current = run();
          return await current.finish(await continueApprovedWorkflow(approvals, { plan, registry, execution, options: current.options }));
        }

        // The decision comes only from the checkpoint and operation ledger; the trace below merely reports it.
        const recovery = planRecovery(execution, operations, plan, registry);
        await emit(id, { type: "recovery.started", span: { kind: "run" }, key: { checkpointSequence: checkpoint.sequence }, payload: { checkpointId: checkpoint.checkpointId, checkpointSequence: checkpoint.sequence, runStatus: status, stateRevision: execution.state.revision, ...(execution.run.currentNodeId ? { currentNodeId: execution.run.currentNodeId } : {}) } });
        if (recovery.kind === "refuse") {
          const blocked = operations.find((operation) => operation.operationId === recovery.operationId);
          await emit(id, { type: "recovery.blocked", ...(blocked ? { nodeId: blocked.nodeId } : {}), span: { kind: "run" }, key: { operationId: recovery.operationId, code: recovery.code }, payload: { operationId: recovery.operationId, step: blocked?.step ?? execution.step + 1, attempt: blocked?.attempt ?? 1, code: recovery.code } });
          await emit(id, { type: "failure.detected", span: { kind: "run" }, key: { code: recovery.code, operationId: recovery.operationId }, payload: { source: "durability", code: recovery.code, step: blocked?.step ?? execution.step + 1, ...(blocked ? { attempt: blocked.attempt } : {}) } });
          // Fail closed: durable truth is left untouched. Only a requested cancellation may still end the Run, without replaying anything.
          if (!cancellation) return failure(recovery.code, { operationId: recovery.operationId }, execution);
          const current = run(undefined, checkpoint.sequence);
          return await current.finish(await resumeWorkflow({ plan, registry, execution, options: current.options }));
        }
        const directive: NodeRecoveryDirective | undefined = recovery.kind === "directive" ? recovery.directive : undefined;
        for (const operation of operations.filter((candidate) => candidate.step === execution.step + 1 && candidate.status === "OUTCOME_RECORDED")) {
          await emit(id, { type: "recovery.outcome_reused", nodeId: operation.nodeId, span: { kind: "run" }, key: { operationId: operation.operationId }, payload: { operationId: operation.operationId, step: operation.step, attempt: operation.attempt, outcomeKind: operation.outcome!.kind } });
        }
        const current = run(recovery.kind === "directive" ? recovery.replay : undefined, checkpoint.sequence);
        return await current.finish(await resumeWorkflow({ plan, registry, execution, ...(directive ? { recovery: directive } : {}), options: current.options }));
      });
    },

    /** Inspects one durable Run. Never executes anything. */
    async getRun(runId: string): Promise<DurableRunView | undefined> {
      if (!RunIdSchema.safeParse(runId).success || !(await store.getRun(runId))) return undefined;
      const { manifest, checkpoint, execution, operations, cancellation } = await load(runId);
      return {
        manifest,
        execution,
        status: execution.run.status,
        checkpoint: { checkpointId: checkpoint.checkpointId, sequence: checkpoint.sequence, createdAt: checkpoint.createdAt },
        ...(checkpoint.failure ? { failure: checkpoint.failure } : {}),
        operations,
        ...(cancellation ? { cancellation } : {}),
        ...(checkpoint.governanceFingerprint ? { governanceFingerprintAtWait: checkpoint.governanceFingerprint } : {}),
        ...(approvals ? { currentGovernanceFingerprint: approvals.governanceFingerprint } : {}),
      };
    },

    getApproval(approvalId: string): ApprovalRecord | undefined {
      return approvals?.getApproval(approvalId);
    },

    /**
     * Persists a cancellation request, applied at the Run's next safe
     * boundary. It stops future work; it never reverses completed work. The
     * trusted host attests who is asking (`user`, `service`, or `system`);
     * the request is idempotent, so the first accepted requester remains the
     * accountable one. Audit records the request at this boundary.
     */
    async requestCancellation(runId: string, request: CancellationRequest): Promise<{ ok: true; cancellation: CancellationRecord } | { ok: false; failure: DurabilityFailure }> {
      const requestedBy = PrincipalSchema.safeParse(request?.requestedBy);
      const reasonCode = request?.reasonCode === undefined ? undefined : AuditCodeSchema.safeParse(request.reasonCode);
      if (!RunIdSchema.safeParse(runId).success || !requestedBy.success || (reasonCode !== undefined && !reasonCode.success)) return { ok: false, failure: { code: "DURABILITY_INVALID_INPUT", message: MESSAGES.DURABILITY_INVALID_INPUT } };
      try {
        const cancellation = await store.requestCancellation(runId, clock.now(), { requestedBy: requestedBy.data, ...(reasonCode?.success ? { reasonCode: reasonCode.data } : {}) });
        await emit(runId, { type: "cancellation.requested", span: { kind: "run" }, key: {}, payload: { requestedAt: cancellation.requestedAt } });
        if (cancellation.requestedBy) emitAuditSafely(audit, { type: "run.cancellation.requested", runId, actor: { id: cancellation.requestedBy.id, type: cancellation.requestedBy.type }, target: { kind: "run", runId }, occurredAt: cancellation.requestedAt, key: { runId }, payload: { ...(cancellation.reasonCode ? { reasonCode: cancellation.reasonCode } : {}) } });
        return { ok: true, cancellation };
      } catch (error) {
        const code = durabilityCodeOf(error);
        return { ok: false, failure: { code, message: MESSAGES[code] } };
      }
    },
  });
}
export type DurableRuntimeHost = ReturnType<typeof createDurableRuntimeHost>;
