// @aao/authorization — AAO's deterministic Authorization Boundary (Sprint 9;
// see docs/architecture/authorization.md and ADR-014). Decides whether an
// already-attested principal (optionally acting through an Agent whose
// ceiling comes from its registered AgentSpec) may perform a governed action,
// by explicit permission-set membership only. No authentication, users,
// roles, policy language, approvals, persistence, or model involvement.

export {
  PRINCIPAL_TYPES,
  PrincipalTypeSchema,
  PrincipalSchema,
  GrantedPermissionClassesSchema,
  AgentAuthoritySchema,
  AuthorizationContextSchema,
  AUTHORIZATION_ACTIONS,
  AuthorizationActionSchema,
  AuthorizationResourceSchema,
  AuthorizationRequestSchema,
  AUTHORIZATION_DENIAL_REASON_CODES,
  AuthorizationDenialReasonCodeSchema,
  AuthorizationDecisionValueSchema,
  AuthorizationDecisionSchema,
} from "./types.js";
export type {
  PrincipalType,
  Principal,
  AgentAuthority,
  AuthorizationContext,
  AuthorizationAction,
  AuthorizationResource,
  AuthorizationRequest,
  AuthorizationDenialReasonCode,
  AuthorizationDecision,
  AuthorizationAllow,
  AuthorizationDeny,
} from "./types.js";
export { authorize, agentAuthorityFromSpec } from "./evaluator.js";
