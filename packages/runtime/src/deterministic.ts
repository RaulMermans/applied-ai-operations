import { z } from "zod";
import { entityVersionSchema, identifierSchema, type JsonObject, type JsonValue } from "@aao/contracts";
import type { NodeExecutionResult, NodeExecutor, NodePreflightResult } from "./types.js";

/**
 * Static, JSON-safe `deterministic` node config: an exact reference to a
 * trusted host executor. Like a Tool node's `toolRef`, it names code and
 * never carries it. There is no serialized JavaScript, expression, module
 * path, or "latest" version.
 */
export const DeterministicExecutorRefSchema = z.object({ id: identifierSchema.max(128), version: entityVersionSchema }).strict();
export type DeterministicExecutorRef = z.infer<typeof DeterministicExecutorRefSchema>;
export const DeterministicNodeConfigSchema = z.object({ executorRef: DeterministicExecutorRefSchema }).strict();
export type DeterministicNodeConfig = z.infer<typeof DeterministicNodeConfigSchema>;

/**
 * The minimum an executor receives: Run and Node identity, a detached copy
 * of the current state, and the attempt's cancellation signal. It gets no
 * Governance, Approval, durability store, registry, or Runtime internals.
 * It can only propose a patch, which the Runtime validates and applies.
 */
export interface DeterministicExecutorContext {
  readonly runId: string;
  readonly nodeId: string;
  readonly state: { readonly revision: number; readonly values: Readonly<Record<string, JsonValue>> };
  readonly signal: AbortSignal;
}

/** Success proposes an optional state patch. An expected failure is a bounded UPPER_SNAKE_CASE code, never a message. */
export type DeterministicExecutorResult = { ok: true; statePatch?: JsonObject } | { ok: false; code: string };

/**
 * Trusted host code for one `deterministic` node, identified by exact
 * `id` + `version` (ADR-025). It is not an adapter. It integrates no
 * external substrate, and nothing in a Workflow can register, select by
 * name pattern, or load one.
 */
export interface DeterministicExecutor {
  readonly id: string;
  readonly version: string;
  execute(context: DeterministicExecutorContext): Promise<DeterministicExecutorResult>;
}

/** The executor-failure namespace `deterministic` nodes report under; the Runtime carries it opaquely. */
export const DETERMINISTIC_NODE_FAILURE_NAMESPACE = "deterministic";
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const refKey = (ref: DeterministicExecutorRef) => JSON.stringify([ref.id, ref.version]);

/**
 * The canonical `deterministic` NodeExecutor. Executors are registered at
 * construction only: each is validated, a duplicate exact `id@version`
 * throws, and `execute` is captured once, so mutating the caller's objects
 * afterwards changes nothing. Preflight fails a node whose `executorRef` is
 * not registered, before anything executes. Neither retry nor crash replay
 * is ever declared safe. Host code is opaque, so the Runtime defaults
 * (`unsafe`) stand.
 */
export function createDeterministicNodeExecutor(executors: readonly DeterministicExecutor[]): NodeExecutor {
  const registered = new Map<string, DeterministicExecutor["execute"]>();
  for (const executor of [...executors]) {
    const ref = DeterministicExecutorRefSchema.safeParse({ id: executor?.id, version: executor?.version });
    if (!ref.success) throw new Error(`Deterministic executor ${JSON.stringify(String(executor?.id))} has an invalid id or version.`);
    const execute = executor.execute;
    if (typeof execute !== "function") throw new Error(`Deterministic executor "${ref.data.id}" version "${ref.data.version}" has no execute function.`);
    const key = refKey(ref.data);
    if (registered.has(key)) throw new Error(`Deterministic executor "${ref.data.id}" version "${ref.data.version}" is already registered.`);
    registered.set(key, (context) => execute.call(executor, context));
  }

  function resolve(config: JsonObject): { ok: true; execute: DeterministicExecutor["execute"] } | { ok: false; issues: string[] } {
    const parsed = DeterministicNodeConfigSchema.safeParse(config);
    if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(config)"}: ${issue.message}`) };
    const execute = registered.get(refKey(parsed.data.executorRef));
    if (execute === undefined) return { ok: false, issues: [`executorRef: deterministic executor "${parsed.data.executorRef.id}" version "${parsed.data.executorRef.version}" is not registered`] };
    return { ok: true, execute };
  }

  return {
    kind: "deterministic",

    validateConfig({ node }): NodePreflightResult {
      const verdict = resolve(node.config);
      return verdict.ok ? { ok: true } : verdict;
    },

    async execute(context): Promise<NodeExecutionResult> {
      const verdict = resolve(context.node.config);
      if (!verdict.ok) throw new Error("Deterministic node config is invalid.");
      const state = Object.freeze({ revision: context.state.revision, values: Object.freeze(JSON.parse(JSON.stringify(context.state.values)) as Record<string, JsonValue>) });
      const result: unknown = await verdict.execute(Object.freeze({ runId: context.runId, nodeId: context.node.id, state, signal: context.signal }));
      if (result === null || typeof result !== "object") throw new Error("Deterministic executor returned a malformed result.");
      const outcome = result as { ok?: unknown; code?: unknown; statePatch?: unknown };
      if (outcome.ok === false) {
        const code = typeof outcome.code === "string" && FAILURE_CODE.test(outcome.code) ? outcome.code : "DETERMINISTIC_EXECUTOR_FAILED";
        return { ok: false, failure: { namespace: DETERMINISTIC_NODE_FAILURE_NAMESPACE, code } };
      }
      // The Runtime validates the patch (JSON safety, shape) exactly as for any other executor.
      if (outcome.ok === true) return outcome.statePatch === undefined ? { ok: true } : { ok: true, statePatch: outcome.statePatch as JsonObject };
      throw new Error("Deterministic executor returned a malformed result.");
    },
  };
}
