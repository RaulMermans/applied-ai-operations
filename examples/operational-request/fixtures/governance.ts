import { defineGovernance, type GovernanceConfiguration, type Principal } from "@aao/framework";

export const operator: Principal = Object.freeze({ id: "user.operator", type: "user" });
export const manager: Principal = Object.freeze({ id: "user.manager", type: "user" });
export const unauthorizedRequester: Principal = Object.freeze({ id: "user.unauthorized", type: "user" });
export const viewer: Principal = Object.freeze({ id: "user.viewer", type: "user" });
export const serviceActor: Principal = Object.freeze({ id: "service.bot", type: "service" });

export const fixtureGovernance: GovernanceConfiguration = defineGovernance({
  actors: [operator, manager, unauthorizedRequester, viewer, serviceActor],
  roles: [
    { id: "operations.requester", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
    { id: "operations.approver", version: "1.0.0", permissionClasses: ["read_only"] },
    { id: "operations.viewer", version: "1.0.0", permissionClasses: ["read_only"] },
    { id: "operations.service", version: "1.0.0", permissionClasses: ["read_only"] },
  ],
  bindings: [
    { id: "operator.requester", actorId: operator.id, roleId: "operations.requester", status: "active" },
    { id: "manager.approver", actorId: manager.id, roleId: "operations.approver", status: "active" },
    { id: "viewer.viewer", actorId: viewer.id, roleId: "operations.viewer", status: "active" },
    { id: "unauthorized.viewer", actorId: unauthorizedRequester.id, roleId: "operations.viewer", status: "active" },
    { id: "service.bot", actorId: serviceActor.id, roleId: "operations.service", status: "active" },
  ],
  policies: [],
});

/** Governance configuration where requester's write_draft authority has been revoked */
export function governanceWithRevokedRequester(): GovernanceConfiguration {
  return defineGovernance({
    ...fixtureGovernance,
    roles: [
      { id: "operations.requester", version: "1.0.0", permissionClasses: ["read_only"] },
      ...fixtureGovernance.roles.filter((r) => r.id !== "operations.requester"),
    ],
  });
}

/** Governance configuration where approver's membership in operations.approver has been revoked */
export function governanceWithRevokedApprover(): GovernanceConfiguration {
  return defineGovernance({
    ...fixtureGovernance,
    bindings: fixtureGovernance.bindings.filter((b) => b.actorId !== manager.id),
  });
}
