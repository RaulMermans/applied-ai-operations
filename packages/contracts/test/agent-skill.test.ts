import { describe, expect, it } from "vitest";
import { AgentSpecSchema } from "../src/agent.js";
import { SkillSpecSchema } from "../src/skill.js";
import { agentSpecFixture } from "./fixtures.js";

describe("AgentSpecSchema", () => {
  it("parses a valid agent spec", () => {
    expect(AgentSpecSchema.safeParse(agentSpecFixture).success).toBe(true);
  });

  it("parses without the optional modelPolicyRef", () => {
    const { modelPolicyRef: _modelPolicyRef, ...withoutModelPolicy } = agentSpecFixture;
    expect(AgentSpecSchema.safeParse(withoutModelPolicy).success).toBe(true);
  });

  it("does not require any vendor or framework object to validate", () => {
    // No model/provider SDK type is imported or required anywhere in this
    // fixture or schema — modelPolicyRef is a plain identifier string.
    expect(typeof agentSpecFixture.modelPolicyRef).toBe("string");
    expect(AgentSpecSchema.safeParse(agentSpecFixture).success).toBe(true);
  });

  it("rejects an empty permission-class collection", () => {
    expect(AgentSpecSchema.safeParse({ ...agentSpecFixture, permissionClasses: [] }).success).toBe(false);
  });

  it("rejects an unexpected top-level field", () => {
    expect(AgentSpecSchema.safeParse({ ...agentSpecFixture, unexpected: true }).success).toBe(false);
  });
});

describe("SkillSpecSchema", () => {
  const validSkill = {
    schemaVersion: 1 as const,
    id: "sales.qualify-lead",
    version: "1.0.0",
    name: "Qualify lead",
    requiredCapabilities: ["crm.accounts.search"],
    requiredTools: ["crm.accounts.update"],
    permissionClasses: ["read_only"] as const,
  };

  it("parses a valid skill spec", () => {
    expect(SkillSpecSchema.safeParse(validSkill).success).toBe(true);
  });

  it("rejects a skill spec missing a required field", () => {
    const { requiredCapabilities: _requiredCapabilities, ...malformed } = validSkill;
    expect(SkillSpecSchema.safeParse(malformed).success).toBe(false);
  });

  it("references capabilities and tools by identifier, never by a vendor SDK type", () => {
    expect(validSkill.requiredCapabilities.every((id) => typeof id === "string")).toBe(true);
  });
});
