import { z } from "zod";
import { JsonObjectSchema, ModelPolicyIdSchema, entityVersionSchema, identifierSchema, schemaVersionSchema } from "./common.js";

/**
 * A provider-neutral model policy boundary. This describes *requirements and
 * policy* (e.g. "needs structured output", "needs vision") rather than a
 * hardcoded provider/model dependency. It must never import `ai`, an
 * OpenAI/Anthropic SDK, or LangChain/LangGraph model types — those stay
 * behind a future model-layer adapter. Model routing and provider/message
 * types are deferred; `constraints` is a deliberately opaque JSON-safe
 * boundary for semantics that are not yet stable enough to canonicalize.
 */
export const ModelPolicySpecSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: ModelPolicyIdSchema,
    version: entityVersionSchema,
    name: z.string().min(1),
    requiredCapabilities: z.array(identifierSchema).optional(),
    constraints: JsonObjectSchema.optional(),
  })
  .strict();
export type ModelPolicySpec = z.infer<typeof ModelPolicySpecSchema>;
