import { z } from "zod";
import { CapabilityPackIdSchema, entityVersionSchema } from "./common.js";

/**
 * Capability Packs are part of the long-term architecture (a pack
 * conceptually groups workflows, skills, required capabilities, policies,
 * eval suites, and approval rules — e.g. a "Sales Operations Pack"). This
 * sprint deliberately implements only a declarative reference boundary, not a
 * pack runtime or a full manifest: a full `CapabilityPackManifest` would
 * require speculative runtime semantics (how packs are loaded, merged, and
 * versioned against a deployment) that no later sprint has evidenced yet.
 * That manifest is intentionally deferred.
 */
export const CapabilityPackRefSchema = z
  .object({
    capabilityPackId: CapabilityPackIdSchema,
    version: entityVersionSchema.optional(),
  })
  .strict();
export type CapabilityPackRef = z.infer<typeof CapabilityPackRefSchema>;
