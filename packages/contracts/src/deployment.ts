import { z } from "zod";
import { CompanyIdSchema, PolicyIdSchema, WorkflowIdSchema, identifierSchema, schemaVersionSchema } from "./common.js";
import { CapabilityPackRefSchema } from "./capability-pack.js";

/**
 * The smallest stable company/deployment configuration boundary. Its purpose
 * is to protect the portability invariant: normal company onboarding must
 * not fork AAO Core. Company-specific reality is represented here by
 * references and configuration, never by modifying Core.
 *
 * This contract carries no OAuth tokens, credentials, secrets, SaaS-specific
 * fields, or real vendor (HubSpot/Salesforce/etc.) structures — those belong
 * to a future Integration Fabric / deployment implementation. Capability
 * bindings and field mappings are not modeled yet; `capabilityBindingRefs`
 * and `fieldMappingRefs` are opaque identifier references into whatever
 * later owns those concepts, deliberately left unspecified here.
 */
export const CompanyConfigSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    companyId: CompanyIdSchema,
    displayName: z.string().min(1),
    workflowRefs: z.array(WorkflowIdSchema),
    policyRefs: z.array(PolicyIdSchema),
    capabilityPackRefs: z.array(CapabilityPackRefSchema),
    capabilityBindingRefs: z.array(identifierSchema),
    fieldMappingRefs: z.array(identifierSchema),
  })
  .strict();
export type CompanyConfig = z.infer<typeof CompanyConfigSchema>;
