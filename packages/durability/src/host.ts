import { RunIdSchema, type ApprovalRecord, type RunState, type RunStatus } from "@aao/contracts";
import { continueApprovedWorkflow, type ApprovalEngine } from "@aao/approval";
import { createSystemClock, executeWorkflow, resumeWorkflow, type NodeRecoveryDirective, type NodeRegistry, type RuntimeClock, type RuntimeDurabilityHooks, type RuntimeExecutionState, type RuntimeFailure, type RuntimeOptions, type RuntimeReliabilityOptions, type RuntimeSleeper, type WorkflowExecutionResult } from "@aao/runtime";
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
  const runtimeOptions: RuntimeOptions = { clock, ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}), ...(options.reliability ? { reliability: options.reliability } : {}), ...(options.sleeper ? { sleeper: options.sleeper } : {}) };
  // Single writer per Run inside this host; cross-process exclusion is out of scope (documented).
  const active = new Set<string>();

  function session(runId: string, nextSequence: number, replay?: { operationId: string; recoveryReplayCount: number }) {
    let sequence = nextSequence;
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
      }),
      beginAttempt: (intent) => record(async () => {
        const operationId = operationIdFor(intent.step, intent.attempt);
        if (intent.recoveryReplay) {
          if (!replay || replay.operationId !== operationId) throw new DurabilityError("DURABILITY_CONFLICT");
          await store.markOperationReplay(runId, operationId, replay.recoveryReplayCount);
          return;
        }
        await store.beginOperation({ schemaVersion: 1, operationId, runId, nodeId: intent.nodeId, kind: intent.kind, step: intent.step, stateRevision: intent.stateRevision, attempt: intent.attempt, maxAttempts: intent.maxAttempts, recoveryReplayCount: 0, status: "STARTED", startedAt: clock.now() });
      }),
      recordAttemptOutcome: (intent, outcome) => record(() => store.recordOperationOutcome(runId, operationIdFor(intent.step, intent.attempt), outcome, clock.now())),
      isCancellationRequested: () => record(async () => (await store.getCancellation(runId)) !== undefined),
    };
    /** Names the durability cause of a Runtime `DURABILITY_PERSISTENCE_FAILED`. */
    const finish = (result: WorkflowExecutionResult): DurableRunResult => {
      if (result.ok || result.failure.code !== "DURABILITY_PERSISTENCE_FAILED" || lastError === undefined) return result;
      if (lastError === "DURABLE_RUN_ALREADY_EXISTS") return failure("DURABLE_RUN_ALREADY_EXISTS");
      return { ...result, failure: { ...result.failure, details: { durabilityCode: lastError } } };
    };
    return { hooks, finish, options: { ...runtimeOptions, durability: hooks } };
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
        return run.finish(await executeWorkflow({ runId, plan, registry, initialState: request.initialState, options: run.options }));
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
        const run = (replay?: { operationId: string; recoveryReplayCount: number }) => session(id, checkpoint.sequence + 1, replay);
        const status = execution.run.status;

        if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
          const result = await resumeWorkflow({ plan, registry, execution, options: runtimeOptions });
          return !result.ok && checkpoint.failure ? { ...result, failure: checkpoint.failure } : result;
        }

        if (status === "WAITING_FOR_APPROVAL") {
          const wait = execution.wait!;
          if (cancellation) {
            const current = run();
            const result = current.finish(await resumeWorkflow({ plan, registry, execution, options: current.options }));
            if (!result.ok && result.failure.code === "RUN_CANCELLED" && approvals?.getApproval(wait.referenceId)?.status === "pending") approvals.cancel(wait.referenceId);
            return result;
          }
          if (!approvals) return failure("DURABILITY_INVALID_INPUT", {}, execution);
          const record: ApprovalRecord | undefined = approvals.getApproval(wait.referenceId);
          if (!record || record.runId !== id || record.nodeId !== wait.nodeId || record.requestFingerprint !== wait.requestFingerprint) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
          if (record.status === "pending") return { ok: true, execution, latestSnapshot: checkpoint.executionSnapshot };
          const current = run();
          return current.finish(await continueApprovedWorkflow(approvals, { plan, registry, execution, options: current.options }));
        }

        const recovery = planRecovery(execution, operations, plan, registry);
        if (recovery.kind === "refuse") {
          // Fail closed: durable truth is left untouched. Only a requested cancellation may still end the Run, without replaying anything.
          if (!cancellation) return failure(recovery.code, { operationId: recovery.operationId }, execution);
          const current = run();
          return current.finish(await resumeWorkflow({ plan, registry, execution, options: current.options }));
        }
        const directive: NodeRecoveryDirective | undefined = recovery.kind === "directive" ? recovery.directive : undefined;
        const current = run(recovery.kind === "directive" ? recovery.replay : undefined);
        return current.finish(await resumeWorkflow({ plan, registry, execution, ...(directive ? { recovery: directive } : {}), options: current.options }));
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

    /** Persists a cancellation request, applied at the Run's next safe boundary. It stops future work; it never reverses completed work. */
    async requestCancellation(runId: string): Promise<{ ok: true; cancellation: CancellationRecord } | { ok: false; failure: DurabilityFailure }> {
      if (!RunIdSchema.safeParse(runId).success) return { ok: false, failure: { code: "DURABILITY_INVALID_INPUT", message: MESSAGES.DURABILITY_INVALID_INPUT } };
      try {
        return { ok: true, cancellation: await store.requestCancellation(runId, clock.now()) };
      } catch (error) {
        const code = durabilityCodeOf(error);
        return { ok: false, failure: { code, message: MESSAGES[code] } };
      }
    },
  });
}
export type DurableRuntimeHost = ReturnType<typeof createDurableRuntimeHost>;
