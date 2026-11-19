import { describe, expect, it } from "vitest";
import { SECURITY_CASES, runSecurityRegressionSuite, type SecurityArea } from "../src/index.js";

const AREAS: readonly SecurityArea[] = ["identity", "company_isolation", "authorization", "approval", "continuation", "replay", "tool_adapter", "model_adapter", "mcp", "control_center", "observability"];

describe("Sprint 29 — security regression suite (ADR-034)", () => {
  it("has unique case ids and covers every threat area", () => {
    expect(new Set(SECURITY_CASES.map((c) => c.id)).size).toBe(SECURITY_CASES.length);
    expect([...new Set(SECURITY_CASES.map((c) => c.area))].sort()).toEqual([...AREAS].sort());
  });

  for (const securityCase of SECURITY_CASES) {
    it(`${securityCase.area} › ${securityCase.id}: ${securityCase.invariant}`, async () => {
      const [result] = await runSecurityRegressionSuite([securityCase]);
      expect(result?.passed, result?.evidence).toBe(true);
    });
  }
});
