import { generateText, jsonSchema, NoObjectGeneratedError, NoOutputGeneratedError, Output, type FinishReason, type LanguageModel, type LanguageModelUsage } from "ai";
import type { ModelAdapter, ModelAdapterRequest, ModelAdapterResult, ModelFinishReason, ModelUsage } from "../types.js";

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

export function createVercelAiModelAdapter(options: VercelAiModelAdapterOptions): ModelAdapter {
  const { model } = options;
  return {
    async invoke(request: ModelAdapterRequest): Promise<ModelAdapterResult> {
      try {
        const common = {
          model,
          messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
          allowSystemInMessages: true,
          // The AI SDK retries by default; AAO V1 invokes exactly once (ADR-011).
          maxRetries: 0,
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
