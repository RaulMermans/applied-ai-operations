import { z } from "zod";
import { PolicyIdSchema } from "./common.js";

/**
 * The frozen AAO permission classes (see `docs/security/permission-model.md`).
 * These values are canonical and must not be renamed or redefined elsewhere.
 */
export const PermissionClassSchema = z.enum([
  "read_only",
  "write_draft",
  "external_side_effect",
  "destructive",
  "sensitive_data",
]);
export type PermissionClass = z.infer<typeof PermissionClassSchema>;

/**
 * A collection of permission classes. `sensitive_data` may coexist with
 * another class (e.g. `["external_side_effect", "sensitive_data"]`), so this is
 * always a set, never a single mutually-exclusive value. Duplicate entries are
 * rejected.
 */
export const PermissionClassesSchema = z
  .array(PermissionClassSchema)
  .min(1)
  .refine((classes) => new Set(classes).size === classes.length, {
    message: "permission classes must not contain duplicate entries",
  });
export type PermissionClasses = z.infer<typeof PermissionClassesSchema>;

/**
 * The stable output shape a future governance/policy engine produces.
 * Evaluation of policy itself is deferred; only the decision's shape is
 * canonical here.
 */
export const PolicyDecisionValueSchema = z.enum(["ALLOW", "DENY", "REQUIRE_APPROVAL"]);
export type PolicyDecisionValue = z.infer<typeof PolicyDecisionValueSchema>;

export const PolicyDecisionSchema = z
  .object({
    decision: PolicyDecisionValueSchema,
    policyRefs: z.array(PolicyIdSchema).optional(),
    reasonCodes: z.array(z.string().min(1).max(256)).optional(),
  })
  .strict();
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
