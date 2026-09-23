import { z } from "zod";
import { CapabilityIdSchema, JsonObjectSchema, ToolIdSchema, entityVersionSchema, schemaVersionSchema } from "./common.js";
import { PermissionClassesSchema } from "./governance.js";

/**
 * A Tool is an executable interface AAO may authorize and invoke — distinct
 * from a Capability (see `capability.ts` and `docs/architecture/domain-contracts.md`
 * for the Tool-vs-Capability distinction). Not every tool binds to a company
 * capability: a tool such as `local.math.calculate` may have no
 * `capabilityRef` at all.
 *
 * `inputSchema`/`outputSchema` are represented as JSON-safe objects (a
 * JSON-Schema-shaped `JsonObject`, not a Zod schema instance and not a
 * dedicated JSON Schema type) so they remain serializable across process and
 * network boundaries. This sprint does not build the Tool Registry or tool
 * invocation — only the canonical description of a tool.
 */
export const ToolSpecSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: ToolIdSchema,
    version: entityVersionSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema,
    permissionClasses: PermissionClassesSchema,
    capabilityRef: CapabilityIdSchema.optional(),
  })
  .strict();
export type ToolSpec = z.infer<typeof ToolSpecSchema>;
