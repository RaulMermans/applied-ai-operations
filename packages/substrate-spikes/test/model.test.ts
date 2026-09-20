import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelExecutionError, VercelAiModelAdapter } from "../src/model.js";

describe("AAO model adapter", () => {
  it("conforms to the AAO interface and validates structured results", async () => {
    const model = new VercelAiModelAdapter(async () => ({ intent: "route" }), z.object({ intent: z.string() }));
    await expect(model.execute({ prompt: "classify", schemaName: "intent" }))
      .resolves.toEqual({ data: { intent: "route" }, provider: "vercel-ai-sdk" });
  });

  it("maps provider failures into a canonical AAO error", async () => {
    const model = new VercelAiModelAdapter(async () => { throw new Error("offline"); }, z.object({ intent: z.string() }));
    await expect(model.execute({ prompt: "classify", schemaName: "intent" })).rejects.toBeInstanceOf(ModelExecutionError);
  });
});
