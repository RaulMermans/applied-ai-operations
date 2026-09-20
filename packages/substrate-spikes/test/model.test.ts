import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { ModelExecutionError, VercelAiModelAdapter } from "../src/model.js";

function structuredResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

describe("AAO model adapter", () => {
  it("executes the installed AI SDK structured-output path through a deterministic provider", async () => {
    const provider = new MockLanguageModelV3({ doGenerate: structuredResponse({ intent: "route" }) });
    const model = new VercelAiModelAdapter(provider, z.object({ intent: z.string() }));
    await expect(model.execute({ prompt: "classify", schemaName: "intent" }))
      .resolves.toEqual({ data: { intent: "route" }, provider: "vercel-ai-sdk" });
    expect(provider.doGenerateCalls).toHaveLength(1);
    expect(provider.doGenerateCalls[0]?.responseFormat).toMatchObject({ type: "json", name: "intent" });
  });

  it("maps invalid structured output from the AI SDK path into a canonical AAO error", async () => {
    const provider = new MockLanguageModelV3({ doGenerate: structuredResponse({ intent: 42 }) });
    const model = new VercelAiModelAdapter(provider, z.object({ intent: z.string() }));
    await expect(model.execute({ prompt: "classify", schemaName: "intent" })).rejects.toBeInstanceOf(ModelExecutionError);
    expect(provider.doGenerateCalls).toHaveLength(1);
  });

  it("maps provider failures into a canonical AAO error", async () => {
    const provider = new MockLanguageModelV3({ doGenerate: () => { throw new Error("offline"); } });
    const model = new VercelAiModelAdapter(provider, z.object({ intent: z.string() }));
    await expect(model.execute({ prompt: "classify", schemaName: "intent" })).rejects.toBeInstanceOf(ModelExecutionError);
    expect(provider.doGenerateCalls).toHaveLength(1);
  });
});
