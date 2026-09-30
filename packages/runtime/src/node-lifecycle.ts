import type { NodeId, NodeStatus } from "@aao/contracts";

/**
 * Authoritative per-Node status for every Node in the plan, keyed by
 * `NodeId`. A small `Record`, not a `NodeRun` domain model — see
 * `docs/architecture/runtime-state-management.md` for why this stays
 * minimal.
 */
export type NodeStatusMap = Record<NodeId, NodeStatus>;

/** Runtime Node lifecycle, including the approval wait boundary. SKIPPED remains unsupported. */
const LEGAL_NODE_TRANSITIONS: Readonly<Record<NodeStatus, readonly NodeStatus[]>> = {
  PENDING: ["READY"],
  READY: ["RUNNING"],
  RUNNING: ["SUCCEEDED", "FAILED", "WAITING"],
  SUCCEEDED: [],
  FAILED: [],
  WAITING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SKIPPED: [],
  CANCELLED: [],
};

export function isLegalNodeTransition(from: NodeStatus, to: NodeStatus): boolean {
  return LEGAL_NODE_TRANSITIONS[from].includes(to);
}

/** Thrown by `transitionNodeStatus` for an illegal transition or an unknown node id — both are Runtime invariant violations, never surfaced as a `RuntimeFailure` value. */
export class IllegalNodeTransitionError extends Error {
  constructor(nodeId: NodeId, from: NodeStatus, to: NodeStatus) {
    super(`Illegal Node transition for "${nodeId}": "${from}" -> "${to}".`);
    this.name = "IllegalNodeTransitionError";
  }
}

/** Builds the initial Node lifecycle map for a Run: every plan Node starts `PENDING`. */
export function initializeNodeStatuses(nodeIds: readonly NodeId[]): NodeStatusMap {
  const statuses: NodeStatusMap = {};
  for (const nodeId of nodeIds) statuses[nodeId] = "PENDING";
  return statuses;
}

/** Applies one legal Node transition, immutably, returning a new map. Throws for an unknown node id or an illegal transition. */
export function transitionNodeStatus(statuses: NodeStatusMap, nodeId: NodeId, nextStatus: NodeStatus): NodeStatusMap {
  const current = statuses[nodeId];
  if (current === undefined) {
    throw new Error(`transitionNodeStatus: unknown node id "${nodeId}".`);
  }
  if (!isLegalNodeTransition(current, nextStatus)) {
    throw new IllegalNodeTransitionError(nodeId, current, nextStatus);
  }
  return { ...statuses, [nodeId]: nextStatus };
}
