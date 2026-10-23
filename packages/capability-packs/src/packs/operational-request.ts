import type { CapabilityPackManifestV1 } from "../contract.js";
import { defineCapabilityPack, type CapabilityPack } from "../pack.js";

export const OPERATIONAL_REQUEST_PACK_MANIFEST: CapabilityPackManifestV1 = Object.freeze({
  schemaVersion: 1,
  id: "aao.operational-request",
  version: "1.0.0",
  name: "Operational Request",
  description:
    "Interpret an operational request, validate an allowlisted change proposal, require eligible human Approval, and persist an approved local draft through the canonical Tool Runtime.",
  category: "operations",
  tags: ["operational-request", "human-approval", "change-proposal", "draft-only"],
  workflow: {
    id: "operational_request.proof",
    version: "1.0.0",
    planFingerprint: "8323d4dca07e54cb66fa8dd7f0614cf17a2afcd501d39c99802bd0b07c0d9d73",
  },
  requirements: {
    toolRefs: [
      { id: "operations.create_change_draft", version: "1.0.0" },
    ],
    modelPolicyRefs: [
      "operational_request.interpret",
    ],
    modelCapabilities: ["model.structured_output"],
    integrationSlots: [
      {
        slot: "draft_repository",
        description: "Governed local repository for operational change drafts",
      },
    ],
    preliminaryPermissions: ["write_draft" as const],
    approval: {
      required: true,
      requiredRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft" as const],
    },
  },
  execution: {
    outcomeClass: "draft_only" as const,
  },
  verification: {
    evalProfileRef: "aao.operational-request.evals@1.0.0",
  },
  documentation: {
    summary:
      "Operational request interpretation, proposal validation, human approval waitpoint, and governed local draft creation.",
    limitations: [
      "No external CRM update.",
      "No external-side-effect Tool execution.",
      "No destructive execution.",
      "No autonomous Approval.",
      "No production distributed transaction guarantee.",
      "Trusted-host execution assumptions remain.",
    ],
  },
});

export const OPERATIONAL_REQUEST_PACK: CapabilityPack = defineCapabilityPack(
  OPERATIONAL_REQUEST_PACK_MANIFEST
);
