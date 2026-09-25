import { z } from "zod";
import { identifierSchema, type JsonObject } from "@aao/contracts";
import type { NodeExecutor, NodePreflightResult } from "@aao/runtime";
import { deriveToolExecutionId } from "./execution-id.js";
import { executeTool, type ToolRuntimeDependencies } from "./executor.js";
import { checkToolPermissionSupport } from "./permissions.js";
import { ToolRefSchema } from "./types.js";

/**
 * Static, JSON-safe `tool` node config. State keys are *top-level*
 * `RunState.values` keys only — no JSONPath, expressions, templates, or
 * code. `inputStateKey` holds the Tool input; a successful `ToolResult` is
 * proposed under `resultStateKey`. The handler, schemas, and permission
 * classes are deliberately absent: they belong to the registered Tool, not
 * to workflow source.
 */
export const ToolNodeConfigSchema = z
  .object({
    toolRef: ToolRefSchema,
    inputStateKey: identifierSchema,
    resultStateKey: identifierSchema,
  })
  .strict()
  .refine((config) => config.inputStateKey !== config.resultStateKey, {
    message: "resultStateKey must differ from inputStateKey",
    path: ["resultStateKey"],
  });
export type ToolNodeConfig = z.infer<typeof ToolNodeConfigSchema>;

/** The executor-failure namespace this node reports under; the generic Runtime carries it opaquely. */
export const TOOL_NODE_FAILURE_NAMESPACE = "tool";

/**
 * Bridges the Tool Runtime into the generic workflow Runtime as a `tool`
 * `NodeExecutor`. Callers register it explicitly; `@aao/runtime` registers
 * nothing tool-related, so without it a `tool` node still fails preflight
 * with `NODE_EXECUTOR_NOT_FOUND`.
 *
 * Preflight (`validateConfig`) proves, before any node runs, that the config
 * is well-formed, the exact Tool version is registered (so its schemas
 * compiled), and every permission class it requires is supported by Tool
 * Runtime V1. It never inspects runtime state values or calls a handler.
 *
 * Execution reads `RunState.values[inputStateKey]`, calls the canonical
 * `executeTool` once, and either proposes exactly one state patch
 * (`{ [resultStateKey]: ToolResult }`, applied by the Runtime) or returns a
 * safe executor failure `{ namespace: "tool", code: <ToolFailureCode> }`
 * with no patch at all. It never mutates workflow state.
 */
export function createToolNodeExecutor(dependencies: ToolRuntimeDependencies): NodeExecutor {
  function validate(config: JsonObject): { ok: true; config: ToolNodeConfig } | { ok: false; issues: string[] } {
    const parsed = ToolNodeConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(config)"}: ${issue.message}`) };
    }
    const { toolRef } = parsed.data;
    const tool = dependencies.tools.get(toolRef);
    if (tool === undefined) return { ok: false, issues: [`toolRef: TOOL_NOT_FOUND: tool "${toolRef.id}" version "${toolRef.version}" is not registered`] };
    const support = checkToolPermissionSupport(tool.spec);
    if (!support.supported) {
      return { ok: false, issues: [`toolRef: TOOL_PERMISSION_UNSUPPORTED: tool "${toolRef.id}" version "${toolRef.version}" requires unsupported permission classes: ${support.unsupported.join(", ")}`] };
    }
    return { ok: true, config: parsed.data };
  }

  return {
    kind: "tool",

    validateConfig({ node }): NodePreflightResult {
      const verdict = validate(node.config);
      return verdict.ok ? { ok: true } : verdict;
    },

    async execute(context) {
      const verdict = validate(context.node.config);
      // Preflight already proved this config valid; reaching here means the
      // registry changed mid-run or the Runtime skipped preflight.
      if (!verdict.ok) throw new Error("Tool node config is invalid.");
      const { toolRef, inputStateKey, resultStateKey } = verdict.config;

      // The input is whatever the workflow state holds; `executeTool`
      // validates it (a missing value is INVALID_TOOL_REQUEST, a
      // non-conforming one TOOL_INPUT_SCHEMA_MISMATCH) like any untrusted request.
      const request = { schemaVersion: 1, toolExecutionId: deriveToolExecutionId(context.runId, context.node.id), toolRef, input: context.state.values[inputStateKey] };
      const outcome = await executeTool({ request, ...dependencies });
      if (!outcome.ok) return { ok: false, failure: { namespace: TOOL_NODE_FAILURE_NAMESPACE, code: outcome.failure.code } };
      return { ok: true, statePatch: { [resultStateKey]: outcome.result } };
    },
  };
}
