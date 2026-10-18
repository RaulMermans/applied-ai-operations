import { describe, expect, it } from "vitest";
import { validateCompanyManifest } from "@aao/config";
import { NORTHSTAR_MANIFEST } from "../src/profiles/northstar-commerce.js";
import { ARBOR_MANIFEST } from "../src/profiles/arbor-consulting.js";

describe("Sprint 25 — Company Manifest & Configuration Tests", () => {
  it("validates Northstar Commerce and Arbor Consulting manifests", () => {
    const northstar = validateCompanyManifest(NORTHSTAR_MANIFEST);
    expect(northstar.manifest.companyId).toBe("northstar-commerce");
    expect(northstar.manifest.displayName).toBe("Northstar Commerce");
    expect(northstar.configFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const arbor = validateCompanyManifest(ARBOR_MANIFEST);
    expect(arbor.manifest.companyId).toBe("arbor-consulting");
    expect(arbor.manifest.displayName).toBe("Arbor Consulting");
    expect(arbor.configFingerprint).toMatch(/^[a-f0-9]{64}$/);

    // Distinct configuration fingerprints
    expect(northstar.configFingerprint).not.toBe(arbor.configFingerprint);
  });

  it("enforces immutability: deep-freezes validated manifests", () => {
    const { manifest } = validateCompanyManifest(NORTHSTAR_MANIFEST);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.models)).toBe(true);
    expect(Object.isFrozen(manifest.governance)).toBe(true);
    expect(Object.isFrozen(manifest.governance.actors)).toBe(true);
    expect(Object.isFrozen(manifest.governance.roles)).toBe(true);

    expect(() => {
      // @ts-expect-error mutating frozen object
      manifest.displayName = "Tampered";
    }).toThrow();
  });

  it("rejects unknown schema version with CONFIG_UNSUPPORTED_VERSION", () => {
    const invalidVersion = { ...NORTHSTAR_MANIFEST, schemaVersion: 2 };
    expect(() => validateCompanyManifest(invalidVersion)).toThrowError(
      /CONFIG_UNSUPPORTED_VERSION/
    );
  });

  it("rejects unknown properties in manifest root and sub-objects (strictness)", () => {
    const unknownRoot = { ...NORTHSTAR_MANIFEST, rogueProperty: "evil" };
    expect(() => validateCompanyManifest(unknownRoot)).toThrowError(/CONFIG_INVALID_SCHEMA/);

    const unknownIntegrations = {
      ...NORTHSTAR_MANIFEST,
      integrations: {
        ...NORTHSTAR_MANIFEST.integrations,
        unauthorizedConnector: "custom://evil",
      },
    };
    expect(() => validateCompanyManifest(unknownIntegrations)).toThrowError(
      /CONFIG_INVALID_SCHEMA/
    );

    const bypassFlags = {
      ...NORTHSTAR_MANIFEST,
      skipApproval: true,
      allowExternalEffects: true,
    };
    expect(() => validateCompanyManifest(bypassFlags)).toThrowError(/CONFIG_INVALID_SCHEMA/);
  });

  it("rejects prototype pollution attempts", () => {
    const polluted = JSON.parse('{"schemaVersion":1,"__proto__":{"polluted":true}}');
    expect(() => validateCompanyManifest(polluted)).toThrowError(/CONFIG_INVALID_SCHEMA/);
  });

  it("rejects missing integration references for enabled proofs", () => {
    const missingWeb = {
      ...NORTHSTAR_MANIFEST,
      integrations: {
        documentSourceProviderRef: "northstar.doc-provider",
        draftRepositoryRef: "northstar.draft-repository",
      },
    };
    expect(() => validateCompanyManifest(missingWeb)).toThrowError(/CONFIG_BINDING_INVALID/);

    const missingDoc = {
      ...NORTHSTAR_MANIFEST,
      integrations: {
        publicWebProviderRef: "northstar.web-provider",
        draftRepositoryRef: "northstar.draft-repository",
      },
    };
    expect(() => validateCompanyManifest(missingDoc)).toThrowError(/CONFIG_BINDING_INVALID/);

    const missingDraft = {
      ...NORTHSTAR_MANIFEST,
      integrations: {
        publicWebProviderRef: "northstar.web-provider",
        documentSourceProviderRef: "northstar.doc-provider",
      },
    };
    expect(() => validateCompanyManifest(missingDraft)).toThrowError(/CONFIG_BINDING_INVALID/);
  });

  it("rejects broken governance references with CONFIG_GOVERNANCE_INVALID", () => {
    const brokenActor = {
      ...NORTHSTAR_MANIFEST,
      governance: {
        ...NORTHSTAR_MANIFEST.governance,
        bindings: [
          {
            id: "b.broken",
            actorId: "user.nonexistent",
            roleId: "research.analyst",
            status: "active" as const,
          },
        ],
      },
    };
    expect(() => validateCompanyManifest(brokenActor)).toThrowError(/CONFIG_GOVERNANCE_INVALID/);

    const brokenRole = {
      ...NORTHSTAR_MANIFEST,
      governance: {
        ...NORTHSTAR_MANIFEST.governance,
        bindings: [
          {
            id: "b.broken",
            actorId: "user.northstar.analyst",
            roleId: "role.nonexistent",
            status: "active" as const,
          },
        ],
      },
    };
    expect(() => validateCompanyManifest(brokenRole)).toThrowError(/CONFIG_GOVERNANCE_INVALID/);
  });

  it("rejects unsupported permission classes in governance roles", () => {
    const unsupportedRole = {
      ...NORTHSTAR_MANIFEST,
      governance: {
        ...NORTHSTAR_MANIFEST.governance,
        roles: [
          ...NORTHSTAR_MANIFEST.governance.roles,
          {
            id: "destructive.role",
            version: "1.0.0",
            permissionClasses: ["destructive" as const],
          },
        ],
        bindings: [
          ...NORTHSTAR_MANIFEST.governance.bindings,
          {
            id: "b.destructive",
            actorId: "user.northstar.manager",
            roleId: "destructive.role",
            status: "active" as const,
          },
        ],
      },
    };
    expect(() => validateCompanyManifest(unsupportedRole)).toThrowError(
      /CONFIG_GOVERNANCE_INVALID/
    );
  });
});
