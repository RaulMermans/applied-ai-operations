import { z } from "zod";
import { identifierSchema, type FailureCategory, type JsonObject, type RetrySafety } from "@aao/contracts";
import type { NodeExecutor, NodePreflightResult } from "@aao/runtime";
import { deriveToolExecutionId } from "./execution-id.js";
import type { AuthorizationContext } from "@aao/authorization";
import { executeTool, type ToolRuntimeDependencies } from "./executor.js";
import { checkToolPermissionSupport } from "./permissions.js";
import { resolveToolBinding } from "./registry.js";
import { ToolRefSchema, type ToolFailure, type ToolRef } from "./types.js";

/**
 * Static, JSON-safe `tool` node config. State keys are *top-level*
 * `RunState.values` keys only — no JSONPath, expressions, templates, or
 * code. `inputStateKey` holds the Tool input; a successful `ToolResult` is
 * proposed under `resultStateKey`. The handler, schemas, and permission
 * classes are deliberately absent: they belong to the registered Tool, not
 * to workflow source. So is every form of authority (grants, permissions,
 * `allow`, ...): strict parsing rejects any such field, because authority
 * comes only from the host's `resolveAuthorizationContext`.
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
 * Deterministic structured classification of every Tool failure code for
 * the Runtime Reliability Controller. Only a handler's explicit
 * `retryable: true` produces a retryable category; authority, support-gate,
 * and validation failures can never be retried.
 */
export function classifyToolFailure(failure: Pick<ToolFailure, "code" | "handlerFailureRetryable">): FailureCategory {
  switch (failure.code) {
    case "TOOL_AUTHORIZATION_REQUIRED":
    case "TOOL_AUTHORIZATION_DENIED":
      return "AUTHORIZATION";
    case "TOOL_PERMISSION_UNSUPPORTED":
      return "POLICY";
    case "TOOL_EXECUTION_FAILED":
      return failure.handlerFailureRetryable === true ? "TRANSIENT_DEPENDENCY" : "EXECUTION";
    case "INVALID_TOOL_REQUEST":
    case "TOOL_NOT_FOUND":
    case "TOOL_INPUT_SCHEMA_MISMATCH":
    case "TOOL_OUTPUT_SCHEMA_MISMATCH":
    case "INVALID_TOOL_RESULT":
      return "VALIDATION";
  }
}

/**
 * The only facts a host resolver receives to locate the authority it has
 * already attested for this execution: which Run, which node, which Tool.
 * Never workflow state, Tool input, or node config beyond `toolRef`.
 */
export interface ToolAuthorizationTarget {
  readonly runId: string;
  readonly nodeId: string;
  readonly toolRef: Readonly<ToolRef>;
}

/**
 * Trusted host boundary: returns the host-attested `AuthorizationContext`
 * for one Tool Node execution (or `undefined` if none exists, which fails
 * closed). Tests inject a static resolver; a real host might consult its own
 * session or identity layer. AAO does no lookup of its own.
 */
export type ResolveToolAuthorizationContext = (target: ToolAuthorizationTarget) => AuthorizationContext | undefined | Promise<AuthorizationContext | undefined>;

export interface ToolNodeDependencies extends ToolRuntimeDependencies {
  resolveAuthorizationContext: ResolveToolAuthorizationContext;
}

/**
 * Bridges the Tool Runtime into the generic workflow Runtime as a `tool`
 * `NodeExecutor`. Callers register it explicitly; `@aao/runtime` registers
 * nothing tool-related, so without it a `tool` node still fails preflight
 * with `NODE_EXECUTOR_NOT_FOUND`.
 *
 * Preflight (`validateConfig`) proves, before any node runs, that the config
 * is well-formed, the exact Tool version is registered (so its schemas
 * compiled), and every permission class it requires is supported by Tool
 * Runtime V1. It never inspects runtime state values, calls a handler, or
 * decides authorization — authority is dynamic, per execution.
 *
 * Execution obtains the host-attested Authorization Context from
 * `resolveAuthorizationContext` (never from workflow state or config), reads
 * `RunState.values[inputStateKey]`, calls the canonical `executeTool` once —
 * which authorizes before input validation or the handler — and either
 * proposes exactly one state patch
 * (`{ [resultStateKey]: ToolResult }`, applied by the Runtime) or returns a
 * safe executor failure `{ namespace: "tool", code: <ToolFailureCode> }`
 * with no patch at all. It never mutates workflow state.
 */
export function createToolNodeExecutor(dependencies: ToolNodeDependencies): NodeExecutor {
  // No implicit context: a Tool Node without a trusted resolver is a host programming error.
  if (typeof dependencies?.resolveAuthorizationContext !== "function") {
    throw new Error("createToolNodeExecutor requires a resolveAuthorizationContext function.");
  }
  const { tools, resolveAuthorizationContext } = dependencies;

  function validate(config: JsonObject): { ok: true; config: ToolNodeConfig } | { ok: false; issues: string[] } {
    const parsed = ToolNodeConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(config)"}: ${issue.message}`) };
    }
    const { toolRef } = parsed.data;
    const spec = tools.getSpec(toolRef);
    if (spec === undefined) return { ok: false, issues: [`toolRef: TOOL_NOT_FOUND: tool "${toolRef.id}" version "${toolRef.version}" is not registered`] };
    const support = checkToolPermissionSupport(spec);
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

    // Retry safety is the registered Tool's trusted declaration, never node config or state.
    retrySafety({ node }): RetrySafety {
      const verdict = validate(node.config);
      return verdict.ok ? (resolveToolBinding(tools, verdict.config.toolRef)?.retrySafety ?? "unsafe") : "unsafe";
    },

    async execute(context) {
      const verdict = validate(context.node.config);
      // Preflight already proved this config valid; reaching here means the
      // registry changed mid-run or the Runtime skipped preflight.
      if (!verdict.ok) throw new Error("Tool node config is invalid.");
      const { toolRef, inputStateKey, resultStateKey } = verdict.config;
      const fail = (code: ToolFailure["code"], handlerFailureRetryable?: true) => ({ ok: false as const, failure: { namespace: TOOL_NODE_FAILURE_NAMESPACE, code, category: classifyToolFailure({ code, handlerFailureRetryable }) } });

      let authorizationContext: AuthorizationContext | undefined;
      try {
        authorizationContext = await resolveAuthorizationContext(Object.freeze({ runId: context.runId, nodeId: context.node.id, toolRef: Object.freeze({ ...toolRef }) }));
      } catch {
        // Never expose or parse the thrown value: the context could not be resolved.
        return fail("TOOL_AUTHORIZATION_REQUIRED");
      }

      // The input is whatever the workflow state holds; `executeTool`
      // validates it (a missing value is INVALID_TOOL_REQUEST, a
      // non-conforming one TOOL_INPUT_SCHEMA_MISMATCH) like any untrusted request.
      const request = { schemaVersion: 1, toolExecutionId: deriveToolExecutionId(context.runId, context.node.id), toolRef, input: context.state.values[inputStateKey] };
      const outcome = await executeTool({ request, tools, authorizationContext: authorizationContext as AuthorizationContext, signal: context.signal });
      // Only the Tool failure code and its classification go upward; the authorization reason stays with direct callers.
      if (!outcome.ok) return fail(outcome.failure.code, outcome.failure.handlerFailureRetryable);
      return { ok: true, statePatch: { [resultStateKey]: outcome.result } };
    },
  };
}
