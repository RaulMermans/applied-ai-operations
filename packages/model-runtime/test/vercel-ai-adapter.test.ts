import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { createVercelAiModelAdapter } from "../src/adapters/vercel-ai.js";
import { executeModelRequest } from "../src/executor.js";
import { isJsonSafe } from "@aao/runtime";
import { CATEGORY_SCHEMA, TEXT_AND_STRUCTURED, buildRegistries, buildStructuredRequest, buildTextRequest } from "./fixtures.js";

type FinishUnified = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

function response(text: string, finish: FinishUnified = "stop") {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: finish, raw: finish },
    usage: {
      inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 4, text: 4, reasoning: 0 },
    },
    warnings: [],
  };
}

/** A context whose signal never aborts: the port always carries one (ADR-025). */
const idle = { signal: new AbortController().signal };

const SECRET = "sk-live-SECRET https://api.example.com/v1?key=abc";

describe("createVercelAiModelAdapter (ai/test deterministic model, no network)", () => {
  it("text: generateText success, normalized finish reason and usage", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response("Hello there.") });
    const adapter = createVercelAiModelAdapter({ model });
    const result = await adapter.invoke({ messages: buildTextRequest().messages, output: { kind: "text" }, maxOutputTokens: 32 }, idle);
    expect(result).toEqual({ status: "succeeded", output: "Hello there.", finishReason: "stop", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
    expect(isJsonSafe(result)).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0]!;
    expect(call.maxOutputTokens).toBe(32);
    expect(call.prompt.map((message) => message.role)).toEqual(["system", "user"]);
    expect(call.tools ?? []).toEqual([]);
  });

  it("structured: Output.object with the request's JSON Schema is sent to the model", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response(JSON.stringify({ category: "research" })) });
    const request = buildStructuredRequest();
    const result = await createVercelAiModelAdapter({ model }).invoke({ messages: request.messages, output: request.output }, idle);
    expect(result).toMatchObject({ status: "succeeded", output: { category: "research" }, finishReason: "stop" });
    expect(model.doGenerateCalls[0]?.responseFormat).toMatchObject({ type: "json", name: "classification", schema: CATEGORY_SCHEMA });
  });

  it("maps content-filter and length finish reasons", async () => {
    for (const [finish, expected] of [["content-filter", "content_filter"], ["length", "length"], ["other", "other"]] as const) {
      const model = new MockLanguageModelV3({ doGenerate: response("x", finish) });
      const result = await createVercelAiModelAdapter({ model }).invoke({ messages: buildTextRequest().messages, output: { kind: "text" } }, idle);
      expect(result).toMatchObject({ status: "succeeded", finishReason: expected });
    }
  });

  it("provider throw → provider_error, invoked exactly once (maxRetries: 0), nothing raw exposed", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: () => {
        throw Object.assign(new Error(SECRET), { statusCode: 503, isRetryable: true });
      },
    });
    const result = await createVercelAiModelAdapter({ model }).invoke({ messages: buildTextRequest().messages, output: { kind: "text" } }, idle);
    expect(result).toEqual({ status: "failed", reason: "provider_error" });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("error finish reason → provider_error", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response("x", "error") });
    expect(await createVercelAiModelAdapter({ model }).invoke({ messages: buildTextRequest().messages, output: { kind: "text" } }, idle)).toEqual({ status: "failed", reason: "provider_error" });
  });

  it("tool calls fail closed as unsupported_response", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "search", input: "{}" }],
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      },
    });
    expect(await createVercelAiModelAdapter({ model }).invoke({ messages: buildTextRequest().messages, output: { kind: "text" } }, idle)).toEqual({ status: "failed", reason: "unsupported_response" });
  });

  it("unparseable structured output → unparseable_output", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response("definitely not json") });
    const request = buildStructuredRequest();
    expect(await createVercelAiModelAdapter({ model }).invoke({ messages: request.messages, output: request.output }, idle)).toEqual({ status: "failed", reason: "unparseable_output" });
  });

  it("schema-violating JSON passes the SDK but is rejected by AAO's own validation", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response(JSON.stringify({ category: 42 })) });
    const registries = buildRegistries([{ id: "local.structured", priority: 1, capabilities: TEXT_AND_STRUCTURED, adapter: createVercelAiModelAdapter({ model }) }]);
    const result = await executeModelRequest({ request: buildStructuredRequest(), modelPolicyRef: "policy.default", ...registries });
    expect(result).toMatchObject({ ok: false, failure: { code: "MODEL_OUTPUT_SCHEMA_MISMATCH", modelBindingId: "local.structured" } });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("end-to-end through executeModelRequest returns a plain JSON ModelResult (no SDK objects)", async () => {
    const model = new MockLanguageModelV3({ doGenerate: response(JSON.stringify({ category: "research" })) });
    const registries = buildRegistries([{ id: "local.structured", priority: 1, capabilities: TEXT_AND_STRUCTURED, adapter: createVercelAiModelAdapter({ model }) }]);
    const result = await executeModelRequest({ request: buildStructuredRequest(), modelPolicyRef: "policy.default", ...registries });
    expect(result).toEqual({
      ok: true,
      result: {
        schemaVersion: 1,
        invocationId: "inv.structured.1",
        modelBindingId: "local.structured",
        outputKind: "structured",
        output: { category: "research" },
        finishReason: "stop",
        usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
      },
    });
    expect(isJsonSafe(result)).toBe(true);
  });
});
