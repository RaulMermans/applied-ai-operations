import { describe, expect, it } from "vitest";
import type { PermissionClass } from "@aao/contracts";
import { executeTool } from "../src/executor.js";
import { SUPPORTED_TOOL_PERMISSION_CLASSES, checkToolPermissionSupport } from "../src/permissions.js";
import { buildRequest, lookupWorld } from "./fixtures.js";

/**
 * The Tool Runtime V1 permission *support gate*. This is not actor
 * authorization: it only decides which kinds of Tool this runtime version
 * may execute at all.
 */
describe("permission support gate", () => {
  it("supports exactly read_only and write_draft", () => {
    expect([...SUPPORTED_TOOL_PERMISSION_CLASSES]).toEqual(["read_only", "write_draft"]);
  });

  it.each<[PermissionClass[], PermissionClass[]]>([
    [["read_only"], []],
    [["write_draft"], []],
    [["read_only", "write_draft"], []],
    [["external_side_effect"], ["external_side_effect"]],
    [["destructive"], ["destructive"]],
    [["sensitive_data"], ["sensitive_data"]],
    [["read_only", "sensitive_data"], ["sensitive_data"]],
    [["write_draft", "external_side_effect", "sensitive_data"], ["external_side_effect", "sensitive_data"]],
  ])("%j → unsupported %j", (permissionClasses, unsupported) => {
    const verdict = checkToolPermissionSupport({ permissionClasses });
    expect(verdict).toEqual(unsupported.length === 0 ? { supported: true } : { supported: false, unsupported });
  });

  it.each<[PermissionClass[]]>([[["read_only"]], [["write_draft"]], [["read_only", "write_draft"]]])("direct executeTool runs a %j Tool", async (permissionClasses) => {
    const { tools, handler } = lookupWorld({ spec: { permissionClasses } });
    const outcome = await executeTool({ request: buildRequest(), tools });
    expect(outcome.ok).toBe(true);
    expect(handler.calls).toHaveLength(1);
  });

  it.each<[PermissionClass[]]>([[["external_side_effect"]], [["destructive"]], [["sensitive_data"]], [["read_only", "sensitive_data"]], [["sensitive_data", "read_only"]]])(
    "direct executeTool refuses a registered %j Tool with TOOL_PERMISSION_UNSUPPORTED and zero handler calls",
    async (permissionClasses) => {
      const { tools, handler } = lookupWorld({ spec: { permissionClasses } });
      const outcome = await executeTool({ request: buildRequest(), tools });
      expect(outcome).toEqual({
        ok: false,
        failure: {
          code: "TOOL_PERMISSION_UNSUPPORTED",
          message: 'Tool "local.lookup" version "1.0.0" requires permission classes Tool Runtime V1 does not execute.',
          toolExecutionId: "exec.tool.1",
          toolRef: { id: "local.lookup", version: "1.0.0" },
          unsupportedPermissionClasses: permissionClasses.filter((permissionClass) => permissionClass !== "read_only"),
        },
      });
      expect(handler.calls).toHaveLength(0);
    },
  );

  it("the gate runs before input validation: even invalid input reports the permission failure, never reaching the handler", async () => {
    const { tools, handler } = lookupWorld({ spec: { permissionClasses: ["destructive"] } });
    const outcome = await executeTool({ request: buildRequest({ input: { wrong: true } }), tools });
    expect(!outcome.ok && outcome.failure.code).toBe("TOOL_PERMISSION_UNSUPPORTED");
    expect(handler.calls).toHaveLength(0);
  });
});
