import { z } from "zod";
import {
  AgentIdSchema,
  PermissionClassSchema,
  PermissionClassesSchema,
  PolicyDecisionValueSchema,
  PrincipalSchema,
  ToolIdSchema,
  entityVersionSchema,
  identifierSchema,
  schemaVersionSchema,
} from "@aao/contracts";

// --- Authorization Context (host-attested authority) ---------------------------

/**
 * The kinds of principal a trusted host can attest. The type is descriptive
 * only: no principal type — `system` included — implies any permission.
 * Every principal carries explicit grants.
 */
export { PRINCIPAL_TYPES, PrincipalTypeSchema, PrincipalSchema } from "@aao/contracts";
export type { PrincipalType, Principal } from "@aao/contracts";

/**
 * The permission classes explicitly granted to a principal. Canonical
 * `PermissionClass` values only; may be empty (a principal with no
 * authority); duplicates are rejected, matching `PermissionClassesSchema`.
 */
export const GrantedPermissionClassesSchema = z
  .array(PermissionClassSchema)
  .refine((classes) => new Set(classes).size === classes.length, { message: "permission classes must not contain duplicate entries" });

/**
 * An Agent acting on behalf of the principal. `permissionCeiling` must come
 * from the trusted, registered `AgentSpec.permissionClasses` (see
 * `agentAuthorityFromSpec`) — never from model output, an `AgentDecision`,
 * task text, workflow state, Tool input, or a prompt. It can only reduce the
 * principal's authority, never extend it.
 */
export const AgentAuthoritySchema = z
  .object({
    agentRef: z.object({ id: AgentIdSchema, version: entityVersionSchema }).strict(),
    permissionCeiling: PermissionClassesSchema,
  })
  .strict();
export type AgentAuthority = z.infer<typeof AgentAuthoritySchema>;

/**
 * The authority a trusted host attests for one execution. AAO does not
 * authenticate: the host has already established who the principal is and
 * supplies this context outside every untrusted channel (Tool input,
 * workflow state, node config, model output). JSON-safe and strict; there
 * is no `admin`, `allowAll`, or bypass field.
 */
export const AuthorizationContextSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    principal: PrincipalSchema,
    grantedPermissionClasses: GrantedPermissionClassesSchema,
    agent: AgentAuthoritySchema.optional(),
  })
  .strict();
export type AuthorizationContext = z.infer<typeof AuthorizationContextSchema>;

// --- Authorization Request ----------------------------------------------------------

/** The governed actions this evaluator decides. V1 implements exactly one; the enum leaves room without inventing more. */
export const AUTHORIZATION_ACTIONS = ["tool.execute"] as const;
export const AuthorizationActionSchema = z.enum(AUTHORIZATION_ACTIONS);
export type AuthorizationAction = z.infer<typeof AuthorizationActionSchema>;

export const AuthorizationResourceSchema = z
  .object({
    type: z.literal("tool"),
    id: ToolIdSchema,
    version: entityVersionSchema,
  })
  .strict();
export type AuthorizationResource = z.infer<typeof AuthorizationResourceSchema>;

/**
 * A provider-independent authorization question: may the attested
 * `context` perform `action` on `resource`, which requires
 * `requiredPermissionClasses` (for a Tool: its canonical
 * `ToolSpec.permissionClasses`)?
 */
export const AuthorizationRequestSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    action: AuthorizationActionSchema,
    resource: AuthorizationResourceSchema,
    requiredPermissionClasses: PermissionClassesSchema,
    context: AuthorizationContextSchema,
  })
  .strict();
export type AuthorizationRequest = z.infer<typeof AuthorizationRequestSchema>;

// --- Authorization Decision ---------------------------------------------------------

/**
 * Safe, machine-readable denial reasons. Never free text:
 *
 * - `INVALID_AUTHORIZATION_REQUEST` — the request envelope (action,
 *   resource, required permissions) is malformed.
 * - `INVALID_AUTHORIZATION_CONTEXT` — the attested context is malformed.
 * - `PERMISSION_NOT_GRANTED` — a required permission is not granted to the principal.
 * - `AGENT_PERMISSION_CEILING_EXCEEDED` — the principal holds every required
 *   permission, but the acting Agent's ceiling excludes one.
 */
export const AUTHORIZATION_DENIAL_REASON_CODES = [
  "INVALID_AUTHORIZATION_REQUEST",
  "INVALID_AUTHORIZATION_CONTEXT",
  "PERMISSION_NOT_GRANTED",
  "AGENT_PERMISSION_CEILING_EXCEEDED",
] as const;
export const AuthorizationDenialReasonCodeSchema = z.enum(AUTHORIZATION_DENIAL_REASON_CODES);
export type AuthorizationDenialReasonCode = z.infer<typeof AuthorizationDenialReasonCodeSchema>;

/**
 * Reuses the canonical `PolicyDecisionValue` vocabulary, restricted to the
 * two values this boundary can produce. `REQUIRE_APPROVAL` belongs to the
 * future approval engine, not to permission-set authorization (ADR-014).
 */
export const AuthorizationDecisionValueSchema = PolicyDecisionValueSchema.extract(["ALLOW", "DENY"]);

/**
 * A small, JSON-safe, deterministic decision plus bounded evidence for later
 * tracing: who was evaluated, what was required, and whether an Agent
 * ceiling applied. No Tool input, grants list, credentials, or free text.
 * A DENY caused by a malformed request or context omits what could not be
 * parsed.
 */
export const AuthorizationDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      schemaVersion: schemaVersionSchema(1),
      decision: z.literal(AuthorizationDecisionValueSchema.enum.ALLOW),
      principalId: identifierSchema,
      requiredPermissionClasses: PermissionClassesSchema,
      agentCeilingApplied: z.boolean(),
    })
    .strict(),
  z
    .object({
      schemaVersion: schemaVersionSchema(1),
      decision: z.literal(AuthorizationDecisionValueSchema.enum.DENY),
      reasonCode: AuthorizationDenialReasonCodeSchema,
      principalId: identifierSchema.optional(),
      requiredPermissionClasses: PermissionClassesSchema.optional(),
      agentCeilingApplied: z.boolean().optional(),
    })
    .strict(),
]);
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;
export type AuthorizationAllow = Extract<AuthorizationDecision, { decision: "ALLOW" }>;
export type AuthorizationDeny = Extract<AuthorizationDecision, { decision: "DENY" }>;
