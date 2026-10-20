import { describe, expect, it } from "vitest";
import {
  validateCompanyManifest,
  computeCompanyConfigFingerprint,
  CompanyConfigError,
  type CompanyManifestV1,
} from "../src/index.js";

const VALID_MANIFEST: CompanyManifestV1 = {
  schemaVersion: 1,
  companyId: "northstar-commerce",
  displayName: "Northstar Commerce",
  enabledProofs: ["company_research", "document_intelligence", "operational_request"],
  models: {
    bindingRefs: ["binding.research-model", "binding.ops-model"],
  },
  integrations: {
    publicWebProviderRef: "provider.web.northstar",
    documentSourceProviderRef: "provider.doc.northstar",
    draftRepositoryRef: "repo.drafts.northstar",
  },
  governance: {
    actors: [
      { id: "principal.northstar.analyst", type: "user" },
      { id: "principal.northstar.requester", type: "user" },
      { id: "principal.northstar.manager", type: "user" },
    ],
    roles: [
      { id: "research.analyst", version: "1.0.0", permissionClasses: ["read_only"] },
      { id: "operations.requester", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
      { id: "operations.approver", version: "1.0.0", permissionClasses: ["read_only"] },
    ],
    bindings: [
      { id: "b.analyst", actorId: "principal.northstar.analyst", roleId: "research.analyst", status: "active" },
      { id: "b.req", actorId: "principal.northstar.requester", roleId: "operations.requester", status: "active" },
      { id: "b.mgr", actorId: "principal.northstar.manager", roleId: "operations.approver", status: "active" },
    ],
    policies: [],
  },
  reliability: {
    company_research: {
      search: { maxAttempts: 2, attemptTimeoutMs: 5000 },
    },
  },
};

describe("Company Manifest V1 Validation", () => {
  it("requires a write_draft requester and a distinct active human operations.approver", () => {
    const base = structuredClone(VALID_MANIFEST);
    expect(() => validateCompanyManifest(base)).not.toThrow();
    const rejects = (governance: CompanyManifestV1["governance"]) =>
      expect(() => validateCompanyManifest({ ...base, governance })).toThrow(/CONFIG_GOVERNANCE_INVALID/);
    rejects({ ...base.governance, roles: base.governance.roles.filter((role) => role.id !== "operations.approver"), bindings: base.governance.bindings.filter((binding) => binding.roleId !== "operations.approver") });
    rejects({ ...base.governance, bindings: base.governance.bindings.filter((binding) => binding.roleId !== "operations.approver") });
    rejects({ ...base.governance, bindings: base.governance.bindings.map((binding) => binding.roleId === "operations.approver" ? { ...binding, status: "inactive" as const } : binding) });
    rejects({ ...base.governance, actors: base.governance.actors.filter((actor) => actor.id !== "principal.northstar.manager"), bindings: base.governance.bindings.filter((binding) => binding.actorId !== "principal.northstar.manager") });
    rejects({ ...base.governance, actors: base.governance.actors.map((actor) => actor.id === "principal.northstar.manager" ? { ...actor, type: "service" as const } : actor) });
    rejects({ ...base.governance, roles: base.governance.roles.map((role) => role.id === "operations.requester" ? { ...role, permissionClasses: ["read_only" as const] } : role) });
    rejects({ ...base.governance, bindings: base.governance.bindings.map((binding) => binding.roleId === "operations.requester" ? { ...binding, status: "inactive" as const } : binding) });
    rejects({ ...base.governance, bindings: base.governance.bindings.map((binding) => binding.roleId === "operations.approver" ? { ...binding, actorId: "principal.northstar.requester" } : binding) });
    rejects({ ...base.governance, policies: [{ id: "deny.drafts", rules: [{ id: "deny.write", effect: "DENY" as const, permissionClasses: ["write_draft" as const] }] }] });
    rejects({ ...base.governance, policies: [{ id: "bad.role", rules: [{ id: "bad.reference", effect: "DENY" as const, permissionClasses: ["write_draft" as const], roleIds: ["missing.role"] }] }] });
  });

  it("validates a compliant manifest and generates a deterministic fingerprint", () => {
    const { manifest, configFingerprint } = validateCompanyManifest(VALID_MANIFEST);

    expect(manifest.companyId).toBe("northstar-commerce");
    expect(manifest.displayName).toBe("Northstar Commerce");
    expect(manifest.schemaVersion).toBe(1);
    expect(configFingerprint).toMatch(/^[a-f0-9]{64}$/);

    // Determinism: same manifest produces same fingerprint
    const again = validateCompanyManifest(VALID_MANIFEST);
    expect(again.configFingerprint).toBe(configFingerprint);
    expect(computeCompanyConfigFingerprint(manifest)).toBe(configFingerprint);

    // Freezing: output is frozen
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.models)).toBe(true);
    expect(Object.isFrozen(manifest.governance)).toBe(true);
  });

  it("parses valid JSON string representations", () => {
    const json = JSON.stringify(VALID_MANIFEST);
    const result = validateCompanyManifest(json);
    expect(result.manifest.companyId).toBe("northstar-commerce");
  });

  it("rejects non-object or malformed JSON inputs", () => {
    expect(() => validateCompanyManifest("not a json string")).toThrowError(CompanyConfigError);
    expect(() => validateCompanyManifest(null)).toThrowError(CompanyConfigError);
    expect(() => validateCompanyManifest(123)).toThrowError(CompanyConfigError);
    expect(() => validateCompanyManifest([])).toThrowError(CompanyConfigError);
  });

  it("rejects unsupported schemaVersion with CONFIG_UNSUPPORTED_VERSION", () => {
    const invalid = { ...VALID_MANIFEST, schemaVersion: 2 };
    expect(() => validateCompanyManifest(invalid)).toThrowError(/CONFIG_UNSUPPORTED_VERSION/);

    const missing = { ...VALID_MANIFEST };
    // @ts-expect-error testing missing field
    delete missing.schemaVersion;
    expect(() => validateCompanyManifest(missing)).toThrowError(/CONFIG_INVALID_SCHEMA/);
  });

  it("rejects unknown properties in root or sub-objects (strictness)", () => {
    const unknownRoot = { ...VALID_MANIFEST, unexpectedProperty: "bad" };
    expect(() => validateCompanyManifest(unknownRoot)).toThrowError(/CONFIG_INVALID_SCHEMA/);

    const unknownModel = {
      ...VALID_MANIFEST,
      models: { ...VALID_MANIFEST.models, extraProp: 123 },
    };
    expect(() => validateCompanyManifest(unknownModel)).toThrowError(/CONFIG_INVALID_SCHEMA/);

    const forbiddenFlags = {
      ...VALID_MANIFEST,
      allowExternalEffects: true,
      skipApproval: true,
    };
    expect(() => validateCompanyManifest(forbiddenFlags)).toThrowError(/CONFIG_INVALID_SCHEMA/);
  });

  it("rejects prototype-pollution property injections", () => {
    const polluted = JSON.parse('{"schemaVersion": 1, "__proto__": {"polluted": true}}');
    expect(() => validateCompanyManifest(polluted)).toThrowError(/CONFIG_INVALID_SCHEMA/);
  });

  it("rejects duplicate or empty enabledProofs", () => {
    const duplicate = {
      ...VALID_MANIFEST,
      enabledProofs: ["company_research", "company_research"],
    };
    expect(() => validateCompanyManifest(duplicate)).toThrowError(/CONFIG_INVALID_SCHEMA/);

    const empty = { ...VALID_MANIFEST, enabledProofs: [] };
    expect(() => validateCompanyManifest(empty)).toThrowError(/CONFIG_INVALID_SCHEMA/);
  });

  it("rejects duplicate bindingRefs", () => {
    const duplicate = {
      ...VALID_MANIFEST,
      models: { bindingRefs: ["binding.model-a", "binding.model-a"] },
    };
    expect(() => validateCompanyManifest(duplicate)).toThrowError(/CONFIG_INVALID_SCHEMA/);
  });

  it("rejects untrimmed or multiline display names", () => {
    expect(() =>
      validateCompanyManifest({ ...VALID_MANIFEST, displayName: "  Northstar  " })
    ).toThrowError(/CONFIG_INVALID_SCHEMA/);

    expect(() =>
      validateCompanyManifest({ ...VALID_MANIFEST, displayName: "Northstar\nCommerce" })
    ).toThrowError(/CONFIG_INVALID_SCHEMA/);
  });

  it("enforces required integration bindings for enabled proofs with CONFIG_BINDING_INVALID", () => {
    // Missing publicWebProviderRef when company_research is enabled
    const missingWeb = {
      ...VALID_MANIFEST,
      integrations: {
        documentSourceProviderRef: "provider.doc.northstar",
        draftRepositoryRef: "repo.drafts.northstar",
      },
    };
    expect(() => validateCompanyManifest(missingWeb)).toThrowError(/CONFIG_BINDING_INVALID/);

    // Missing documentSourceProviderRef when document_intelligence is enabled
    const missingDoc = {
      ...VALID_MANIFEST,
      integrations: {
        publicWebProviderRef: "provider.web.northstar",
        draftRepositoryRef: "repo.drafts.northstar",
      },
    };
    expect(() => validateCompanyManifest(missingDoc)).toThrowError(/CONFIG_BINDING_INVALID/);

    // Missing draftRepositoryRef when operational_request is enabled
    const missingRepo = {
      ...VALID_MANIFEST,
      integrations: {
        publicWebProviderRef: "provider.web.northstar",
        documentSourceProviderRef: "provider.doc.northstar",
      },
    };
    expect(() => validateCompanyManifest(missingRepo)).toThrowError(/CONFIG_BINDING_INVALID/);
  });

  it("validates governance referential integrity and rejects broken references", () => {
    // Unresolved actor in role binding
    const badActor = {
      ...VALID_MANIFEST,
      governance: {
        ...VALID_MANIFEST.governance,
        bindings: [
          {
            id: "b.bad",
            actorId: "principal.unknown",
            roleId: "research.analyst",
            status: "active" as const,
          },
        ],
      },
    };
    expect(() => validateCompanyManifest(badActor)).toThrowError(/CONFIG_GOVERNANCE_INVALID/);

    // Unresolved role in role binding
    const badRole = {
      ...VALID_MANIFEST,
      governance: {
        ...VALID_MANIFEST.governance,
        bindings: [
          {
            id: "b.bad",
            actorId: "principal.northstar.analyst",
            roleId: "role.nonexistent",
            status: "active" as const,
          },
        ],
      },
    };
    expect(() => validateCompanyManifest(badRole)).toThrowError(/CONFIG_GOVERNANCE_INVALID/);

    // Duplicate actor ID
    const duplicateActor = {
      ...VALID_MANIFEST,
      governance: {
        ...VALID_MANIFEST.governance,
        actors: [
          { id: "principal.dup", type: "user" as const },
          { id: "principal.dup", type: "user" as const },
        ],
      },
    };
    expect(() => validateCompanyManifest(duplicateActor)).toThrowError(/CONFIG_GOVERNANCE_INVALID/);
  });

  it("enforces permission safety: rejects unsupported permission classes in governance", () => {
    const unsupportedPerm = {
      ...VALID_MANIFEST,
      governance: {
        ...VALID_MANIFEST.governance,
        roles: [
          ...VALID_MANIFEST.governance.roles,
          {
            id: "danger.role",
            version: "1.0.0",
            permissionClasses: ["external_side_effect" as const],
          },
        ],
        bindings: [
          ...VALID_MANIFEST.governance.bindings,
          {
            id: "b.danger",
            actorId: "principal.northstar.manager",
            roleId: "danger.role",
            status: "active" as const,
          },
        ],
      },
    };
    expect(() => validateCompanyManifest(unsupportedPerm)).toThrowError(/CONFIG_GOVERNANCE_INVALID/);
  });

  it("recomputes fingerprint on permitted configuration change", () => {
    const result1 = validateCompanyManifest(VALID_MANIFEST);

    const modified = {
      ...VALID_MANIFEST,
      displayName: "Northstar Commerce International",
    };
    const result2 = validateCompanyManifest(modified);

    expect(result1.configFingerprint).not.toBe(result2.configFingerprint);
  });
});
