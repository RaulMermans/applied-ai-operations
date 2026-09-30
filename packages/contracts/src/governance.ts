import { z } from "zod";
import { PolicyIdSchema, entityVersionSchema, identifierSchema } from "./common.js";

/** Host-attested identity. An agent acts through a principal and its separate ceiling. */
export const PRINCIPAL_TYPES = ["user", "service", "system"] as const;
export const PrincipalTypeSchema = z.enum(PRINCIPAL_TYPES);
export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;
export const PrincipalSchema = z.object({ id: identifierSchema, type: PrincipalTypeSchema }).strict();
export type Principal = z.infer<typeof PrincipalSchema>;

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

export const RoleSchema = z.object({
  id: identifierSchema,
  version: entityVersionSchema,
  description: z.string().optional(),
  permissionClasses: z.array(PermissionClassSchema).min(1),
}).strict();
export type Role = z.infer<typeof RoleSchema>;

export const RoleBindingSchema = z.object({
  id: identifierSchema,
  actorId: identifierSchema,
  roleId: identifierSchema,
  status: z.enum(["active", "inactive"]),
}).strict();
export type RoleBinding = z.infer<typeof RoleBindingSchema>;

export const GovernancePolicyRuleSchema = z.object({
  id: identifierSchema,
  effect: z.literal("DENY"),
  permissionClasses: z.array(PermissionClassSchema).min(1),
  actorTypes: z.array(PrincipalTypeSchema).min(1).optional(),
  roleIds: z.array(identifierSchema).min(1).optional(),
}).strict();
export type GovernancePolicyRule = z.infer<typeof GovernancePolicyRuleSchema>;

export const GovernancePolicySchema = z.object({
  id: PolicyIdSchema,
  rules: z.array(GovernancePolicyRuleSchema).min(1),
}).strict();
export type GovernancePolicy = z.infer<typeof GovernancePolicySchema>;

export const GovernanceConfigurationSchema = z.object({
  actors: z.array(PrincipalSchema),
  roles: z.array(RoleSchema),
  bindings: z.array(RoleBindingSchema),
  policies: z.array(GovernancePolicySchema),
}).strict();
export type GovernanceConfiguration = z.infer<typeof GovernanceConfigurationSchema>;

export const GovernanceReasonCodeSchema = z.enum([
  "GOVERNANCE_ALLOWED",
  "GOVERNANCE_DEFAULT_DENY",
  "GOVERNANCE_POLICY_DENY",
  "GOVERNANCE_INVALID_CONTEXT",
]);
export type GovernanceReasonCode = z.infer<typeof GovernanceReasonCodeSchema>;

export const ResolvedAuthoritySchema = z.object({
  actor: PrincipalSchema,
  roleIds: z.array(identifierSchema),
  permissionClasses: z.array(PermissionClassSchema),
  policyRefs: z.array(PolicyIdSchema),
}).strict();
export type ResolvedAuthority = z.infer<typeof ResolvedAuthoritySchema>;

export const GovernanceDecisionSchema = z.object({
  decision: PolicyDecisionValueSchema.extract(["ALLOW", "DENY"]),
  actorId: identifierSchema.optional(),
  requestedPermissionClasses: z.array(PermissionClassSchema),
  authority: ResolvedAuthoritySchema.optional(),
  reasonCodes: z.array(GovernanceReasonCodeSchema).min(1),
}).strict();
export type GovernanceDecision = z.infer<typeof GovernanceDecisionSchema>;
