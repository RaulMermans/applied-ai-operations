import {
  GovernanceConfigurationSchema,
  PermissionClassSchema,
  PrincipalSchema,
  type GovernanceConfiguration,
  type PermissionClass,
  type GovernanceDecision,
  type ResolvedAuthority,
} from "@aao/contracts";

export type { GovernanceDecision, GovernanceReasonCode, ResolvedAuthority } from "@aao/contracts";
class Registry {
  constructor(readonly configuration: Readonly<GovernanceConfiguration>) { Object.freeze(this); }
}
export type GovernanceRegistry = Registry;

/** Compile and validate trusted host configuration before any execution. */
export function createGovernanceRegistry(input: unknown): GovernanceRegistry {
  const configuration = GovernanceConfigurationSchema.parse(input);
  unique(configuration.actors.map((actor) => actor.id), "actor");
  unique(configuration.roles.map((role) => role.id), "role");
  unique(configuration.bindings.map((binding) => binding.id), "binding");
  unique(configuration.policies.map((policy) => policy.id), "policy");
  unique(configuration.policies.flatMap((policy) => policy.rules.map((rule) => rule.id)), "policy rule");
  const actors = new Set(configuration.actors.map((actor) => actor.id));
  const roles = new Set(configuration.roles.map((role) => role.id));
  for (const binding of configuration.bindings) {
    if (!actors.has(binding.actorId) || !roles.has(binding.roleId)) throw new Error("INVALID_GOVERNANCE_CONFIGURATION: unknown binding reference");
  }
  for (const policy of configuration.policies) {
    for (const rule of policy.rules) {
      if (rule.roleIds?.some((id) => !roles.has(id))) throw new Error("INVALID_GOVERNANCE_CONFIGURATION: unknown policy role");
    }
  }
  return new Registry(deepFreeze(configuration));
}

/** Resolve only registered host-attested actors; contextual data has no authority channel. */
export function resolveAuthority(registry: GovernanceRegistry, actorInput: unknown, requestedInput: unknown): GovernanceDecision {
  if (!(registry instanceof Registry)) return { decision: "DENY", requestedPermissionClasses: [], reasonCodes: ["GOVERNANCE_INVALID_CONTEXT"] };
  const actor = PrincipalSchema.safeParse(actorInput);
  const requested = PermissionClassSchema.array().min(1).safeParse(requestedInput);
  if (!actor.success || !requested.success) return { decision: "DENY", requestedPermissionClasses: [], reasonCodes: ["GOVERNANCE_INVALID_CONTEXT"] };
  const requestedPermissionClasses = sorted(new Set(requested.data));
  const registered = registry.configuration.actors.find((entry) => entry.id === actor.data.id && entry.type === actor.data.type);
  if (!registered) return { decision: "DENY", actorId: actor.data.id, requestedPermissionClasses, reasonCodes: ["GOVERNANCE_DEFAULT_DENY"] };
  const roleIds = sorted(new Set(registry.configuration.bindings.filter((binding) => binding.actorId === registered.id && binding.status === "active").map((binding) => binding.roleId)));
  const grants = new Set(registry.configuration.roles.filter((role) => roleIds.includes(role.id)).flatMap((role) => role.permissionClasses));
  const denied = new Set<PermissionClass>();
  const policyRefs = new Set<string>();
  for (const policy of registry.configuration.policies) {
    for (const rule of policy.rules) {
      if (rule.actorTypes && !rule.actorTypes.includes(registered.type)) continue;
      if (rule.roleIds && !rule.roleIds.some((id) => roleIds.includes(id))) continue;
      policyRefs.add(policy.id);
      for (const permission of rule.permissionClasses) denied.add(permission);
    }
  }
  const permissionClasses = sorted(new Set([...grants].filter((permission) => !denied.has(permission))));
  const authority: ResolvedAuthority = { actor: { ...registered }, roleIds, permissionClasses, policyRefs: sorted(policyRefs) };
  const allowed = requestedPermissionClasses.every((permission) => permissionClasses.includes(permission));
  const policyDenied = requestedPermissionClasses.some((permission) => denied.has(permission) && grants.has(permission));
  return {
    decision: allowed ? "ALLOW" : "DENY",
    actorId: registered.id,
    requestedPermissionClasses,
    authority,
    reasonCodes: [allowed ? "GOVERNANCE_ALLOWED" : policyDenied ? "GOVERNANCE_POLICY_DENY" : "GOVERNANCE_DEFAULT_DENY"],
  };
}

function sorted<T extends string>(values: Set<T>): T[] { return [...values].sort(); }
function unique(values: string[], kind: string): void {
  if (new Set(values).size !== values.length) throw new Error(`INVALID_GOVERNANCE_CONFIGURATION: duplicate ${kind} ID`);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
