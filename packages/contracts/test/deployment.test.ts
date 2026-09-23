import { describe, expect, it } from "vitest";
import { CapabilityPackRefSchema } from "../src/capability-pack.js";
import { CompanyConfigSchema } from "../src/deployment.js";
import { companyConfigFixture } from "./fixtures.js";

describe("CapabilityPackRefSchema", () => {
  it("parses a minimal pack reference", () => {
    expect(CapabilityPackRefSchema.safeParse({ capabilityPackId: "sales-operations-pack" }).success).toBe(true);
  });

  it("parses a pack reference with a version", () => {
    expect(CapabilityPackRefSchema.safeParse({ capabilityPackId: "sales-operations-pack", version: "1.0.0" }).success).toBe(
      true,
    );
  });

  it("rejects an unexpected top-level field (no speculative manifest fields)", () => {
    expect(CapabilityPackRefSchema.safeParse({ capabilityPackId: "p", workflows: [] }).success).toBe(false);
  });
});

describe("CompanyConfigSchema", () => {
  it("parses a valid minimal company config", () => {
    expect(CompanyConfigSchema.safeParse(companyConfigFixture).success).toBe(true);
  });

  it("requires no credential, secret, or OAuth field to validate", () => {
    expect(Object.keys(CompanyConfigSchema.shape)).not.toContain("credentials");
    expect(Object.keys(CompanyConfigSchema.shape)).not.toContain("apiKey");
    expect(Object.keys(CompanyConfigSchema.shape)).not.toContain("oauth");
  });

  it("rejects a credential-shaped field injected at the top level", () => {
    expect(CompanyConfigSchema.safeParse({ ...companyConfigFixture, apiKey: "sk-live-123" }).success).toBe(false);
  });

  it("represents capability/workflow/pack references without vendor coupling", () => {
    expect(companyConfigFixture.workflowRefs.every((id) => typeof id === "string")).toBe(true);
    expect(companyConfigFixture.capabilityPackRefs.every((ref) => typeof ref.capabilityPackId === "string")).toBe(true);
  });

  it("rejects a config missing a required field", () => {
    const { policyRefs: _policyRefs, ...malformed } = companyConfigFixture;
    expect(CompanyConfigSchema.safeParse(malformed).success).toBe(false);
  });
});
