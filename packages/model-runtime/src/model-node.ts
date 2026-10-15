import { z } from "zod";
import { ModelPolicyIdSchema, identifierSchema, type JsonObject } from "@aao/contracts";
import type { NodeExecutor, NodePreflightResult, NodeTraceContext } from "@aao/runtime";
import { executeModelRequest, type ModelInvocationObserver } from "./executor.js";
import { hasUnsupportedConstraints, type ModelPolicyRegistry } from "./policy-registry.js";
import type { ModelRegistry } from "./registry.js";

/**
 * Static, JSON-safe `model` node config. State keys are *top-level*
 * `RunState.values` keys only — no paths, templating, or expressions.
 * `requestStateKey` holds a prepared `ModelRequest`; a successful
 * `ModelResult` is proposed under `resultStateKey`.
 */
export const ModelNodeConfigSchema = z
  .object({
    modelPolicyRef: ModelPolicyIdSchema,
    requestStateKey: identifierSchema,
    resultStateKey: identifierSchema,
  })
  .strict()
  .refine((config) => config.requestStateKey !== config.resultStateKey, {
    message: "resultStateKey must differ from requestStateKey",
    path: ["resultStateKey"],
  });
export type ModelNodeConfig = z.infer<typeof ModelNodeConfigSchema>;

export interface ModelNodeExecutorDependencies {
  models: ModelRegistry;
  policies: ModelPolicyRegistry;
}

/** The executor-failure namespace this node reports under; the generic Runtime carries it opaquely. */
export const MODEL_NODE_FAILURE_NAMESPACE = "model";

/**
 * Bridges Model Runtime into the generic workflow Runtime as a `model`
 * `NodeExecutor`. The caller registers it explicitly with a Node Registry;
 * the generic Runtime never learns about models, providers, or prompts.
 * Exactly one model invocation per node execution. The executor never
 * mutates `RunState`: it proposes a state patch, which the Runtime validates
 * and applies (and which advances `RunState.revision`). A Model Runtime
 * failure is returned through the generic safe executor-failure protocol as
 * `{ namespace: "model", code: <ModelFailureCode> }` — only the code, never
 * the failure's message or details — so the Runtime's `NODE_EXECUTION_FAILED`
 * keeps machine-readable causality without learning what a model is.
 */
export function createModelNodeExecutor(dependencies: ModelNodeExecutorDependencies): NodeExecutor {
  const { models, policies } = dependencies;

  function validate(config: JsonObject): { ok: true; config: ModelNodeConfig } | { ok: false; issues: string[] } {
    const parsed = ModelNodeConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(config)"}: ${issue.message}`) };
    }
    const policy = policies.get(parsed.data.modelPolicyRef);
    if (policy === undefined) return { ok: false, issues: [`modelPolicyRef: model policy "${parsed.data.modelPolicyRef}" is not registered`] };
    if (hasUnsupportedConstraints(policy)) return { ok: false, issues: [`modelPolicyRef: model policy "${policy.id}" declares unsupported constraints`] };
    return { ok: true, config: parsed.data };
  }

  return {
    kind: "model",

    // Crash recovery (ADR-019): a model call has no external side effect in this
    // architecture, so an attempt whose outcome was lost may be replayed (it may
    // cost tokens and produce a different result; nothing was committed). This
    // never enables ordinary retries, which stay governed by `retrySafety`.
    recoverySafety: () => "safe",

    validateConfig({ node }): NodePreflightResult {
      const verdict = validate(node.config);
      return verdict.ok ? { ok: true } : verdict;
    },

    async execute(context) {
      const verdict = validate(context.node.config);
      if (!verdict.ok) throw new Error("Model node config is invalid.");
      const { modelPolicyRef, requestStateKey, resultStateKey } = verdict.config;

      const observer = context.trace ? modelTraceObserver(context.trace, context.attempt) : undefined;
      // The Runtime attempt's own signal: one cancellation lineage from attempt timeout to provider.
      const outcome = await executeModelRequest({ request: context.state.values[requestStateKey], modelPolicyRef, policies, models, signal: context.signal, ...(observer ? { observer } : {}) });
      if (!outcome.ok) return { ok: false, failure: { namespace: MODEL_NODE_FAILURE_NAMESPACE, code: outcome.failure.code } };
      return { ok: true, statePatch: { [resultStateKey]: outcome.result } };
    },
  };
}

/**
 * Maps model invocation observations to typed Trace drafts (ADR-020):
 * invocation identity, binding, registered provider identity, output kind,
 * finish reason, and token usage. Messages and output are never traced; no
 * cost is estimated. `parent` lets an Agent nest calls under its own span.
 */
export function modelTraceObserver(trace: NodeTraceContext, attempt: number, parent?: NodeTraceContext["span"], key: Record<string, number> = {}): ModelInvocationObserver {
  const span = (invocationId: string) => ({ kind: "model" as const, invocationId, attempt });
  const nesting = parent ? { parentSpan: parent } : {};
  return {
    async started(info) {
      await trace.emit({ type: "model.call.started", span: span(info.invocationId), ...nesting, key, payload: { ...info, attempt, recoveryReplay: trace.recoveryReplay } });
    },
    async completed(info) {
      await trace.emit({ type: "model.call.completed", span: span(info.invocationId), ...nesting, key, payload: { ...info, attempt } });
    },
    async failed(info) {
      await trace.emit({ type: "model.call.failed", span: span(info.invocationId), ...nesting, key, payload: { ...info, attempt } });
    },
  };
}
