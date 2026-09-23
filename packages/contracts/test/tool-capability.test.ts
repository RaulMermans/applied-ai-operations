import { describe, expect, it } from "vitest";
import { CapabilitySpecSchema } from "../src/capability.js";
import { ToolSpecSchema } from "../src/tool.js";
import { capabilitySpecFixture, toolSpecFixture } from "./fixtures.js";

describe("ToolSpecSchema", () => {
  it("parses a valid tool spec", () => {
    expect(ToolSpecSchema.safeParse(toolSpecFixture).success).toBe(true);
  });

  it("parses a tool with no capabilityRef (a tool need not bind to a company capability)", () => {
    const { capabilityRef: _capabilityRef, ...localTool } = toolSpecFixture;
    expect(ToolSpecSchema.safeParse({ ...localTool, id: "local.math.calculate" }).success).toBe(true);
  });

  it("rejects a malformed inputSchema (not JSON-safe)", () => {
    expect(ToolSpecSchema.safeParse({ ...toolSpecFixture, inputSchema: { fn: () => 1 } }).success).toBe(false);
  });

  it("rejects a missing permissionClasses field", () => {
    const { permissionClasses: _permissionClasses, ...malformed } = toolSpecFixture;
    expect(ToolSpecSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("CapabilitySpecSchema", () => {
  it("parses a valid capability spec", () => {
    expect(CapabilitySpecSchema.safeParse(capabilitySpecFixture).success).toBe(true);
  });

  it("remains provider-neutral: no vendor-specific field or type is required to validate", () => {
    // The capability id itself is provider-neutral (crm.accounts.search, not
    // hubspot_search_v3 or salesforce_query_sobject).
    expect(capabilitySpecFixture.id).toBe("crm.accounts.search");
    expect(CapabilitySpecSchema.safeParse(capabilitySpecFixture).success).toBe(true);
  });

  it("rejects a malformed outputSchema (not JSON-safe)", () => {
    expect(CapabilitySpecSchema.safeParse({ ...capabilitySpecFixture, outputSchema: { d: new Date() } }).success).toBe(false);
  });
});
