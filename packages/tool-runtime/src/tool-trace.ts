import type { NodeExecutionContext } from "@aao/runtime";
import type { ToolExecutionObserver } from "./executor.js";
import { classifyToolFailure } from "./tool-node.js";

/**
 * Maps Tool Runtime observations to typed Trace drafts (ADR-020): identity,
 * permission classes, attempt, and bounded codes only — never Tool input,
 * output, authorization context, or handler errors.
 */
export function toolTraceObserver(context: NodeExecutionContext): ToolExecutionObserver | undefined {
  const { trace, attempt } = context;
  if (!trace) return undefined;
  const span = (toolExecutionId: string) => ({ kind: "tool" as const, toolExecutionId, attempt });
  return {
    async blocked({ toolRef, toolExecutionId, failure, permissionClasses }) {
      await trace.emit({ type: "tool.call.blocked", span: span(toolExecutionId), key: {}, payload: { toolRef, toolExecutionId, attempt, code: failure.code, category: classifyToolFailure(failure), ...(permissionClasses && permissionClasses.length > 0 ? { permissionClasses } : {}), ...(failure.authorizationReasonCode ? { access: { decision: "deny" as const, reasonCode: failure.authorizationReasonCode } } : {}) } });
    },
    async started({ toolRef, toolExecutionId, permissionClasses, authorization }) {
      await trace.emit({ type: "tool.call.started", span: span(toolExecutionId), key: {}, payload: { toolRef, toolExecutionId, attempt, permissionClasses, access: { decision: "allow", principalId: authorization.principalId, agentCeilingApplied: authorization.agentCeilingApplied }, recoveryReplay: trace.recoveryReplay } });
    },
    async completed({ toolRef, toolExecutionId, permissionClasses }) {
      await trace.emit({ type: "tool.call.completed", span: span(toolExecutionId), key: {}, payload: { toolRef, toolExecutionId, attempt, permissionClasses, result: "success" } });
    },
    async failed({ toolRef, toolExecutionId, failure }) {
      await trace.emit({ type: "tool.call.failed", span: span(toolExecutionId), key: {}, payload: { toolRef, toolExecutionId, attempt, code: failure.code, ...(failure.handlerFailureCode ? { handlerFailureCode: failure.handlerFailureCode } : {}), retryable: failure.handlerFailureRetryable === true, category: classifyToolFailure(failure) } });
    },
  };
}
