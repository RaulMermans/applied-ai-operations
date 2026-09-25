import { z } from "zod";
import { ModelPolicyIdSchema, identifierSchema, type JsonObject } from "@aao/contracts";
import type { NodeExecutor, NodePreflightResult } from "@aao/runtime";
import { executeModelRequest } from "./executor.js";
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

    validateConfig({ node }): NodePreflightResult {
      const verdict = validate(node.config);
      return verdict.ok ? { ok: true } : verdict;
    },

    async execute(context) {
      const verdict = validate(context.node.config);
      if (!verdict.ok) throw new Error("Model node config is invalid.");
      const { modelPolicyRef, requestStateKey, resultStateKey } = verdict.config;

      const outcome = await executeModelRequest({ request: context.state.values[requestStateKey], modelPolicyRef, policies, models });
      if (!outcome.ok) return { ok: false, failure: { namespace: MODEL_NODE_FAILURE_NAMESPACE, code: outcome.failure.code } };
      return { ok: true, statePatch: { [resultStateKey]: outcome.result } };
    },
  };
}
