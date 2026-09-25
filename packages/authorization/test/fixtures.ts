import type { PermissionClass } from "@aao/contracts";
import type { AuthorizationContext } from "../src/types.js";

export function context(grantedPermissionClasses: PermissionClass[], agentCeiling?: PermissionClass[]): AuthorizationContext {
  return {
    schemaVersion: 1,
    principal: { id: "user.alice", type: "user" },
    grantedPermissionClasses,
    ...(agentCeiling !== undefined ? { agent: { agentRef: { id: "agent.research", version: "1.0.0" }, permissionCeiling: agentCeiling } } : {}),
  };
}

export function request(requiredPermissionClasses: PermissionClass[], ctx: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    action: "tool.execute",
    resource: { type: "tool", id: "local.lookup", version: "1.0.0" },
    requiredPermissionClasses,
    context: ctx,
    ...overrides,
  };
}
