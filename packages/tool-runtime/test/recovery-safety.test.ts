import { describe, expect, it } from "vitest";
import type { PermissionClass, RecoverySafety, RetrySafety, ToolIdempotency } from "@aao/contracts";
import { toolRecoverySafety } from "../src/registry.js";

const spec = (permissionClasses: PermissionClass[]) => ({ schemaVersion: 1 as const, id: "t", version: "1", name: "t", inputSchema: {}, outputSchema: {}, permissionClasses });

describe("toolRecoverySafety (ADR-019)", () => {
  it.each<[PermissionClass[], RetrySafety, ToolIdempotency, RecoverySafety]>([
    [["read_only"], "unsafe", "none", "unsafe"],
    [["read_only"], "safe", "none", "safe"],
    [["read_only"], "unsafe", "execution_id", "safe"],
    [["write_draft"], "unsafe", "none", "unsafe"],
    [["write_draft"], "unsafe", "execution_id", "safe"],
    [["read_only", "write_draft"], "unsafe", "execution_id", "safe"],
    [["external_side_effect"], "unsafe", "execution_id", "unsafe"],
    [["destructive"], "unsafe", "execution_id", "unsafe"],
    [["read_only", "sensitive_data"], "safe", "execution_id", "unsafe"],
  ])("%j retry=%s idempotency=%s → %s", (permissionClasses, retrySafety, idempotency, expected) => {
    expect(toolRecoverySafety({ spec: spec(permissionClasses), retrySafety, idempotency })).toBe(expected);
  });
});
