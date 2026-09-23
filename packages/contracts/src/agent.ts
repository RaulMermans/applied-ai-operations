import { z } from "zod";
import { AgentIdSchema, ModelPolicyIdSchema, SkillIdSchema, ToolIdSchema, entityVersionSchema, schemaVersionSchema } from "./common.js";
import { PermissionClassesSchema } from "./governance.js";

/**
 * An AAO Agent is a governed reasoning component invoked inside a Workflow —
 * not an autonomous top-level runtime. This sprint defines only the bounded
 * spec: no agent loop, prompts, model calls, memory, handoffs, or
 * multi-agent architecture. An Agent remains subordinate to Workflow.
 */
export const AgentSpecSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: AgentIdSchema,
    version: entityVersionSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    modelPolicyRef: ModelPolicyIdSchema.optional(),
    skillRefs: z.array(SkillIdSchema),
    toolRefs: z.array(ToolIdSchema),
    permissionClasses: PermissionClassesSchema,
  })
  .strict();
export type AgentSpec = z.infer<typeof AgentSpecSchema>;
