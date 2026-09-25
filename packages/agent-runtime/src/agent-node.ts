import { z } from "zod";
import { identifierSchema, type JsonObject } from "@aao/contracts";
import type { NodeExecutor, NodePreflightResult } from "@aao/runtime";
import { executeAgent, type AgentRuntimeDependencies } from "./controller.js";
import { deriveAgentExecutionId } from "./execution-id.js";
import { resolveExecutableAgent } from "./resolution.js";
import { AgentRefSchema } from "./types.js";

/**
 * Static, JSON-safe `agent` node config. State keys are *top-level*
 * `RunState.values` keys only — no paths, expressions, templating, or code.
 * `taskStateKey` holds a non-empty task string; a successful `AgentResult`
 * is proposed under `resultStateKey`. Instructions, limits, and model policy
 * are deliberately absent: they belong to the registered Agent, not to
 * workflow source.
 */
export const AgentNodeConfigSchema = z
  .object({
    agentRef: AgentRefSchema,
    taskStateKey: identifierSchema,
    resultStateKey: identifierSchema,
  })
  .strict()
  .refine((config) => config.taskStateKey !== config.resultStateKey, {
    message: "resultStateKey must differ from taskStateKey",
    path: ["resultStateKey"],
  });
export type AgentNodeConfig = z.infer<typeof AgentNodeConfigSchema>;

/** The executor-failure namespace this node reports under; the generic Runtime carries it opaquely. */
export const AGENT_NODE_FAILURE_NAMESPACE = "agent";

/**
 * Bridges the Agent Runtime into the generic workflow Runtime as an `agent`
 * `NodeExecutor`. Callers register it explicitly; `@aao/runtime` registers
 * nothing agent-related, so without it an `agent` node still fails
 * preflight with `NODE_EXECUTOR_NOT_FOUND`.
 *
 * The node is atomic from the parent Runtime's point of view: every Agent
 * iteration happens inside one `RUNNING` node execution, so it is one
 * workflow step, produces no intermediate state change or snapshot, and
 * either proposes exactly one state patch (`{ [resultStateKey]: AgentResult }`,
 * applied by the Runtime) or returns a safe executor failure
 * `{ namespace: "agent", code: <AgentFailureCode> }` with no patch at all.
 */
export function createAgentNodeExecutor(dependencies: AgentRuntimeDependencies): NodeExecutor {
  function validate(config: JsonObject): { ok: true; config: AgentNodeConfig } | { ok: false; issues: string[] } {
    const parsed = AgentNodeConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(config)"}: ${issue.message}`) };
    }
    const resolution = resolveExecutableAgent(parsed.data.agentRef, dependencies);
    if (!resolution.ok) {
      return { ok: false, issues: [`agentRef: ${resolution.failure.code}: ${resolution.failure.message}`, ...(resolution.failure.issues ?? []).map((issue) => `agentRef: ${issue}`)] };
    }
    return { ok: true, config: parsed.data };
  }

  return {
    kind: "agent",

    validateConfig({ node }): NodePreflightResult {
      const verdict = validate(node.config);
      return verdict.ok ? { ok: true } : verdict;
    },

    async execute(context) {
      const verdict = validate(context.node.config);
      // Preflight already proved this config valid; reaching here means the
      // registries changed mid-run or the Runtime skipped preflight.
      if (!verdict.ok) throw new Error("Agent node config is invalid.");
      const { agentRef, taskStateKey, resultStateKey } = verdict.config;

      // Deterministically derived from Run + Node identity into a bounded id
      // (see execution-id.ts), never random: a Node executes at most once per
      // Run in Runtime V1. The task is whatever the workflow state holds;
      // `executeAgent` validates it (a missing, non-string, or blank task is
      // INVALID_AGENT_REQUEST) like any other untrusted request.
      const request = { schemaVersion: 1, agentExecutionId: deriveAgentExecutionId(context.runId, context.node.id), agentRef, task: context.state.values[taskStateKey] };
      const outcome = await executeAgent({ request, ...dependencies });
      if (!outcome.ok) return { ok: false, failure: { namespace: AGENT_NODE_FAILURE_NAMESPACE, code: outcome.failure.code } };
      return { ok: true, statePatch: { [resultStateKey]: outcome.result } };
    },
  };
}
