import type { CompanyManifestV1 } from "@aao/config";

export const ARBOR_ACTORS = {
  researcher: { id: "user.arbor.researcher", type: "user" as const },
  requester: { id: "user.arbor.requester", type: "user" as const },
  manager: { id: "user.arbor.manager", type: "user" as const },
};

export const ARBOR_ROLES = {
  researcher: "consulting.researcher",
  requester: "client.operations",
  approver: "operations.approver",
} as const;

export const ARBOR_MANIFEST: CompanyManifestV1 = Object.freeze({
  schemaVersion: 1,
  companyId: "arbor-consulting",
  displayName: "Arbor Consulting",
  enabledProofs: [
    "company_research" as const,
    "document_intelligence" as const,
    "operational_request" as const,
  ],
  models: {
    bindingRefs: ["arbor.model.vercel"],
  },
  integrations: {
    publicWebProviderRef: "arbor.web-provider",
    documentSourceProviderRef: "arbor.doc-provider",
    draftRepositoryRef: "arbor.draft-repository",
  },
  governance: {
    actors: [
      ARBOR_ACTORS.researcher,
      ARBOR_ACTORS.requester,
      ARBOR_ACTORS.manager,
    ],
    roles: [
      {
        id: ARBOR_ROLES.researcher,
        version: "1.0.0",
        description: "Arbor Consulting Researcher",
        permissionClasses: ["read_only" as const],
      },
      {
        id: ARBOR_ROLES.requester,
        version: "1.0.0",
        description: "Arbor Client Operations",
        permissionClasses: ["read_only" as const, "write_draft" as const],
      },
      {
        id: ARBOR_ROLES.approver,
        version: "1.0.0",
        description: "Arbor Engagement Manager",
        permissionClasses: ["read_only" as const],
      },
    ],
    bindings: [
      {
        id: "rb.arbor.researcher",
        actorId: ARBOR_ACTORS.researcher.id,
        roleId: ARBOR_ROLES.researcher,
        status: "active" as const,
      },
      {
        id: "rb.arbor.requester",
        actorId: ARBOR_ACTORS.requester.id,
        roleId: ARBOR_ROLES.requester,
        status: "active" as const,
      },
      {
        id: "rb.arbor.manager",
        actorId: ARBOR_ACTORS.manager.id,
        roleId: ARBOR_ROLES.approver,
        status: "active" as const,
      },
    ],
    policies: [],
  },
  reliability: {
    document_intelligence: {
      extract_document: { maxAttempts: 2, attemptTimeoutMs: 15000 },
    },
  },
});
