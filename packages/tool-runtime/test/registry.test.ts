import { describe, expect, it } from "vitest";
import type { JsonObject } from "@aao/contracts";
import { createToolRegistry } from "../src/registry.js";
import { LOOKUP_REF, buildToolSpec, spyHandler } from "./fixtures.js";

describe("Tool Registry", () => {
  it("registers a Tool and resolves it by exact id + version", () => {
    const registry = createToolRegistry();
    const handler = spyHandler();
    registry.register({ spec: buildToolSpec(), handler });
    const resolved = registry.get(LOOKUP_REF);
    expect(resolved?.spec).toEqual(buildToolSpec());
    // Registered behavior, not object identity: the registry holds its own captured handler.
    expect(resolved?.handler).not.toBe(handler);
    expect(typeof resolved?.handler.execute).toBe("function");
    expect(registry.get({ id: LOOKUP_REF.id, version: "1.0.1" })).toBeUndefined();
    expect(registry.get({ id: LOOKUP_REF.id, version: "1" })).toBeUndefined();
    expect(registry.get({ id: "local.lookup2", version: "1.0.0" })).toBeUndefined();
  });

  it("keeps multiple versions of one Tool side by side", () => {
    const registry = createToolRegistry();
    registry.register({ spec: buildToolSpec(), handler: spyHandler() });
    registry.register({ spec: buildToolSpec({ version: "2.0.0", name: "Lookup v2" }), handler: spyHandler() });
    expect(registry.get(LOOKUP_REF)?.spec.name).toBe("Local lookup");
    expect(registry.get({ id: LOOKUP_REF.id, version: "2.0.0" })?.spec.name).toBe("Lookup v2");
  });

  it("rejects duplicate id + version registration", () => {
    const registry = createToolRegistry();
    registry.register({ spec: buildToolSpec(), handler: spyHandler() });
    expect(() => registry.register({ spec: buildToolSpec({ name: "Impostor" }), handler: spyHandler() })).toThrow(/already registered/);
    expect(registry.get(LOOKUP_REF)?.spec.name).toBe("Local lookup");
  });

  it("registry instances are isolated (no global singleton)", () => {
    const a = createToolRegistry();
    const b = createToolRegistry();
    a.register({ spec: buildToolSpec(), handler: spyHandler() });
    expect(a.get(LOOKUP_REF)).toBeDefined();
    expect(b.get(LOOKUP_REF)).toBeUndefined();
    expect(() => b.register({ spec: buildToolSpec(), handler: spyHandler() })).not.toThrow();
  });

  it("registration order is irrelevant", () => {
    const specs = [buildToolSpec(), buildToolSpec({ id: "local.transform" }), buildToolSpec({ id: "local.calculate" })];
    const forward = createToolRegistry();
    const reverse = createToolRegistry();
    for (const spec of specs) forward.register({ spec, handler: spyHandler() });
    for (const spec of [...specs].reverse()) reverse.register({ spec, handler: spyHandler() });
    for (const spec of specs) expect(forward.get(spec)?.spec).toEqual(reverse.get(spec)?.spec);
  });

  it("callers cannot mutate stored specs through the registered object or returned references", () => {
    const registry = createToolRegistry();
    const spec = buildToolSpec({ inputSchema: JSON.parse(JSON.stringify(buildToolSpec().inputSchema)) as JsonObject });
    registry.register({ spec, handler: spyHandler() });
    spec.permissionClasses.push("destructive");
    (spec.inputSchema as { required: string[] }).required.push("other");

    const first = registry.get(LOOKUP_REF)!;
    first.spec.permissionClasses.push("external_side_effect");
    first.spec.name = "Mutated";
    (first.spec.outputSchema as { required: string[] }).required.push("mutated");

    const second = registry.get(LOOKUP_REF)!;
    expect(second.spec).toEqual(buildToolSpec());
    // The compiled schema was built from a private clone too: `other` is still not required.
    expect(second.inputSchema.validate({ query: "alpha" })).toEqual({ ok: true });
  });

  it.each([
    ["non-canonical spec (missing permissionClasses)", { ...buildToolSpec(), permissionClasses: undefined }],
    ["non-canonical spec (unknown field)", { ...buildToolSpec(), handler: "import('evil')" }],
    ["non-canonical spec (empty permission classes)", buildToolSpec({ permissionClasses: [] as never })],
    ["non-JSON-safe spec", { ...buildToolSpec(), inputSchema: { type: "object", created: new Date(0) } }],
  ])("rejects a %s", (_label, spec) => {
    expect(() => createToolRegistry().register({ spec: spec as never, handler: spyHandler() })).toThrow(/canonical ToolSpec/);
  });

  it("rejects a Tool without an executable handler", () => {
    expect(() => createToolRegistry().register({ spec: buildToolSpec(), handler: {} as never })).toThrow(/handler/);
    expect(() => createToolRegistry().register({ spec: buildToolSpec(), handler: undefined as never })).toThrow(/handler/);
  });

  it.each<[string, JsonObject]>([
    ["unknown keyword", { type: "object", properties: { query: { type: "string" } }, colour: "red" }],
    ["invalid keyword value", { type: "object", required: "query" }],
    ["unsupported dialect", { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }],
    ["unknown format", { type: "object", properties: { email: { type: "string", format: "email" } } }],
    ["remote $ref", { $ref: "https://example.com/schema.json" }],
    ["$async schema", { $async: true, type: "object" }],
    ["keyword without matching type (strictTypes)", { properties: { query: { type: "string" } } }],
  ])("rejects an inputSchema with %s at registration (fail closed)", (_label, inputSchema) => {
    const registry = createToolRegistry();
    expect(() => registry.register({ spec: buildToolSpec({ inputSchema }), handler: spyHandler() })).toThrow(/unsupported inputSchema/);
    expect(registry.get(LOOKUP_REF)).toBeUndefined();
  });

  it("rejects an invalid outputSchema at registration (fail closed)", () => {
    const registry = createToolRegistry();
    expect(() => registry.register({ spec: buildToolSpec({ outputSchema: { type: "array", items: { type: "strng" } } }), handler: spyHandler() })).toThrow(/unsupported outputSchema/);
    expect(registry.get(LOOKUP_REF)).toBeUndefined();
  });

  it("registers Tools whose permission classes V1 cannot execute — registered ≠ executable ≠ authorized", () => {
    const registry = createToolRegistry();
    registry.register({ spec: buildToolSpec({ permissionClasses: ["external_side_effect"] }), handler: spyHandler() });
    expect(registry.get(LOOKUP_REF)?.spec.permissionClasses).toEqual(["external_side_effect"]);
  });
});
