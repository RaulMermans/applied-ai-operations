import type { ModelExecutor, ModelRequest, ModelResult } from "@aao/substrate-contracts";
import { z } from "zod";

export class ModelExecutionError extends Error {}

export type GenerateStructuredObject = (request: {
  prompt: string;
  schemaName: string;
}) => Promise<unknown>;

/**
 * AAO-facing adapter seam for Vercel AI SDK's generateObject-style calls.
 * It is injectable so this spike can run without model credentials.
 */
export class VercelAiModelAdapter implements ModelExecutor {
  constructor(
    private readonly generateStructuredObject: GenerateStructuredObject,
    private readonly resultSchema: z.ZodType,
  ) {}

  async execute(request: ModelRequest): Promise<ModelResult> {
    try {
      const raw = await this.generateStructuredObject(request);
      const parsed = this.resultSchema.safeParse(raw);
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
