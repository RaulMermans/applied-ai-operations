import { z } from "zod";
import { CapabilityIdSchema, SkillIdSchema, ToolIdSchema, entityVersionSchema, schemaVersionSchema } from "./common.js";
import { PermissionClassesSchema } from "./governance.js";

/**
 * A Skill is a reusable operational/reasoning capability that a workflow or a
 * bounded agent can invoke. A Skill describes reusable *operational
 * behavior*; a Capability (see `capability.ts`) describes an
 * external/system *ability* available to AAO — the two must not be
 * conflated. No skill execution, skill folders, or skill runtime are
 * implemented in this sprint.
 */
export const SkillSpecSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: SkillIdSchema,
    version: entityVersionSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    requiredCapabilities: z.array(CapabilityIdSchema),
    requiredTools: z.array(ToolIdSchema),
    permissionClasses: PermissionClassesSchema,
  })
  .strict();
export type SkillSpec = z.infer<typeof SkillSpecSchema>;
