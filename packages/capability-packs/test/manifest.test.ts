import { describe, expect, it } from "vitest";
import {
  defineCapabilityPack,
  validateCapabilityPackManifest,
  CapabilityPackError,
  type CapabilityPackManifestV1Input,
  COMPANY_RESEARCH_PACK_MANIFEST,
} from "../src/index.js";

describe("Capability Pack Manifest V1", () => {
  it("validates valid canonical manifests and freezes them", () => {
    const pack = defineCapabilityPack(COMPANY_RESEARCH_PACK_MANIFEST);
    expect(pack.identity).toBe("aao.company-research@1.0.0");
    expect(pack.manifest.schemaVersion).toBe(1);
    expect(pack.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.manifest)).toBe(true);
  });

  it("computes deterministic fingerprints: identical content produces identical fingerprint", () => {
    const pack1 = defineCapabilityPack(COMPANY_RESEARCH_PACK_MANIFEST);
    const pack2 = defineCapabilityPack(JSON.parse(JSON.stringify(COMPANY_RESEARCH_PACK_MANIFEST)));
    expect(pack1.fingerprint).toBe(pack2.fingerprint);
  });

  it("changes fingerprint when any manifest field changes", () => {
    const pack1 = defineCapabilityPack(COMPANY_RESEARCH_PACK_MANIFEST);
    const modified = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      description: "A slightly different description for testing fingerprint change.",
    };
    const pack2 = defineCapabilityPack(modified);
    expect(pack1.fingerprint).not.toBe(pack2.fingerprint);
  });

  it("rejects invalid schemaVersion", () => {
    const invalid = { ...COMPANY_RESEARCH_PACK_MANIFEST, schemaVersion: 2 };
    expect(() => defineCapabilityPack(invalid)).toThrow(CapabilityPackError);
    expect(() => defineCapabilityPack(invalid)).toThrow(/Unsupported schemaVersion 2/);
  });

  it("rejects non-exact SemVer versions (e.g. latest, ^1.0.0, >=1.0.0, 1.0)", () => {
    const cases = ["latest", "^1.0.0", "~1.0.0", ">=1.0.0", "1.0", "v1.0.0", "1.0.0-beta"];
    for (const badVersion of cases) {
      const invalid = { ...COMPANY_RESEARCH_PACK_MANIFEST, version: badVersion };
      expect(() => defineCapabilityPack(invalid)).toThrow(CapabilityPackError);
    }
  });

  it("rejects unknown fields in manifest (strict schema)", () => {
    const invalid = { ...COMPANY_RESEARCH_PACK_MANIFEST, extraField: "not allowed" };
    expect(() => defineCapabilityPack(invalid)).toThrow(CapabilityPackError);
  });

  it("rejects forbidden authority override fields", () => {
    const forbidden = [
      "handler",
      "execute",
      "script",
      "modulePath",
      "dynamicImport",
      "eval",
      "skipAuthorization",
      "disableApproval",
      "forceSuccess",
      "allowExternalEffects",
    ];
    for (const field of forbidden) {
      const invalid = { ...COMPANY_RESEARCH_PACK_MANIFEST, [field]: true };
      expect(() => defineCapabilityPack(invalid)).toThrow(CapabilityPackError);
      expect(() => defineCapabilityPack(invalid)).toThrow(/forbidden authority override field/);
    }
  });

  it("rejects prototype pollution keys", () => {
    const pollutedJson = '{"schemaVersion":1,"id":"test","__proto__":{"polluted":true}}';
    expect(() => validateCapabilityPackManifest(pollutedJson)).toThrow(CapabilityPackError);
    expect(() => validateCapabilityPackManifest(pollutedJson)).toThrow(/prototype-pollution/);
  });

  it("rejects duplicate tool references", () => {
    const invalid: CapabilityPackManifestV1Input = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      requirements: {
        ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
        toolRefs: [
          { id: "public_web.search", version: "1.0.0" },
          { id: "public_web.search", version: "1.0.0" },
        ],
      },
    };
    expect(() => defineCapabilityPack(invalid)).toThrow(CapabilityPackError);
    expect(() => defineCapabilityPack(invalid)).toThrow(/duplicate tool references/);
  });

  it("rejects duplicate model policy references", () => {
    const invalid: CapabilityPackManifestV1Input = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      requirements: {
        ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
        modelPolicyRefs: ["company_research.planning", "company_research.planning"],
      },
    };
    expect(() => defineCapabilityPack(invalid)).toThrow(CapabilityPackError);
    expect(() => defineCapabilityPack(invalid)).toThrow(/duplicate entries/);
  });

  it("rejects duplicate tags", () => {
    const invalid: CapabilityPackManifestV1Input = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      tags: ["tag1", "tag1"],
    };
    expect(() => defineCapabilityPack(invalid)).toThrow(CapabilityPackError);
    expect(() => defineCapabilityPack(invalid)).toThrow(/tags must be unique/);
  });

  it("rejects duplicate integration slots", () => {
    const invalid: CapabilityPackManifestV1Input = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      requirements: {
        ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
        integrationSlots: [
          { slot: "public_web", description: "desc 1" },
          { slot: "public_web", description: "desc 2" },
        ],
      },
    };
    expect(() => defineCapabilityPack(invalid)).toThrow(CapabilityPackError);
    expect(() => defineCapabilityPack(invalid)).toThrow(/duplicate slots/);
  });

  it("rejects unsupported permission classes in preliminaryPermissions", () => {
    const invalid = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      requirements: {
        ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
        preliminaryPermissions: ["external_side_effect"],
      },
    };
    expect(() => defineCapabilityPack(invalid)).toThrow(CapabilityPackError);
  });

  it("enforces outcome class coherence: read_only cannot require approval or declare write_draft", () => {
    const invalidApproval = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      requirements: {
        ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
        approval: {
          required: true,
          requiredRoleIds: ["ops.approver"],
          permissionClasses: ["read_only"],
        },
      },
    };
    expect(() => defineCapabilityPack(invalidApproval)).toThrow(CapabilityPackError);

    const invalidPerm = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      requirements: {
        ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
        preliminaryPermissions: ["write_draft"],
      },
    };
    expect(() => defineCapabilityPack(invalidPerm)).toThrow(CapabilityPackError);
  });

  it("enforces outcome class coherence: draft_only must declare write_draft preliminaryPermission", () => {
    const invalidDraftOnly: CapabilityPackManifestV1Input = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      id: "aao.test-draft",
      execution: {
        outcomeClass: "draft_only",
      },
      requirements: {
        ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
        preliminaryPermissions: ["read_only"],
      },
    };
    expect(() => defineCapabilityPack(invalidDraftOnly)).toThrow(CapabilityPackError);
    expect(() => defineCapabilityPack(invalidDraftOnly)).toThrow(/must declare preliminary permission 'write_draft'/);
  });

  it("enforces approval coherence: approval permissionClasses must be in preliminaryPermissions", () => {
    const invalidApprovalCoherence: CapabilityPackManifestV1Input = {
      ...COMPANY_RESEARCH_PACK_MANIFEST,
      id: "aao.test-approval",
      execution: {
        outcomeClass: "draft_only",
      },
      requirements: {
        ...COMPANY_RESEARCH_PACK_MANIFEST.requirements,
        preliminaryPermissions: ["write_draft"],
        approval: {
          required: true,
          requiredRoleIds: ["ops.approver"],
          permissionClasses: ["read_only"], // read_only is not in preliminaryPermissions!
        },
      },
    };
    expect(() => defineCapabilityPack(invalidApprovalCoherence)).toThrow(CapabilityPackError);
    expect(() => defineCapabilityPack(invalidApprovalCoherence)).toThrow(/must be included in preliminaryPermissions/);
  });
});
