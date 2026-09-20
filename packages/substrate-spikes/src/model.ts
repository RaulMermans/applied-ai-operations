import type { ModelExecutor, ModelRequest, ModelResult } from "@aao/substrate-contracts";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

export class ModelExecutionError extends Error {}

/**
 * AAO-facing adapter over the Vercel AI SDK structured-output API.
 * AI SDK model types remain inside this substrate adapter.
 */
export class VercelAiModelAdapter implements ModelExecutor {
  constructor(
    private readonly model: LanguageModel,
    private readonly resultSchema: z.ZodType,
  ) {}

  async execute(request: ModelRequest): Promise<ModelResult> {
    try {
      const result = await generateText({
        model: this.model,
        prompt: request.prompt,
        output: Output.object({ schema: this.resultSchema, name: request.schemaName }),
      });
      const parsed = this.resultSchema.safeParse(result.output);
      if (!parsed.success) {
        throw new ModelExecutionError(`Model returned invalid structured output: ${parsed.error.message}`);
      }
      return { data: parsed.data, provider: "vercel-ai-sdk" };
    } catch (error) {
      if (error instanceof ModelExecutionError) throw error;
      throw new ModelExecutionError(`Model execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
