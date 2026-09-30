import { PermissionClassesSchema, type AgentSpec, type PermissionClass } from "@aao/contracts";
import { z } from "zod";
import type { ResolvedAuthority } from "@aao/governance";
import {
  AuthorizationActionSchema,
  AuthorizationContextSchema,
  AuthorizationResourceSchema,
  type AgentAuthority,
  type AuthorizationDecision,
  type AuthorizationContext,
  type AuthorizationDenialReasonCode,
} from "./types.js";

/** The request envelope, parsed separately from its context so a malformed context yields its own reason code. */
const RequestEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: AuthorizationActionSchema,
    resource: AuthorizationResourceSchema,
    requiredPermissionClasses: PermissionClassesSchema,
    context: z.unknown(),
  })
  .strict();

/**
 * The single canonical AAO authorization evaluator. Every governed caller —
 * the Tool Runtime today; Agent Tool use and MCP-backed Tools later — uses
 * this function; there is no second decision path.
 *
 * Rule (explicit permission sets, no hierarchy, no superuser):
 *
 *   required ⊆ principal grants                      else DENY PERMISSION_NOT_GRANTED
 *   required ⊆ agent ceiling   (only if agent given)  else DENY AGENT_PERMISSION_CEILING_EXCEEDED
 *
 * so effective authority is `principal grants ∩ agent ceiling`: the ceiling
 * can reduce authority, never extend it. The principal check runs first, so
 * a request the principal could not make is reported as the principal's
 * missing grant even when the Agent ceiling would also reject it.
 *
 * Pure and synchronous: no I/O, model, clock, randomness, cached verdict,
 * or logging. The input is untrusted and validated here; a malformed request
 * or context is a DENY value, never a throw. It decides only; runtime
 * support for a permission class (e.g. `external_side_effect`) is a separate
 * gate the caller enforces before asking.
 */
export function authorize(request: unknown): AuthorizationDecision {
  const envelope = RequestEnvelopeSchema.safeParse(request);
  if (!envelope.success) return deny("INVALID_AUTHORIZATION_REQUEST");
  const required = [...envelope.data.requiredPermissionClasses];

  const parsedContext = AuthorizationContextSchema.safeParse(envelope.data.context);
  if (!parsedContext.success) return deny("INVALID_AUTHORIZATION_CONTEXT", { requiredPermissionClasses: required });
  const context = parsedContext.data;
  const evidence = { principalId: context.principal.id, requiredPermissionClasses: required, agentCeilingApplied: context.agent !== undefined };

  if (!isSubset(required, context.grantedPermissionClasses)) return deny("PERMISSION_NOT_GRANTED", evidence);
  if (context.agent !== undefined && !isSubset(required, context.agent.permissionCeiling)) return deny("AGENT_PERMISSION_CEILING_EXCEEDED", evidence);
  return { schemaVersion: 1, decision: "ALLOW", ...evidence };
}

/**
 * Builds the Agent part of an Authorization Context from a trusted,
 * registered canonical `AgentSpec`: its `permissionClasses` become the
 * ceiling. This is the only sanctioned source of an Agent ceiling.
 */
export function agentAuthorityFromSpec(spec: Pick<AgentSpec, "id" | "version" | "permissionClasses">): AgentAuthority {
  return { agentRef: { id: spec.id, version: spec.version }, permissionCeiling: [...spec.permissionClasses] };
}

/** Trusted-host bridge from a resolved governance result to the existing evaluator. */
export function authorizationContextFromAuthority(authority: ResolvedAuthority, agent?: AgentAuthority): AuthorizationContext {
  return AuthorizationContextSchema.parse({
    schemaVersion: 1,
    principal: authority.actor,
    grantedPermissionClasses: authority.permissionClasses,
    ...(agent === undefined ? {} : { agent }),
  });
}

/** Exact membership: no permission class implies another. */
function isSubset(required: readonly PermissionClass[], available: readonly PermissionClass[]): boolean {
  return required.every((permissionClass) => available.includes(permissionClass));
}

function deny(
  reasonCode: AuthorizationDenialReasonCode,
  evidence: { principalId?: string; requiredPermissionClasses?: PermissionClass[]; agentCeilingApplied?: boolean } = {},
): AuthorizationDecision {
  return { schemaVersion: 1, decision: "DENY", reasonCode, ...evidence };
}
