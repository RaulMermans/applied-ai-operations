import type { NodeDefinition, TraceEventDraft, TraceSpanRef } from "@aao/contracts";
import type { NodeTraceContext, NodeTraceEventDraft, RuntimeTracePort } from "./types.js";

/**
 * Runtime side of the optional trace port (ADR-020). One direction only:
 * the Runtime *tells* the port what it already decided and never reads
 * anything back — the port has no read method, and its result is
 * discarded. A missing port is a no-op; a port that throws, rejects, or
 * misbehaves is swallowed here, so trace failure can never change a
 * Runtime decision, trigger a retry, or replay an executor.
 */

type RunIdentity = { runId: string; workflowId: string; workflowVersion: string };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A draft without the Run identity the tracer fills in. */
export type RunTraceDraft = DistributiveOmit<TraceEventDraft, "runId" | "workflowId" | "workflowVersion">;

export interface RunTracer {
  /** False without a configured port: callers skip tracing entirely, so the untraced path is unchanged. */
  readonly enabled: boolean;
  emit(draft: RunTraceDraft): Promise<void>;
}

const RUN_SPAN: TraceSpanRef = Object.freeze({ kind: "run" });

export function createRunTracer(port: RuntimeTracePort | undefined, identity: RunIdentity): RunTracer {
  return {
    enabled: port !== undefined,
    async emit(draft) {
      if (port === undefined) return;
      try {
        await port.emit({ ...draft, ...identity } as TraceEventDraft);
      } catch {
        // Observability failure is never execution truth.
      }
    },
  };
}

export function runSpan(): TraceSpanRef {
  return RUN_SPAN;
}

export function nodeSpan(nodeId: string, step: number, attempt: number): TraceSpanRef {
  return { kind: "node", nodeId, step, attempt };
}

/**
 * The trusted per-attempt trace context handed to a Node executor. It fills
 * in Run/Node identity, the node-attempt span as the default parent, and the
 * step/attempt/replay discriminators of every event key. Once the Runtime
 * stops waiting for the attempt (it settled, or timed out and was
 * abandoned), the context closes: a late result of an abandoned attempt can
 * never become trace evidence, just as it can never become state.
 */
export function createNodeTraceContext(tracer: RunTracer, node: NodeDefinition, step: number, attempt: number, recoveryReplay: boolean): { context: NodeTraceContext; close(): void } {
  let open = true;
  const span = nodeSpan(node.id, step, attempt);
  const context: NodeTraceContext = Object.freeze({
    span,
    recoveryReplay,
    async emit(draft: NodeTraceEventDraft) {
      if (!open) return;
      await tracer.emit({ ...draft, nodeId: node.id, parentSpan: draft.parentSpan ?? span, key: { ...draft.key, step, attempt, replay: recoveryReplay } } as RunTraceDraft);
    },
  });
  return { context, close: () => { open = false; } };
}
