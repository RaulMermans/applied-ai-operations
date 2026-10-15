import { generateText, jsonSchema, NoObjectGeneratedError, NoOutputGeneratedError, Output, type FinishReason, type LanguageModel, type LanguageModelUsage } from "ai";
import { defineAdapterManifest, type AdapterManifest } from "@aao/adapters";
import { defineModelAdapter, type ModelAdapterDefinition } from "../adapter-definition.js";
import type { ModelAdapter, ModelAdapterContext, ModelAdapterRequest, ModelAdapterResult, ModelFinishReason, ModelUsage } from "../types.js";

/**
 * The first production `ModelAdapter`, backed by the Vercel AI SDK. This is
 * the *only* Model Runtime module that imports `ai`; AI SDK types never cross
 * this boundary — the adapter accepts and returns AAO-owned data.
 *
 * The actual model is injected: this adapter never reads environment
 * variables, credentials, or chooses a provider. Whoever constructs the
 * AI-SDK-compatible `LanguageModel` (a provider package, or `ai/test` in
 * tests) owns that concern.
 */
export interface VercelAiModelAdapterOptions {
  model: LanguageModel;
}

/**
 * What this adapter claims (adapter contract v1, ADR-025), verified by the
 * canonical conformance suite (`aao eval adapters`). Every capability is
 * implemented below. Cancellation forwards the invocation `AbortSignal` to
 * the SDK's own `abortSignal`, which reaches the provider call.
 */
export const VERCEL_AI_SDK_ADAPTER_MANIFEST: AdapterManifest = defineAdapterManifest({
  id: "aao.vercel-ai-sdk",
  version: "1.0.0",
  kind: "model",
  displayName: "Vercel AI SDK model adapter",
  capabilities: [
    { capability: "model.text_generation", support: "supported" },
    { capability: "model.structured_output", support: "supported" },
    { capability: "model.usage", support: "supported" },
    { capability: "model.cancellation", support: "supported" },
    { capability: "model.tool_call_response", support: "supported" },
  ],
  limitations: [
    { code: "model.single_invocation", description: "The SDK's own retries are disabled. AAO invokes exactly once per request, and Runtime reliability policy owns retries." },
    { code: "model.provider_injected", description: "The host injects the language model. The adapter never reads credentials or chooses a provider." },
  ],
});

export function createVercelAiModelAdapter(options: VercelAiModelAdapterOptions): ModelAdapter {
  const { model } = options;
  return {
    async invoke(request: ModelAdapterRequest, context: ModelAdapterContext): Promise<ModelAdapterResult> {
      try {
        const common = {
          model,
          messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
          allowSystemInMessages: true,
          // The AI SDK retries by default; AAO V1 invokes exactly once (ADR-011).
          maxRetries: 0,
          // The Runtime attempt's cancellation lineage, handed to the SDK's own abort mechanism (ADR-025).
          abortSignal: context.signal,
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        };

        if (request.output.kind === "text") {
          const result = await generateText(common);
          return normalize(result.finishReason, result.toolCalls.length, result.usage, () => result.text);
        }

        const result = await generateText({
          ...common,
          // The SDK sends the JSON Schema to the provider and parses JSON; AAO
          // re-validates the parsed object against the same schema afterwards.
          output: Output.object({
            schema: jsonSchema(request.output.schema),
            ...(request.output.name !== undefined ? { name: request.output.name } : {}),
          }),
        });
        return normalize(result.finishReason, result.toolCalls.length, result.usage, () => result.output);
      } catch (error) {
        if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
          return { status: "failed", reason: "unparseable_output" };
        }
        // Never propagate or inspect the provider error beyond its class.
        return { status: "failed", reason: "provider_error" };
      }
    },
  };
}

/** The registrable definition: `VERCEL_AI_SDK_ADAPTER_MANIFEST` plus this adapter, for `createAAO({ modelAdapters })`. */
export function defineVercelAiModelAdapter(options: VercelAiModelAdapterOptions): ModelAdapterDefinition {
  return defineModelAdapter({ manifest: VERCEL_AI_SDK_ADAPTER_MANIFEST, adapter: createVercelAiModelAdapter(options) });
}

function normalize(finishReason: FinishReason, toolCallCount: number, usage: LanguageModelUsage, readOutput: () => unknown): ModelAdapterResult {
  // Tool calling is not part of Model Runtime V1: fail closed if it appears.
  if (toolCallCount > 0 || finishReason === "tool-calls") return { status: "failed", reason: "unsupported_response" };
  if (finishReason === "error") return { status: "failed", reason: "provider_error" };

  const normalizedUsage = normalizeUsage(usage);
  return {
    status: "succeeded",
    output: readOutput(),
    finishReason: FINISH_REASONS[finishReason],
    ...(normalizedUsage !== undefined ? { usage: normalizedUsage } : {}),
  };
}

const FINISH_REASONS: Record<Exclude<FinishReason, "tool-calls" | "error">, ModelFinishReason> = {
  stop: "stop",
  length: "length",
  "content-filter": "content_filter",
  other: "other",
};

function normalizeUsage(usage: LanguageModelUsage | undefined): ModelUsage | undefined {
  if (usage === undefined) return undefined;
  const normalized: ModelUsage = {};
  const count = (value: number | undefined) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const totalTokens = count(usage.totalTokens);
  if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
  if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
  if (totalTokens !== undefined) normalized.totalTokens = totalTokens;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
