import type { CompanyManifestV1 } from "@aao/config";

export const NORTHSTAR_ACTORS = {
  analyst: { id: "user.northstar.analyst", type: "user" as const },
  requester: { id: "user.northstar.requester", type: "user" as const },
  manager: { id: "user.northstar.manager", type: "user" as const },
};

export const NORTHSTAR_ROLES = {
  analyst: "research.analyst",
  requester: "operations.requester",
  approver: "operations.approver",
} as const;

export const NORTHSTAR_MANIFEST: CompanyManifestV1 = Object.freeze({
  schemaVersion: 1,
  companyId: "northstar-commerce",
  displayName: "Northstar Commerce",
  enabledProofs: [
    "company_research" as const,
    "document_intelligence" as const,
    "operational_request" as const,
  ],
  models: {
    bindingRefs: ["northstar.model.native"],
  },
  integrations: {
    publicWebProviderRef: "northstar.web-provider",
    documentSourceProviderRef: "northstar.doc-provider",
    draftRepositoryRef: "northstar.draft-repository",
  },
  governance: {
    actors: [
      NORTHSTAR_ACTORS.analyst,
      NORTHSTAR_ACTORS.requester,
      NORTHSTAR_ACTORS.manager,
    ],
    roles: [
      {
        id: NORTHSTAR_ROLES.analyst,
        version: "1.0.0",
        description: "Northstar Research Analyst",
        permissionClasses: ["read_only" as const],
      },
      {
        id: NORTHSTAR_ROLES.requester,
        version: "1.0.0",
        description: "Northstar Operations Requester",
        permissionClasses: ["read_only" as const, "write_draft" as const],
      },
      {
        id: NORTHSTAR_ROLES.approver,
        version: "1.0.0",
        description: "Northstar Operations Approver",
        permissionClasses: ["read_only" as const],
      },
    ],
    bindings: [
      {
        id: "rb.northstar.analyst",
        actorId: NORTHSTAR_ACTORS.analyst.id,
        roleId: NORTHSTAR_ROLES.analyst,
        status: "active" as const,
      },
      {
        id: "rb.northstar.requester",
        actorId: NORTHSTAR_ACTORS.requester.id,
        roleId: NORTHSTAR_ROLES.requester,
        status: "active" as const,
      },
      {
        id: "rb.northstar.manager",
        actorId: NORTHSTAR_ACTORS.manager.id,
        roleId: NORTHSTAR_ROLES.approver,
        status: "active" as const,
      },
    ],
    policies: [],
  },
  reliability: {
    company_research: {
      search: { maxAttempts: 2, attemptTimeoutMs: 10000 },
    },
  },
});
