import { AgentAuthoritySchema, type AuthorizationDecision } from "@aao/authorization";
import { PrincipalSchema, emitAuditSafely, type AuditPort, type PermissionClass } from "@aao/contracts";
import type { NodeExecutionContext } from "@aao/runtime";
import type { ToolRef } from "./types.js";

/** Where a Tool access decision is accountable: the Run, its Node, and the Runtime-assigned attempt number (observational metadata only). */
export interface ToolAccessAuditBinding {
  port: AuditPort;
  runId: string;
  nodeId?: string;
  attempt: number;
}

/** The Tool Node's binding for one Runtime attempt, or none without a configured Audit port. */
export function toolAccessAuditBinding(port: AuditPort | undefined, context: NodeExecutionContext): ToolAccessAuditBinding | undefined {
  return port ? { port, runId: context.runId, nodeId: context.node.id, attempt: context.attempt } : undefined;
}

/**
 * Accountability evidence for one authorization decision (ADR-021), emitted
 * exactly where Authorization decides — not for support-gate or validation
 * failures, which are not access decisions. Only the host-attested
 * principal (id + type) and, if present, the registered Agent reference are
 * recorded: never Tool input or output, the grants list, or the
 * authorization context. A decision on a context too malformed to name a
 * principal is not attributable, so no actor is fabricated for it.
 * `tool.access.allowed` means the invocation path may continue, not that
 * the Tool succeeded. Emission is fire-and-forget and never changes the
 * decision or causes a retry.
 */
export function auditToolAccess(binding: ToolAccessAuditBinding | undefined, context: unknown, toolRef: ToolRef, toolExecutionId: string, permissionClasses: readonly PermissionClass[], authorization: AuthorizationDecision): void {
  if (binding === undefined) return;
  const actor = PrincipalSchema.safeParse((context as { principal?: unknown } | null)?.principal);
  if (!actor.success) return;
  const agent = AgentAuthoritySchema.safeParse((context as { agent?: unknown } | null)?.agent);
  const common = { toolExecutionId, attempt: binding.attempt, ...(binding.nodeId ? { nodeId: binding.nodeId } : {}), permissionClasses: [...permissionClasses], ...(agent.success ? { agentRef: { ...agent.data.agentRef } } : {}) };
  const base = { runId: binding.runId, actor: { id: actor.data.id, type: actor.data.type }, target: { kind: "tool" as const, toolId: toolRef.id, toolVersion: toolRef.version } };
  if (authorization.decision === "ALLOW") {
    emitAuditSafely(binding.port, { ...base, type: "tool.access.allowed", key: { toolExecutionId, attempt: binding.attempt, decision: "allow" }, payload: { ...common, agentCeilingApplied: authorization.agentCeilingApplied } });
  } else {
    emitAuditSafely(binding.port, { ...base, type: "tool.access.denied", key: { toolExecutionId, attempt: binding.attempt, decision: "deny", reasonCode: authorization.reasonCode }, payload: { ...common, reasonCode: authorization.reasonCode } });
  }
}
