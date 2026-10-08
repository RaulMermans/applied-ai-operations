import { validateExecutionAgainstPlan, type NodeAttemptOutcome, type NodeRecoveryDirective, type NodeRegistry, type RuntimeExecutionState } from "@aao/runtime";
import type { CompiledWorkflowPlan } from "@aao/workflow-dsl";
import { DurabilityError, MAX_RECOVERY_REPLAYS, type DurableCheckpoint, type DurableOperation } from "./contracts.js";

/** Reconstructs the Runtime's execution state from a validated checkpoint — the same Run identity and `createdAt`, never a new Run. */
export function executionFromCheckpoint(checkpoint: DurableCheckpoint): RuntimeExecutionState {
  const snapshot = checkpoint.executionSnapshot;
  return {
    run: { ...snapshot.run },
    state: { runId: snapshot.stateSnapshot.runId, revision: snapshot.stateSnapshot.revision, values: snapshot.stateSnapshot.values },
    nodeStatusesById: { ...snapshot.nodeStatusesById },
    step: snapshot.step,
    history: checkpoint.executionHistory.map((record) => ({ ...record })),
    ...(snapshot.wait ? { wait: { ...snapshot.wait } } : {}),
  };
}

/** Validates a reconstructed execution against the plan; corrupt or incompatible state fails closed. */
export function assertExecutionMatchesPlan(execution: RuntimeExecutionState, plan: CompiledWorkflowPlan): void {
  if (validateExecutionAgainstPlan(execution, plan)) throw new DurabilityError("DURABILITY_CORRUPT_STATE");
}

export type RecoveryPlan =
  /** Crash window A/D: no attempt of the current Node began after the checkpoint. Continue normally. */
  | { kind: "none" }
  /** Crash windows B (safe replay) and C (recorded outcome): continue with durable attempt facts. */
  | { kind: "directive"; directive: NodeRecoveryDirective; replay?: { operationId: string; recoveryReplayCount: number } }
  /** Crash window B with an unsafe or exhausted ambiguous attempt: fail closed, execute nothing. */
  | { kind: "refuse"; code: "DURABILITY_UNSAFE_REPLAY" | "DURABILITY_RECOVERY_REPLAY_EXHAUSTED"; operationId: string };

/**
 * Decides, deterministically and without side effects, what recovery may do
 * from the newest checkpoint plus the operation ledger:
 *
 *   no operation after the checkpoint      → continue
 *   recorded outcome after the checkpoint  → commit/continue without invoking
 *   ambiguous (STARTED) + recovery-safe    → bounded replay, same attempt
 *   ambiguous + unsafe, or replay used up  → refuse (fail closed)
 *
 * "No outcome recorded" is never read as "nothing happened". Operations
 * that contradict the checkpoint (wrong Node, wrong state revision, gaps,
 * an unfinished operation behind the checkpoint) are corruption.
 */
export function planRecovery(execution: RuntimeExecutionState, operations: readonly DurableOperation[], plan: CompiledWorkflowPlan, registry: NodeRegistry): RecoveryPlan {
  const corrupt = () => new DurabilityError("DURABILITY_CORRUPT_STATE");
  const pending: DurableOperation[] = [];
  for (const operation of operations) {
    const node = plan.nodesById[operation.nodeId];
    if (operation.runId !== execution.run.runId || !node || node.kind !== operation.kind) throw corrupt();
    if (operation.step <= execution.step) {
      // Behind the checkpoint: its Node's outcome was already committed.
      if (operation.status !== "OUTCOME_RECORDED" || ["PENDING", "READY"].includes(execution.nodeStatusesById[operation.nodeId] ?? "PENDING")) throw corrupt();
      continue;
    }
    if (operation.step !== execution.step + 1 || execution.run.status !== "RUNNING" || operation.nodeId !== execution.run.currentNodeId || operation.stateRevision !== execution.state.revision) throw corrupt();
    pending.push(operation);
  }
  if (pending.length === 0) return { kind: "none" };
  pending.sort((a, b) => a.attempt - b.attempt);
  pending.forEach((operation, index) => {
    const last = index === pending.length - 1;
    if (operation.attempt !== index + 1 || operation.maxAttempts !== pending[0]!.maxAttempts) throw corrupt();
    if (!last && (operation.status !== "OUTCOME_RECORDED" || operation.outcome?.kind !== "failure")) throw corrupt();
  });
  const last = pending[pending.length - 1]!;
  const priorOutcomes: NodeAttemptOutcome[] = pending.filter((operation) => operation.status === "OUTCOME_RECORDED").map((operation) => operation.outcome!);
  const base = { nodeId: last.nodeId, step: last.step, priorOutcomes };
  if (last.status === "OUTCOME_RECORDED") return { kind: "directive", directive: base };

  // Ambiguous: intent durable, outcome unknown. Replay only on trusted recovery-safety metadata, within the hard bound.
  if (!isRecoverySafe(registry, plan, last.nodeId)) return { kind: "refuse", code: "DURABILITY_UNSAFE_REPLAY", operationId: last.operationId };
  if (last.recoveryReplayCount >= MAX_RECOVERY_REPLAYS) return { kind: "refuse", code: "DURABILITY_RECOVERY_REPLAY_EXHAUSTED", operationId: last.operationId };
  return { kind: "directive", directive: { ...base, replayAttempt: last.attempt }, replay: { operationId: last.operationId, recoveryReplayCount: last.recoveryReplayCount } };
}

/** Trusted executor metadata only — never model output, state, Tool results, MCP metadata, or exception text. Absent/thrown/unknown → unsafe. */
function isRecoverySafe(registry: NodeRegistry, plan: CompiledWorkflowPlan, nodeId: string): boolean {
  const node = plan.nodesById[nodeId];
  const executor = node ? registry.get(node.kind) : undefined;
  if (!node || typeof executor?.recoverySafety !== "function") return false;
  try {
    return executor.recoverySafety({ node: JSON.parse(JSON.stringify(node)) }) === "safe";
  } catch {
    return false;
  }
}
