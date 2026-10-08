import { z } from "zod";
import { AuthorizationDenialReasonCodeSchema, type AuthorizationAllow } from "@aao/authorization";
import { JsonValueSchema, PermissionClassSchema, ToolIdSchema, entityVersionSchema, identifierSchema, type JsonValue, type RetrySafety, type ToolIdempotency, type ToolSpec } from "@aao/contracts";

// --- Tool reference -----------------------------------------------------------

/**
 * A stable, version-exact reference to a registered Tool, using the canonical
 * `ToolSpec` identity (`id` + entity `version`). Lookup is exact: there is no
 * "latest", range, or fuzzy version resolution.
 */
export const ToolRefSchema = z
  .object({
    id: ToolIdSchema,
    version: entityVersionSchema,
  })
  .strict();
export type ToolRef = z.infer<typeof ToolRefSchema>;

// --- Handler (trusted, code-registered implementation) --------------------------

/**
 * The bounded vocabulary a handler may use to report an *expected* failure
 * (e.g. `NOT_FOUND`): an UPPER_SNAKE_CASE code, nothing else — no message,
 * stack, URL, header, credential, or nested provider response.
 */
export const HANDLER_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const HandlerFailureCodeSchema = z.string().regex(HANDLER_FAILURE_CODE_PATTERN);

/**
 * Everything a handler receives, and nothing more: the execution id, the
 * Tool it is implementing, and schema-validated input (a defensive clone).
 * No workflow state, process environment, credentials, database, MCP
 * session, model client, Agent Runtime, or global service is injected.
 * Future integration adapters construct handlers with their own explicit
 * dependencies *outside* the Tool Runtime.
 */
export interface ToolHandlerContext {
  toolExecutionId: string;
  tool: ToolRef;
  input: JsonValue;
  /** Present when the caller can abandon this execution (a Runtime attempt timeout). Cooperative and best-effort. */
  signal?: AbortSignal;
}

/**
 * What a handler returns: JSON output, or a safe machine-readable failure
 * code. Expected failures are values, not exceptions. `retryable: true` is
 * the handler's only way to declare an explicitly transient dependency
 * failure; whether a retry happens is still decided by the Runtime (ADR-018).
 */
export type ToolHandlerResult = { ok: true; output: JsonValue } | { ok: false; code: string; retryable?: true };

/** A trusted, provider-neutral Tool implementation. Invoked at most once per Tool execution request. */
export interface ToolHandler {
  execute(context: ToolHandlerContext): Promise<ToolHandlerResult>;
}

/**
 * The Tool Runtime's binding for one Tool: the canonical, declarative
 * `ToolSpec` (reused intact from `@aao/contracts` — never duplicated) plus
 * the trusted executable `handler`. The handler lives only in Runtime
 * configuration; it never enters `ToolSpec`, a request, a result, or state.
 */
export interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
  /**
   * Trusted retry-safety declaration (ADR-018). Defaults to `"unsafe"`.
   * `"safe"` is accepted only for Tools whose every permission class is
   * `read_only`: a `write_draft` Tool can duplicate artifacts, so it is
   * never Runtime-retried in Sprint 13. Not part of `ToolSpec`.
   */
  retrySafety?: RetrySafety;
  /**
   * Trusted idempotency assertion (ADR-019). Defaults to `"none"`.
   * `"execution_id"` asserts that repeated invocations carrying the same
   * `toolExecutionId` resolve to one logical operation. AAO guarantees the
   * id is stable across retries, restarts, and recovery replays; it cannot
   * verify an implementation or external provider honors it. It never
   * enables ordinary Runtime retries of a `write_draft` Tool.
   */
  idempotency?: ToolIdempotency;
}

// --- Request ------------------------------------------------------------------

/**
 * A JSON-safe Tool execution request. `toolExecutionId` is always
 * caller-owned — the Tool Runtime never generates ids. There is no
 * environment, provider, credential, or handler here; `input` is untrusted
 * JSON validated against the Tool's `inputSchema` before any handler runs.
 */
export const ToolExecutionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolExecutionId: identifierSchema,
    toolRef: ToolRefSchema,
    input: JsonValueSchema,
  })
  .strict()
  // A missing `input` key parses as `undefined` through the lazy union; reject it explicitly.
  .refine((request) => request.input !== undefined, { message: "input is required", path: ["input"] });
export type ToolExecutionRequest = z.infer<typeof ToolExecutionRequestSchema>;

// --- Result -------------------------------------------------------------------

/**
 * A JSON-safe successful Tool result: identity plus `output` that has already
 * passed canonical JSON-safety and the Tool's `outputSchema`. Never carries
 * the handler, a raw integration response, headers, SDK objects,
 * credentials, or provider metadata.
 */
export const ToolResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolExecutionId: identifierSchema,
    toolRef: ToolRefSchema,
    output: JsonValueSchema,
  })
  .strict()
  .refine((result) => result.output !== undefined, { message: "output is required", path: ["output"] });
export type ToolResult = z.infer<typeof ToolResultSchema>;

// --- Failures -----------------------------------------------------------------

export const TOOL_FAILURE_CODES = [
  "INVALID_TOOL_REQUEST",
  "TOOL_NOT_FOUND",
  "TOOL_PERMISSION_UNSUPPORTED",
  "TOOL_AUTHORIZATION_REQUIRED",
  "TOOL_AUTHORIZATION_DENIED",
  "TOOL_INPUT_SCHEMA_MISMATCH",
  "TOOL_EXECUTION_FAILED",
  "TOOL_OUTPUT_SCHEMA_MISMATCH",
  "INVALID_TOOL_RESULT",
] as const;
export const ToolFailureCodeSchema = z.enum(TOOL_FAILURE_CODES);
export type ToolFailureCode = z.infer<typeof ToolFailureCodeSchema>;

/**
 * A deterministic, JSON-safe Tool failure value. `message` and `issues` are
 * built by the Tool Runtime from safe metadata only. `handlerFailureCode` is
 * present only on `TOOL_EXECUTION_FAILED` when the handler *returned* a
 * bounded failure code; a thrown handler yields no code and nothing of the
 * thrown value. `unsupportedPermissionClasses` names what the V1 support
 * gate refused. `authorizationReasonCode` is present only on
 * `TOOL_AUTHORIZATION_DENIED`: the evaluator's safe reason code, for direct
 * callers — the Tool Node reports only the Tool failure code upward.
 */
export const ToolFailureSchema = z
  .object({
    code: ToolFailureCodeSchema,
    message: z.string(),
    toolExecutionId: identifierSchema.optional(),
    toolRef: ToolRefSchema.optional(),
    handlerFailureCode: HandlerFailureCodeSchema.optional(),
    /** Present only when the handler returned `retryable: true` with its bounded failure code. */
    handlerFailureRetryable: z.literal(true).optional(),
    unsupportedPermissionClasses: z.array(PermissionClassSchema).optional(),
    authorizationReasonCode: AuthorizationDenialReasonCodeSchema.optional(),
    issues: z.array(z.string()).optional(),
  })
  .strict();
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

/**
 * On success, `authorization` is the ALLOW decision that admitted this
 * execution: bounded evidence (principal id, required permission classes,
 * whether an Agent ceiling applied) for later tracing and evaluation. It is
 * not part of `ToolResult`, so it never enters workflow state.
 */
export type ToolExecutionResult = { ok: true; result: ToolResult; authorization: AuthorizationAllow } | { ok: false; failure: ToolFailure };
