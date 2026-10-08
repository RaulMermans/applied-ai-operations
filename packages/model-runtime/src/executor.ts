import { isJsonSafe } from "@aao/runtime";
import { compileOutputSchema } from "./json-schema.js";
import { hasUnsupportedConstraints, type ModelPolicyRegistry } from "./policy-registry.js";
import type { ModelBinding, ModelBindingIdentity, ModelRegistry } from "./registry.js";
import { validateModelRequest } from "./request.js";
import { deriveRequiredCapabilities, selectModelBinding } from "./router.js";
import {
  ModelFinishReasonSchema,
  ModelResultSchema,
  ModelUsageSchema,
  type ModelAdapterResult,
  type ModelExecutionResult,
  type ModelFailure,
  type ModelRequest,
  type ModelResult,
} from "./types.js";

export interface ExecuteModelRequestParams {
  /** Untrusted: validated before anything else happens. */
  request: unknown;
  modelPolicyRef: string;
  policies: ModelPolicyRegistry;
  models: ModelRegistry;
  /** Optional observer (ADR-020), told about each actual adapter invocation. Never consulted; a throwing observer changes nothing. */
  observer?: ModelInvocationObserver;
}

/**
 * Safe-metadata notifications around the single adapter invocation. Called
 * only when an adapter is actually invoked (a route or policy failure before
 * invocation is not a model call). No messages, output, provider error,
 * URL, or header ever reaches an observer.
 */
export interface ModelInvocationObserver {
  started?(info: { invocationId: string; modelPolicyRef: string; modelBindingId: string; outputKind: "text" | "structured"; requiredCapabilityIds: string[]; modelIdentity?: ModelBindingIdentity }): void | Promise<void>;
  completed?(info: { invocationId: string; modelBindingId: string; outputKind: "text" | "structured"; finishReason?: ModelResult["finishReason"]; usage?: ModelResult["usage"]; modelIdentity?: ModelBindingIdentity }): void | Promise<void>;
  failed?(info: { invocationId: string; modelBindingId: string; code: ModelFailure["code"]; adapterReason?: "provider_error" | "unsupported_response" | "unparseable_output" }): void | Promise<void>;
}

async function notify<K extends keyof ModelInvocationObserver>(observer: ModelInvocationObserver | undefined, kind: K, info: Parameters<NonNullable<ModelInvocationObserver[K]>>[0]): Promise<void> {
  const callback = observer?.[kind] as ((value: typeof info) => void | Promise<void>) | undefined;
  if (typeof callback !== "function") return;
  try { await callback.call(observer, JSON.parse(JSON.stringify(info)) as typeof info); } catch { /* observation never changes execution */ }
}

/**
 * The single canonical model execution path:
 *
 *   ModelRequest → ModelPolicy → Capability Router → Adapter → validated ModelResult
 *
 * Expected failures are returned as `ModelFailure` values, never thrown.
 * The selected adapter is invoked **exactly once**: no retry, and no
 * fallback to another compatible binding if it fails (see ADR-011).
 */
export async function executeModelRequest(params: ExecuteModelRequestParams): Promise<ModelExecutionResult> {
  const validated = validateModelRequest(params.request);
  if (!validated.ok) return { ok: false, failure: validated.failure };
  const request = validated.request;
  const invocationId = request.invocationId;

  const policy = params.policies.get(params.modelPolicyRef);
  if (policy === undefined) {
    return fail({ code: "MODEL_POLICY_NOT_FOUND", message: `Model policy "${params.modelPolicyRef}" is not registered.`, invocationId });
  }
  if (hasUnsupportedConstraints(policy)) {
    return fail({
      code: "UNSUPPORTED_MODEL_POLICY_CONSTRAINTS",
      message: `Model policy "${policy.id}" declares constraints; Model Runtime V1 supports none.`,
      invocationId,
    });
  }

  const required = deriveRequiredCapabilities(request, policy);
  const binding = selectModelBinding(required, params.models);
  if (binding === undefined) {
    return fail({
      code: "MODEL_ROUTE_NOT_FOUND",
      message: "No registered model binding satisfies every required capability.",
      invocationId,
      details: { requiredCapabilities: required },
    });
  }

  const identity = binding.identity ? { modelIdentity: { ...binding.identity } } : {};
  if (params.observer) await notify(params.observer, "started", { invocationId, modelPolicyRef: policy.id, modelBindingId: binding.id, outputKind: request.output.kind, requiredCapabilityIds: [...required], ...identity });
  let adapterResult: unknown;
  try {
    adapterResult = await binding.adapter.invoke({
      messages: request.messages.map((message) => ({ ...message })),
      output: JSON.parse(JSON.stringify(request.output)) as ModelRequest["output"],
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
    });
  } catch {
    // Never expose the thrown value (message, stack, URL, headers, ...).
    adapterResult = { status: "failed", reason: "provider_error" };
  }

  const outcome = normalizeAdapterResult(request, binding, adapterResult);
  if (outcome.ok) {
    const { invocationId: id, modelBindingId, outputKind, finishReason, usage } = outcome.result;
    if (params.observer) await notify(params.observer, "completed", { invocationId: id, modelBindingId, outputKind, ...(finishReason ? { finishReason } : {}), ...(usage ? { usage } : {}), ...identity });
  } else {
    const reason = outcome.failure.details?.reason;
    if (params.observer) await notify(params.observer, "failed", { invocationId, modelBindingId: binding.id, code: outcome.failure.code, ...(reason === "provider_error" || reason === "unsupported_response" || reason === "unparseable_output" ? { adapterReason: reason } : {}) });
  }
  return outcome;
}

function normalizeAdapterResult(request: ModelRequest, binding: ModelBinding, raw: unknown): ModelExecutionResult {
  const invocationId = request.invocationId;
  const modelBindingId = binding.id;
  const invalid = (message: string): ModelExecutionResult => fail({ code: "INVALID_MODEL_RESULT", message, invocationId, modelBindingId });

  if (!isAdapterResultShape(raw)) return invalid("Model adapter returned a malformed result.");

  if (raw.status === "failed") {
    if (raw.reason === "provider_error") return invocationFailed(invocationId, binding, "provider_error");
    return fail({ code: "INVALID_MODEL_RESULT", message: "Model adapter reported an unsupported or unparseable response.", invocationId, modelBindingId, details: { reason: raw.reason } });
  }

  if (!isJsonSafe(raw.output)) return invalid("Model output is not JSON-safe.");

  const finishReason = raw.finishReason === undefined ? undefined : ModelFinishReasonSchema.safeParse(raw.finishReason);
  if (finishReason !== undefined && !finishReason.success) return invalid("Model adapter returned an unsupported finish reason.");
  const usage = raw.usage === undefined ? undefined : ModelUsageSchema.safeParse(raw.usage);
  if (usage !== undefined && !(usage.success && isJsonSafe(raw.usage))) return invalid("Model adapter returned malformed usage.");

  if (request.output.kind === "text") {
    if (typeof raw.output !== "string") return invalid("Text output must be a string.");
  } else {
    if (raw.output === null || typeof raw.output !== "object" || Array.isArray(raw.output)) return invalid("Structured output must be a JSON object.");
    const compiled = compileOutputSchema(request.output.schema);
    // Already proven compilable by validateModelRequest.
    if (!compiled.ok) return invalid("Structured output schema could not be compiled.");
    if (!compiled.validate(raw.output)) {
      return fail({ code: "MODEL_OUTPUT_SCHEMA_MISMATCH", message: "Structured output does not match the requested schema.", invocationId, modelBindingId });
    }
  }

  const candidate = {
    schemaVersion: 1,
    invocationId,
    modelBindingId,
    outputKind: request.output.kind,
    output: JSON.parse(JSON.stringify(raw.output)) as unknown,
    ...(finishReason?.success ? { finishReason: finishReason.data } : {}),
    ...(usage?.success && Object.keys(usage.data).length > 0 ? { usage: usage.data } : {}),
  };
  const result = ModelResultSchema.safeParse(candidate);
  if (!result.success || !isJsonSafe(result.data)) return invalid("Normalized model result failed ModelResultSchema.");
  return { ok: true, result: result.data as ModelResult };
}

function isAdapterResultShape(value: unknown): value is ModelAdapterResult {
  if (value === null || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  if (status === "succeeded") return "output" in value;
  if (status === "failed") {
    const reason = (value as { reason?: unknown }).reason;
    return reason === "provider_error" || reason === "unsupported_response" || reason === "unparseable_output";
  }
  return false;
}

function invocationFailed(invocationId: string, binding: ModelBinding, reason: "provider_error"): ModelExecutionResult {
  return fail({ code: "MODEL_INVOCATION_FAILED", message: `Model binding "${binding.id}" invocation failed.`, invocationId, modelBindingId: binding.id, details: { reason } });
}

function fail(failure: ModelFailure): ModelExecutionResult {
  return { ok: false, failure };
}
