import { isoTimestampSchema, type EntityVersion, type NodeId, type RunId, type RunRecord, type RunStatus, type WorkflowId } from "@aao/contracts";
import type { RuntimeClock } from "./clock.js";

/**
 * The canonical Run lifecycle frozen by `docs/architecture/runtime-lifecycle.md`.
 * This is the single source of legal `RunStatus` transitions — Runtime code
 * must route every `RunRecord.status` change through `transitionRunRecord`
 * rather than constructing a new status by hand, so this table is the only
 * place the state machine is defined.
 */
const LEGAL_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  CREATED: ["VALIDATING"],
  VALIDATING: ["QUEUED", "FAILED"],
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["WAITING_FOR_APPROVAL", "RETRYING", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_FOR_APPROVAL: ["RUNNING", "FAILED", "CANCELLED"],
  RETRYING: ["RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isLegalRunTransition(from: RunStatus, to: RunStatus): boolean {
  return LEGAL_RUN_TRANSITIONS[from].includes(to);
}

/**
 * Thrown by `transitionRunRecord` for an illegal transition. This is a
 * programming-time/runtime invariant violation (Runtime code attempted a
 * transition the canonical lifecycle forbids), not an expected user-input or
 * execution failure — it is never caught and converted into a
 * `RuntimeFailure` value.
 */
export class IllegalRunTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`Illegal Run transition: "${from}" -> "${to}".`);
    this.name = "IllegalRunTransitionError";
  }
}

function assertValidTimestamp(timestamp: string, callerLabel: string): void {
  if (!isoTimestampSchema.safeParse(timestamp).success) {
    throw new Error(`${callerLabel}: "${timestamp}" is not a valid ISO timestamp.`);
  }
}

/** Constructs a brand-new `RunRecord` in `CREATED` status. `createdAt` and `updatedAt` start identical and both come from the injected clock — never `new Date()` directly. */
export function createRunRecord(params: { runId: RunId; workflowId: WorkflowId; workflowVersion: EntityVersion }, clock: RuntimeClock): RunRecord {
  const now = clock.now();
  assertValidTimestamp(now, "createRunRecord");
  return {
    schemaVersion: 1,
    runId: params.runId,
    workflowId: params.workflowId,
    workflowVersion: params.workflowVersion,
    status: "CREATED",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Applies one legal `RunStatus` transition, immutably. `createdAt` is always
 * preserved; `updatedAt` is always the caller-supplied timestamp (from the
 * Runtime clock boundary, never computed here). Throws
 * `IllegalRunTransitionError` for any transition `isLegalRunTransition`
 * rejects, including any transition attempted out of a terminal status.
 */
export function transitionRunRecord(run: RunRecord, nextStatus: RunStatus, timestamp: string): RunRecord {
  if (!isLegalRunTransition(run.status, nextStatus)) {
    throw new IllegalRunTransitionError(run.status, nextStatus);
  }
  assertValidTimestamp(timestamp, "transitionRunRecord");
  return { ...run, status: nextStatus, updatedAt: timestamp };
}

/**
 * Sets or clears `RunRecord.currentNodeId`, immutably. Kept separate from
 * `transitionRunRecord` because cursor movement (see
 * `docs/architecture/runtime-state-management.md`) is not itself a
 * `RunStatus` transition — a run's status can stay `RUNNING` across several
 * cursor moves. Passing `undefined` removes the field entirely (rather than
 * setting it to the literal `undefined`), matching `RunRecordSchema`'s
 * `.strict()` optional-field contract.
 */
export function setCurrentNodeId(run: RunRecord, currentNodeId: NodeId | undefined): RunRecord {
  if (currentNodeId === undefined) {
    const { currentNodeId: _drop, ...rest } = run;
    return rest;
  }
  return { ...run, currentNodeId };
}
