import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as toolRuntime from "@aao/tool-runtime";
import { authContext, buildRequest, buildToolSpec, spyHandler, LOOKUP_REF } from "./fixtures.js";

/**
 * Through the actual public package surface, an ordinary Tool Runtime
 * consumer can register, inspect specs, and check presence — but can never
 * obtain an executable handler or a compiled validator. `executeTool` is the
 * only exported path that invokes a registered handler.
 */
function reachableFunctions(root: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, path: string) => {
    if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
    seen.add(value);
    if (typeof value === "function") found.push(path);
    for (const key of Reflect.ownKeys(value as object)) {
      if (typeof value === "function" && ["prototype", "length", "name", "arguments", "caller"].includes(String(key))) continue;
      visit((value as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`);
    }
  };
  visit(root, "$");
  return found;
}

describe("public Tool Registry encapsulation", () => {
  const handler = spyHandler();
  const tools = toolRuntime.createToolRegistry();
  tools.register({ spec: buildToolSpec(), handler });

  it("the public registry exposes only register, getSpec, and has — frozen, with no symbols or hidden fields", () => {
    expect(Reflect.ownKeys(tools).sort()).toEqual(["getSpec", "has", "register"]);
    expect(Object.isFrozen(tools)).toBe(true);
    expect(Object.getOwnPropertySymbols(tools)).toEqual([]);
    expect(() => {
      (tools as { getSpec: unknown }).getSpec = () => undefined;
    }).toThrow(TypeError);
  });

  it("metadata lookup returns plain JSON: no handler, execute, validator, or any function reachable", () => {
    const spec = tools.getSpec(LOOKUP_REF);
    expect(spec).toEqual(buildToolSpec());
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
    expect(reachableFunctions(spec)).toEqual([]);
    expect(reachableFunctions(tools)).toEqual(["$.register", "$.getSpec", "$.has"]);
    expect(tools.has(LOOKUP_REF)).toBe(true);
    expect(handler.calls).toEqual([]);
  });

  it("the package entry point does not export the internal binding resolver or any handler accessor", () => {
    const exported = Object.keys(toolRuntime);
    expect(exported).not.toContain("resolveToolBinding");
    expect(exported.filter((name) => /binding|resolve|handler/i.test(name) && !/Schema$|PATTERN$/.test(name))).toEqual([]);
    expect(exported).toContain("executeTool");
  });

  it("the package exports only its entry point (no deep import of registry internals)", () => {
    const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports)).toEqual(["."]);
  });

  it("executeTool is the path that runs the handler — and only after authorization", async () => {
    const denied = await toolRuntime.executeTool({ request: buildRequest(), tools, authorizationContext: authContext([]) });
    expect(denied.ok).toBe(false);
    expect(handler.calls).toHaveLength(0);
    const allowed = await toolRuntime.executeTool({ request: buildRequest(), tools, authorizationContext: authContext(["read_only"]) });
    expect(allowed.ok).toBe(true);
    expect(handler.calls).toHaveLength(1);
  });

  it("a look-alike registry object cannot be used to inject a handler into executeTool", async () => {
    const fake = { register() {}, has: () => true, getSpec: () => buildToolSpec(), get: () => ({ spec: buildToolSpec(), handler: { execute: async () => ({ ok: true, output: { items: [] } }) } }) };
    await expect(toolRuntime.executeTool({ request: buildRequest(), tools: fake as never, authorizationContext: authContext(["read_only"]) })).rejects.toThrow(/createToolRegistry/);
  });
});
