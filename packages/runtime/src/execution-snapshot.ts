import { z } from "zod";
import { NodeIdSchema, NodeStatusSchema, RunRecordSchema, StateSnapshotSchema, identifierSchema } from "@aao/contracts";
import type { CompiledWorkflowPlan } from "@aao/workflow-dsl";
import { captureStateSnapshot } from "./state.js";
import { compareIsoInstants } from "./timestamps.js";
import type { RuntimeExecutionState, RuntimeFailure } from "./types.js";

const RuntimeWaitStateSchema = z.object({ kind: z.literal("approval"), nodeId: NodeIdSchema, referenceId: identifierSchema, requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/**
 * A safe, in-memory execution-engine artifact: Run lifecycle + a canonical
 * `StateSnapshot` + Node lifecycle + execution cursor, captured only at a
 * safe execution boundary (see `captureExecutionSnapshot` and
 * `docs/architecture/runtime-state-management.md`). This is **not** a
 * durable checkpoint and makes no persistence or resume claim — see
 * ADR-010. It lives in `@aao/runtime` (not `@aao/contracts`) because it is
 * an execution-engine artifact, not a cross-product canonical contract, and
 * it contains no Runtime dependency (no registry, executor, or clock) —
 * only JSON-safe data built from the same canonical schemas
 * `RuntimeExecutionState` uses.
 *
 * Temporal coherence: a snapshot must not claim to have been captured
 * before the latest Run lifecycle transition it represents, so
 * `stateSnapshot.capturedAt` must be the same instant as, or later than,
 * `run.updatedAt` (compared as instants, not raw strings).
 */
export const RuntimeExecutionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    run: RunRecordSchema,
    stateSnapshot: StateSnapshotSchema,
    nodeStatusesById: z.record(NodeIdSchema, NodeStatusSchema),
    step: z.number().int().nonnegative(),
    wait: RuntimeWaitStateSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (compareIsoInstants(snapshot.stateSnapshot.capturedAt, snapshot.run.updatedAt) < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stateSnapshot", "capturedAt"],
        message: "stateSnapshot.capturedAt must not be earlier than run.updatedAt.",
      });
    }
    const waitingNodes = Object.entries(snapshot.nodeStatusesById).filter(([, status]) => status === "WAITING");
    if (Object.values(snapshot.nodeStatusesById).includes("RUNNING")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "safe snapshot cannot contain a RUNNING node" });
    if (snapshot.run.status === "WAITING_FOR_APPROVAL") {
      if (!snapshot.wait || snapshot.run.currentNodeId !== snapshot.wait.nodeId || snapshot.nodeStatusesById[snapshot.wait.nodeId] !== "WAITING" || waitingNodes.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approval wait requires matching current WAITING node and descriptor" });
    } else if (snapshot.wait || waitingNodes.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "nonwaiting snapshot cannot carry wait metadata or a WAITING node" });
  });
export type RuntimeExecutionSnapshot = z.infer<typeof RuntimeExecutionSnapshotSchema>;

/**
 * Captures `execution` as a `RuntimeExecutionSnapshot` at `capturedAt`.
 * Enforces the safe-boundary invariant: a snapshot must never represent a
 * half-executed Node, so this throws if any Node is currently `RUNNING` —
 * that is a Runtime programming error (calling this from the wrong place in
 * `engine.ts`), never an expected/user-facing failure. `run` and
 * `nodeStatusesById` are shallow-copied and `state` is captured through
 * `captureStateSnapshot` (which deep-clones), so the returned snapshot
 * shares no mutable reference with `execution`.
 */
export function captureExecutionSnapshot(execution: RuntimeExecutionState, capturedAt: string): RuntimeExecutionSnapshot {
  for (const [nodeId, status] of Object.entries(execution.nodeStatusesById)) {
    if (status === "RUNNING") {
      throw new Error(
        `captureExecutionSnapshot: cannot capture a snapshot while node "${nodeId}" is RUNNING — this is not a safe execution boundary.`,
      );
    }
  }

  const snapshot: RuntimeExecutionSnapshot = {
    schemaVersion: 2,
    run: { ...execution.run },
    stateSnapshot: captureStateSnapshot(execution.state, capturedAt),
    nodeStatusesById: { ...execution.nodeStatusesById },
    step: execution.step,
    ...(execution.wait ? { wait: { ...execution.wait } } : {}),
  };

  if (compareIsoInstants(capturedAt, execution.run.updatedAt) < 0) {
    throw new Error(
      `captureExecutionSnapshot: capturedAt "${capturedAt}" is earlier than run.updatedAt "${execution.run.updatedAt}"; a snapshot cannot predate the lifecycle transition it represents.`,
    );
  }

  const validated = RuntimeExecutionSnapshotSchema.safeParse(snapshot);
  if (!validated.success) {
    throw new Error("captureExecutionSnapshot: produced a RuntimeExecutionSnapshot that fails its own schema.");
  }
  return validated.data;
}

/**
 * Verifies a `RuntimeExecutionSnapshot` is contextually compatible with a
 * specific `CompiledWorkflowPlan` — a structurally valid snapshot is not
 * automatically compatible with a particular plan (see
 * `docs/architecture/runtime-state-management.md`). Returns the first
 * incompatibility found as a `RuntimeFailure`, or `undefined` if the
 * snapshot is safe to reason about against this plan. This is a
 * groundwork check for future snapshot handoff/inspection — Sprint 5 does
 * not implement resume from a snapshot (see ADR-010).
 */
export function validateSnapshotAgainstPlan(snapshot: unknown, plan: CompiledWorkflowPlan): RuntimeFailure | undefined {
  const structural = RuntimeExecutionSnapshotSchema.safeParse(snapshot);
  if (!structural.success) {
    return {
      code: "INVALID_EXECUTION_SNAPSHOT",
      message: "Snapshot does not match RuntimeExecutionSnapshotSchema.",
      details: { issues: structural.error.issues.map((issue) => issue.message) },
    };
  }
  const parsed = structural.data;

  if (parsed.run.workflowId !== plan.workflow.id) {
    return {
      code: "INVALID_EXECUTION_SNAPSHOT",
      message: `Snapshot run.workflowId "${parsed.run.workflowId}" does not match plan.workflow.id "${plan.workflow.id}".`,
    };
  }
  if (parsed.run.workflowVersion !== plan.workflow.version) {
    return {
      code: "INVALID_EXECUTION_SNAPSHOT",
      message: `Snapshot run.workflowVersion "${parsed.run.workflowVersion}" does not match plan.workflow.version "${plan.workflow.version}".`,
    };
  }
  if (parsed.run.runId !== parsed.stateSnapshot.runId) {
    return {
      code: "INVALID_EXECUTION_SNAPSHOT",
      message: `Snapshot run.runId "${parsed.run.runId}" does not match stateSnapshot.runId "${parsed.stateSnapshot.runId}".`,
    };
  }

  const planNodeIds = new Set(Object.keys(plan.nodesById));
  const snapshotNodeIds = Object.keys(parsed.nodeStatusesById);
  if (snapshotNodeIds.length !== planNodeIds.size || snapshotNodeIds.some((nodeId) => !planNodeIds.has(nodeId))) {
    return {
      code: "INVALID_EXECUTION_SNAPSHOT",
      message: "Snapshot nodeStatusesById keys do not match plan.nodesById keys.",
    };
  }

  if (parsed.run.currentNodeId !== undefined && !planNodeIds.has(parsed.run.currentNodeId)) {
    return {
      code: "INVALID_EXECUTION_SNAPSHOT",
      message: `Snapshot run.currentNodeId "${parsed.run.currentNodeId}" does not resolve to a node in the plan.`,
    };
  }

  if (parsed.wait && plan.nodesById[parsed.wait.nodeId]?.kind !== "approval") return { code: "INVALID_EXECUTION_SNAPSHOT", message: "Approval wait must reference an approval node." };

  if (parsed.run.status === "RUNNING") {
    if (parsed.run.currentNodeId === undefined) {
      return { code: "INVALID_EXECUTION_SNAPSHOT", message: "A RUNNING snapshot must carry a currentNodeId." };
    }
    if (parsed.nodeStatusesById[parsed.run.currentNodeId] !== "READY") {
      return {
        code: "INVALID_EXECUTION_SNAPSHOT",
        message: `A RUNNING snapshot's current node "${parsed.run.currentNodeId}" must be READY.`,
      };
    }
  }

  if (parsed.run.status === "COMPLETED") {
    if (parsed.run.currentNodeId !== undefined) {
      return { code: "INVALID_EXECUTION_SNAPSHOT", message: "A COMPLETED snapshot must not carry a currentNodeId." };
    }
    const terminalSucceeded = plan.terminalNodeIds.some((nodeId) => parsed.nodeStatusesById[nodeId] === "SUCCEEDED");
    if (!terminalSucceeded) {
      return { code: "INVALID_EXECUTION_SNAPSHOT", message: "A COMPLETED snapshot must have at least one SUCCEEDED terminal node." };
    }
  }

  if (parsed.run.status === "FAILED" && parsed.run.currentNodeId !== undefined) {
    return { code: "INVALID_EXECUTION_SNAPSHOT", message: "A FAILED snapshot must not carry a currentNodeId." };
  }

  return undefined;
}
