import { describe, expect, it } from "vitest";
import { PermissionClassSchema, PermissionClassesSchema, PolicyDecisionSchema, PolicyDecisionValueSchema } from "../src/governance.js";

const CANONICAL_PERMISSION_CLASSES = ["read_only", "write_draft", "external_side_effect", "destructive", "sensitive_data"] as const;

describe("PermissionClassSchema", () => {
  it.each(CANONICAL_PERMISSION_CLASSES.map((permissionClass) => [permissionClass]))(
    "accepts canonical permission class %s",
    (permissionClass) => {
      expect(PermissionClassSchema.safeParse(permissionClass).success).toBe(true);
    },
  );

  it("rejects an invalid permission class", () => {
    expect(PermissionClassSchema.safeParse("admin").success).toBe(false);
  });
});

describe("PermissionClassesSchema", () => {
  it("accepts external_side_effect combined with sensitive_data", () => {
    expect(PermissionClassesSchema.safeParse(["external_side_effect", "sensitive_data"]).success).toBe(true);
  });

  it("rejects duplicate permission entries", () => {
    expect(PermissionClassesSchema.safeParse(["read_only", "read_only"]).success).toBe(false);
  });

  it("rejects an empty collection", () => {
    expect(PermissionClassesSchema.safeParse([]).success).toBe(false);
  });
});

describe("PolicyDecisionSchema", () => {
  it.each((["ALLOW", "DENY", "REQUIRE_APPROVAL"] as const).map((decision) => [decision]))(
    "accepts canonical decision value %s",
    (decision) => {
      expect(PolicyDecisionValueSchema.safeParse(decision).success).toBe(true);
    },
  );

  it("parses a minimal decision", () => {
    expect(PolicyDecisionSchema.safeParse({ decision: "ALLOW" }).success).toBe(true);
  });

  it("parses a decision with policy refs and reason codes", () => {
    expect(
      PolicyDecisionSchema.safeParse({
        decision: "REQUIRE_APPROVAL",
        policyRefs: ["default.approval-policy"],
        reasonCodes: ["external_side_effect_requires_approval"],
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid decision value", () => {
    expect(PolicyDecisionSchema.safeParse({ decision: "MAYBE" }).success).toBe(false);
  });
});
