import { z } from "zod";
import { CapabilityIdSchema, JsonObjectSchema, entityVersionSchema, schemaVersionSchema } from "./common.js";
import { PermissionClassesSchema } from "./governance.js";

/**
 * A Capability is a provider-neutral ability AAO needs from the Integration
 * Fabric — e.g. `crm.accounts.search`, `email.draft.create`,
 * `calendar.availability.read`. It describes the ability, not the vendor
 * implementing it:
 *
 *   Workflow -> Capability -> Adapter -> Vendor
 *
 * never `Workflow -> Vendor SDK`. No adapters, connectors, or
 * vendor-specific contracts (HubSpot, Salesforce, etc.) are implemented in
 * this sprint or belong in this file; those live behind future Integration
 * Fabric adapters.
 */
export const CapabilitySpecSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: CapabilityIdSchema,
    version: entityVersionSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema,
    permissionClasses: PermissionClassesSchema,
  })
  .strict();
export type CapabilitySpec = z.infer<typeof CapabilitySpecSchema>;
