import { z } from "zod";
import { JsonObjectSchema, identifierSchema } from "@aao/contracts";

// --- Model capabilities -------------------------------------------------------

/**
 * Model capabilities are properties of a registered *inference endpoint*
 * ("can generate text", "can honour a structured-output schema"). They are
 * deliberately not the Integration Fabric's `CapabilitySpec` (a business or
 * system ability such as `crm.accounts.search`) — different registry,
 * different runtime responsibility. Only capabilities Model Runtime V1
 * actually uses are listed; tool calling, vision, etc. are added only when a
 * sprint implements them.
 */
export const MODEL_CAPABILITIES = ["model.text_generation", "model.structured_output"] as const;
export const ModelCapabilityIdSchema = z.enum(MODEL_CAPABILITIES);
export type ModelCapabilityId = z.infer<typeof ModelCapabilityIdSchema>;

// --- Messages -----------------------------------------------------------------

/** A provider-neutral message. V1 content is a plain, non-empty string: no tool-call, image, or multipart provider objects. */
export const ModelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1),
  })
  .strict();
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

// --- Output contract ----------------------------------------------------------

/**
 * `schema` is a standard JSON Schema document (not a custom schema language)
 * describing a top-level object. It must be JSON-safe so the request stays
 * serializable; whether it is a *valid* JSON Schema is checked separately
 * by `validateModelRequest` (see `json-schema.ts`).
 */
export const ModelOutputSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text") }).strict(),
  z
    .object({
      kind: z.literal("structured"),
      schema: JsonObjectSchema,
      name: identifierSchema.optional(),
    })
    .strict(),
]);
export type ModelOutputSpec = z.infer<typeof ModelOutputSpecSchema>;
export type ModelOutputKind = ModelOutputSpec["kind"];

// --- Request ------------------------------------------------------------------

/** Generous upper bound that still rejects obviously corrupt values; not a provider limit. */
export const MAX_OUTPUT_TOKENS_CEILING = 1_000_000;

/**
 * A JSON-safe, provider-neutral model request. It carries no provider id,
 * credential, SDK object, function, abort signal, or logger. `invocationId`
 * is always caller-owned; Model Runtime never generates ids.
 */
export const ModelRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    invocationId: identifierSchema,
    messages: z
      .array(ModelMessageSchema)
      .min(1)
      .refine((messages) => messages.some((message) => message.role === "user"), "messages must include at least one user message"),
    output: ModelOutputSpecSchema,
    requiredCapabilities: z.array(ModelCapabilityIdSchema).optional(),
    maxOutputTokens: z.number().int().positive().max(MAX_OUTPUT_TOKENS_CEILING).optional(),
  })
  .strict();
export type ModelRequest = z.infer<typeof ModelRequestSchema>;

// --- Result -------------------------------------------------------------------

/** Only finish reasons with stable cross-provider meaning. Tool-call and error finishes never become a successful result. */
export const ModelFinishReasonSchema = z.enum(["stop", "length", "content_filter", "other"]);
export type ModelFinishReason = z.infer<typeof ModelFinishReasonSchema>;

const tokenCountSchema = z.number().int().nonnegative();

/** Optional normalized token usage; each field is present only when the adapter reported it reliably. No cost data. */
export const ModelUsageSchema = z
  .object({
    inputTokens: tokenCountSchema.optional(),
    outputTokens: tokenCountSchema.optional(),
    totalTokens: tokenCountSchema.optional(),
  })
  .strict();
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

const resultBase = {
  schemaVersion: z.literal(1),
  invocationId: identifierSchema,
  modelBindingId: identifierSchema,
  finishReason: ModelFinishReasonSchema.optional(),
  usage: ModelUsageSchema.optional(),
};

/** A validated, JSON-safe model result. No raw provider response, headers, request ids, or SDK metadata. */
export const ModelResultSchema = z.discriminatedUnion("outputKind", [
  z.object({ ...resultBase, outputKind: z.literal("text"), output: z.string() }).strict(),
  z.object({ ...resultBase, outputKind: z.literal("structured"), output: JsonObjectSchema }).strict(),
]);
export type ModelResult = z.infer<typeof ModelResultSchema>;

// --- Failures -----------------------------------------------------------------

export const MODEL_FAILURE_CODES = [
  "INVALID_MODEL_REQUEST",
  "MODEL_POLICY_NOT_FOUND",
  "UNSUPPORTED_MODEL_POLICY_CONSTRAINTS",
  "MODEL_ROUTE_NOT_FOUND",
  "MODEL_INVOCATION_FAILED",
  "INVALID_MODEL_RESULT",
  "MODEL_OUTPUT_SCHEMA_MISMATCH",
] as const;
export const ModelFailureCodeSchema = z.enum(MODEL_FAILURE_CODES);
export type ModelFailureCode = z.infer<typeof ModelFailureCodeSchema>;

/**
 * A deterministic, JSON-safe failure value. `message` and `details` are
 * always built by Model Runtime itself from safe metadata — never from a
 * provider's `Error.message`, stack, thrown object, URL, or headers.
 */
export const ModelFailureSchema = z
  .object({
    code: ModelFailureCodeSchema,
    message: z.string(),
    invocationId: identifierSchema.optional(),
    modelBindingId: identifierSchema.optional(),
    details: JsonObjectSchema.optional(),
  })
  .strict();
export type ModelFailure = z.infer<typeof ModelFailureSchema>;

export type ModelExecutionResult = { ok: true; result: ModelResult } | { ok: false; failure: ModelFailure };

// --- Adapter contract ---------------------------------------------------------

/** What an adapter receives: AAO-owned data only. */
export interface ModelAdapterRequest {
  messages: ModelMessage[];
  output: ModelOutputSpec;
  maxOutputTokens?: number;
}

/**
 * Safe, enumerable adapter failure reasons:
 * - `provider_error` — the provider/framework call failed.
 * - `unsupported_response` — the provider responded with something V1 does not support (e.g. tool calls).
 * - `unparseable_output` — the response could not be parsed into the requested output kind.
 */
export type ModelAdapterFailureReason = "provider_error" | "unsupported_response" | "unparseable_output";

/**
 * What an adapter returns. `output` is `unknown` on purpose: adapter output is
 * untrusted until Model Runtime validates it (JSON-safety, output kind,
 * structured schema). Adapters may also throw; Model Runtime treats a throw
 * exactly like `provider_error` and never exposes the thrown value.
 */
export type ModelAdapterResult =
  | { status: "succeeded"; output: unknown; finishReason?: ModelFinishReason; usage?: ModelUsage }
  | { status: "failed"; reason: ModelAdapterFailureReason };

/**
 * The trusted execution context of one invocation (adapter contract v1,
 * ADR-025). `signal` is the invocation's cancellation lineage: the same
 * signal the Runtime aborts when it abandons the Node attempt (attempt
 * timeout), passed through the Model Node or Agent Runtime and Model
 * Runtime unchanged. It is always present. An adapter declaring
 * `model.cancellation` must forward it to the provider boundary, and
 * conformance verifies that. One that cannot must declare the capability
 * `unsupported`. Either way a late result is ignored by the Runtime and
 * cannot commit.
 */
export interface ModelAdapterContext {
  readonly signal: AbortSignal;
}

/**
 * The canonical, provider-neutral model adapter port (the public `model`
 * adapter kind since Sprint 20; ADR-011, ADR-025). This interface is its
 * only definition. No AI SDK, provider SDK, or raw HTTP type appears here.
 * Pair it with an `AdapterManifest` through `defineModelAdapter` to
 * register it with `@aao/framework`. A raw `ModelAdapter` in a low-level
 * `ModelRegistry` claims no capability at all.
 */
export interface ModelAdapter {
  invoke(request: ModelAdapterRequest, context: ModelAdapterContext): Promise<ModelAdapterResult>;
}
