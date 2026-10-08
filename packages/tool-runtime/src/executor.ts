import { z } from "zod";
import { authorize, type AuthorizationAllow, type AuthorizationContext } from "@aao/authorization";
import type { JsonValue, PermissionClass } from "@aao/contracts";
import { isJsonSafe } from "@aao/runtime";
import { checkToolPermissionSupport } from "./permissions.js";
import { auditToolAccess, type ToolAccessAuditBinding } from "./tool-audit.js";
import { resolveToolBinding, type ToolRegistry } from "./registry.js";
import { HandlerFailureCodeSchema, ToolExecutionRequestSchema, ToolResultSchema, type ToolExecutionResult, type ToolFailure, type ToolRef } from "./types.js";

export interface ToolRuntimeDependencies {
  tools: ToolRegistry;
}

export interface ExecuteToolParams extends ToolRuntimeDependencies {
  /** Untrusted: validated before anything else happens. */
  request: unknown;
  /**
   * Required, host-attested authority for this execution. There is no
   * default: a missing context fails `TOOL_AUTHORIZATION_REQUIRED`, a
   * malformed one `TOOL_AUTHORIZATION_DENIED` (`INVALID_AUTHORIZATION_CONTEXT`).
   * It is a separate parameter, never read from `request.input`.
   */
  authorizationContext: AuthorizationContext;
  /** Optional cooperative cancellation forwarded to the handler; never changes how a result is validated. */
  signal?: AbortSignal;
  /** Optional observer (ADR-020). Told what happened; never consulted. A throwing observer changes nothing. */
  observer?: ToolExecutionObserver;
  /**
   * Optional emit-only Audit binding (ADR-021): records each authorization
   * decision (`tool.access.allowed` / `tool.access.denied`) for the Run's
   * audit stream. Never consulted, never awaited into a decision; a failing
   * port changes nothing and causes no retry.
   */
  audit?: ToolAccessAuditBinding;
}


/**
 * Safe-metadata notifications from the single Tool execution path. No Tool
 * input, output, authorization context, or handler error ever reaches an
 * observer. `blocked` means the handler was never invoked (handler calls =
 * 0); `started` fires only once every pre-execution check has passed and the
 * handler is about to be invoked; `completed` only when the Tool Runtime
 * accepted the handler result; `failed` when an invoked handler's call did not
 * produce an accepted result.
 */
export interface ToolExecutionObserver {
  blocked?(info: { toolRef: ToolRef; toolExecutionId: string; failure: ToolFailure; permissionClasses?: PermissionClass[] }): void | Promise<void>;
  started?(info: { toolRef: ToolRef; toolExecutionId: string; permissionClasses: PermissionClass[]; authorization: AuthorizationAllow }): void | Promise<void>;
  completed?(info: { toolRef: ToolRef; toolExecutionId: string; permissionClasses: PermissionClass[] }): void | Promise<void>;
  failed?(info: { toolRef: ToolRef; toolExecutionId: string; failure: ToolFailure }): void | Promise<void>;
}

async function notify<K extends keyof ToolExecutionObserver>(observer: ToolExecutionObserver | undefined, kind: K, info: Parameters<NonNullable<ToolExecutionObserver[K]>>[0]): Promise<void> {
  const callback = observer?.[kind] as ((value: typeof info) => void | Promise<void>) | undefined;
  if (typeof callback !== "function") return;
  try { await callback.call(observer, JSON.parse(JSON.stringify(info)) as typeof info); } catch { /* observation never changes execution */ }
}

/** The only handler result shapes accepted. Strict: any extra field (message, stack, details, headers, ...) is rejected, never carried. */
const HandlerResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), output: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), code: HandlerFailureCodeSchema, retryable: z.literal(true).optional() }).strict(),
]);

/**
 * The single canonical Tool execution path:
 *
 *   ToolExecutionRequest → Tool Registry → permission support gate
 *     → authorization → inputSchema → trusted handler → JSON safety
 *     → outputSchema → ToolResult
 *
 * Nothing reaches the handler unless the request, the Tool, its permission
 * classes, the caller's authority, and its input all check out. The support
 * gate runs before authorization (a Tool this runtime version cannot run is
 * `TOOL_PERMISSION_UNSUPPORTED` whatever the grants), and authorization runs
 * before input validation (an unauthorized caller learns nothing about the
 * Tool's input contract); nothing is returned as success
 * unless the output is JSON-safe and matches `outputSchema`. The handler is
 * invoked **at most once**: no retry, no fallback Tool, no replay, no
 * timeout race (Sprint 8 has no cooperative cancellation to make one
 * honest). Expected failures are values; only invariant violations throw.
 * The workflow Tool Node — and every future caller (Agent Tool use, MCP
 * adapters) — reuses this function rather than a second execution path.
 */
export async function executeTool(params: ExecuteToolParams): Promise<ToolExecutionResult> {
  if (!isJsonSafe(params.request)) {
    return fail({ code: "INVALID_TOOL_REQUEST", message: "Tool execution request is not JSON-safe." });
  }
  const parsed = ToolExecutionRequestSchema.safeParse(params.request);
  if (!parsed.success) {
    return fail({
      code: "INVALID_TOOL_REQUEST",
      message: "Tool execution request does not match ToolExecutionRequestSchema.",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    });
  }
  const request = parsed.data;
  const toolExecutionId = request.toolExecutionId;
  const toolRef: ToolRef = { id: request.toolRef.id, version: request.toolRef.version };
  const observer = params.observer;
  // Filled once the Tool resolves; empty means the Tool (and its requirements) never resolved.
  const permissionClasses: PermissionClass[] = [];
  let invoked = false;
  const failWith = async (failure: Omit<ToolFailure, "toolExecutionId" | "toolRef">): Promise<ToolExecutionResult> => {
    const full: ToolFailure = { ...failure, toolExecutionId, toolRef: { ...toolRef } };
    if (observer && invoked) await notify(observer, "failed", { toolRef, toolExecutionId, failure: full });
    else if (observer) await notify(observer, "blocked", { toolRef, toolExecutionId, failure: full, ...(permissionClasses.length > 0 ? { permissionClasses: [...permissionClasses] } : {}) });
    return fail(full);
  };

  const tool = resolveToolBinding(params.tools, toolRef);
  if (tool === undefined) {
    return failWith({ code: "TOOL_NOT_FOUND", message: `Tool "${toolRef.id}" version "${toolRef.version}" is not registered.` });
  }

  permissionClasses.push(...tool.spec.permissionClasses);
  const support = checkToolPermissionSupport(tool.spec);
  if (!support.supported) {
    return failWith({
      code: "TOOL_PERMISSION_UNSUPPORTED",
      message: `Tool "${toolRef.id}" version "${toolRef.version}" requires permission classes Tool Runtime V1 does not execute.`,
      unsupportedPermissionClasses: support.unsupported,
    });
  }

  // Authorization: the one canonical evaluator, over the registered spec's
  // requirements and the host-attested context only.
  if (params.authorizationContext === undefined || params.authorizationContext === null) {
    return failWith({ code: "TOOL_AUTHORIZATION_REQUIRED", message: `Tool "${toolRef.id}" version "${toolRef.version}" requires an authorization context.` });
  }
  const authorization = authorize({
    schemaVersion: 1,
    action: "tool.execute",
    resource: { type: "tool", id: toolRef.id, version: toolRef.version },
    requiredPermissionClasses: [...tool.spec.permissionClasses],
    context: params.authorizationContext,
  });
  auditToolAccess(params.audit, params.authorizationContext, toolRef, toolExecutionId, tool.spec.permissionClasses, authorization);
  if (authorization.decision !== "ALLOW") {
    return failWith({
      code: "TOOL_AUTHORIZATION_DENIED",
      message: `Tool "${toolRef.id}" version "${toolRef.version}" execution is not authorized.`,
      authorizationReasonCode: authorization.reasonCode,
    });
  }

  const inputCheck = tool.inputSchema.validate(request.input);
  if (!inputCheck.ok) {
    return failWith({ code: "TOOL_INPUT_SCHEMA_MISMATCH", message: "Tool input does not match the Tool's inputSchema.", issues: inputCheck.issues });
  }

  invoked = true;
  if (observer) await notify(observer, "started", { toolRef, toolExecutionId, permissionClasses, authorization });
  let raw: unknown;
  try {
    raw = await tool.handler.execute({ toolExecutionId, tool: { ...toolRef }, input: clone(request.input), ...(params.signal ? { signal: params.signal } : {}) });
  } catch {
    // Never expose or parse the thrown value (message, stack, URL, token, ...).
    return failWith({ code: "TOOL_EXECUTION_FAILED", message: `Tool "${toolRef.id}" version "${toolRef.version}" handler failed.` });
  }

  const shape = HandlerResultSchema.safeParse(raw);
  if (!shape.success) {
    return failWith({ code: "INVALID_TOOL_RESULT", message: "Tool handler returned a malformed result." });
  }
  if (!shape.data.ok) {
    return failWith({
      code: "TOOL_EXECUTION_FAILED",
      message: `Tool "${toolRef.id}" version "${toolRef.version}" handler reported a failure.`,
      handlerFailureCode: shape.data.code,
      ...(shape.data.retryable ? { handlerFailureRetryable: true as const } : {}),
    });
  }
  const output = shape.data.output;
  if (output === undefined || !isJsonSafe(output)) {
    return failWith({ code: "INVALID_TOOL_RESULT", message: "Tool handler output is not JSON-safe." });
  }
  // Issues are deliberately omitted: output comes from the handler, and a
  // mismatch report must not echo arbitrary handler data into a failure.
  if (!tool.outputSchema.validate(output).ok) {
    return failWith({ code: "TOOL_OUTPUT_SCHEMA_MISMATCH", message: "Tool output does not match the Tool's outputSchema." });
  }

  const result = ToolResultSchema.safeParse({ schemaVersion: 1, toolExecutionId, toolRef: { ...toolRef }, output: clone(output) });
  // Every field was validated above; a failure here is a Tool Runtime bug.
  if (!result.success) throw new Error("Tool Runtime produced a result that fails ToolResultSchema.");
  if (observer) await notify(observer, "completed", { toolRef, toolExecutionId, permissionClasses });
  return { ok: true, result: result.data, authorization };
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(failure: ToolFailure): ToolExecutionResult {
  return { ok: false, failure };
}
