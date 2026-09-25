import { describe, expect, it } from "vitest";
import type { ToolSpec } from "@aao/contracts";
import { executeTool } from "../src/executor.js";
import { createToolRegistry, resolveToolBinding, type ToolRegistry } from "../src/registry.js";
import type { ToolExecutionResult, ToolHandler, ToolHandlerContext, ToolHandlerResult } from "../src/types.js";
import { LOOKUP_REF, SUPPORTED_GRANTS, buildRequest, buildToolSpec, spyHandler } from "./fixtures.js";

/**
 * Registration captures stable, trusted execution behavior. Nothing a caller
 * does to its own objects after registration, or to anything a lookup
 * returns, can change the spec, handler, or schema enforcement that later
 * `executeTool` calls use. Public lookups (`getSpec`) expose only a spec
 * clone; the internal binding `executeTool` resolves is itself frozen, which
 * these tests check through the Tool Runtime-internal `resolveToolBinding`.
 */
function failureCode(outcome: ToolExecutionResult): string | undefined {
  return outcome.ok ? undefined : outcome.failure.code;
}

function registered() {
  // A deep private copy, so mutating it cannot pollute the shared fixture schemas.
  const spec = JSON.parse(JSON.stringify(buildToolSpec())) as ToolSpec;
  const handler = spyHandler();
  const tools = createToolRegistry();
  tools.register({ spec, handler });
  return { spec, handler, tools };
}

const run = (tools: ToolRegistry, request: unknown = buildRequest()) => executeTool({ request, tools, authorizationContext: SUPPORTED_GRANTS });
const binding = (tools: ToolRegistry) => resolveToolBinding(tools, LOOKUP_REF)!;

const replacement = async (): Promise<ToolHandlerResult> => ({ ok: true, output: { items: ["REPLACED"] } });

describe("Tool Registry binding immutability", () => {
  it("mutating the original ToolSpec after registration does not affect registered behavior", async () => {
    const { spec, tools, handler } = registered();
    spec.permissionClasses.splice(0, 1, "external_side_effect");
    (spec.inputSchema as { required: string[] }).required.push("other");
    (spec.outputSchema as { properties: Record<string, unknown> }).properties.items = { type: "number" };

    const outcome = await run(tools);
    expect(outcome.ok && outcome.result.output).toEqual({ items: ["alpha-result"] });
    expect(handler.calls).toHaveLength(1);
    expect(tools.getSpec(LOOKUP_REF)).toEqual(buildToolSpec());
  });

  it("reassigning execute on the original handler object does not replace the captured execution", async () => {
    const { handler, tools } = registered();
    const original = handler.execute;
    (handler as ToolHandler).execute = replacement;

    const outcome = await run(tools);
    expect(outcome.ok && outcome.result.output).toEqual({ items: ["alpha-result"] });
    // The original handler object is untouched by registration: only the caller's own reassignment changed it.
    expect(handler.execute).toBe(replacement);
    expect(original).not.toBe(replacement);
  });

  it("registration leaves the original handler object untouched and preserves `this` semantics", async () => {
    class PrefixHandler implements ToolHandler {
      constructor(private readonly prefix: string) {}
      async execute(context: ToolHandlerContext): Promise<ToolHandlerResult> {
        return { ok: true, output: { items: [`${this.prefix}:${(context.input as { query: string }).query}`] } };
      }
    }
    const handler = new PrefixHandler("p");
    const tools = createToolRegistry();
    tools.register({ spec: buildToolSpec(), handler });
    expect(Object.isFrozen(handler)).toBe(false);
    expect(Object.keys(handler)).toEqual(["prefix"]);
    const outcome = await run(tools);
    expect(outcome.ok && outcome.result.output).toEqual({ items: ["p:alpha"] });
  });

  it("a resolved handler cannot be replaced", async () => {
    const { tools, handler } = registered();
    const resolved = binding(tools);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.handler)).toBe(true);
    expect(() => {
      (resolved.handler as { execute: unknown }).execute = replacement;
    }).toThrow(TypeError);
    expect(() => {
      (resolved as { handler: unknown }).handler = { execute: replacement };
    }).toThrow(TypeError);

    const outcome = await run(tools);
    expect(outcome.ok && outcome.result.output).toEqual({ items: ["alpha-result"] });
    expect(handler.calls).toHaveLength(1);
  });

  it("resolved input validation cannot be replaced; executeTool still enforces the registered inputSchema", async () => {
    const { tools, handler } = registered();
    const resolved = binding(tools);
    expect(Object.isFrozen(resolved.inputSchema)).toBe(true);
    expect(() => {
      (resolved.inputSchema as { validate: unknown }).validate = () => ({ ok: true });
    }).toThrow(TypeError);
    expect(() => {
      (resolved as { inputSchema: unknown }).inputSchema = { validate: () => ({ ok: true }) };
    }).toThrow(TypeError);

    expect(failureCode(await run(tools, buildRequest({ input: { wrong: 1 } })))).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    expect(handler.calls).toHaveLength(0);
  });

  it("resolved output validation cannot be replaced; executeTool still enforces the registered outputSchema", async () => {
    const handler = spyHandler(() => ({ ok: true, output: { items: "not-an-array" } }));
    const tools = createToolRegistry();
    tools.register({ spec: buildToolSpec(), handler });
    const resolved = binding(tools);
    expect(Object.isFrozen(resolved.outputSchema)).toBe(true);
    expect(() => {
      (resolved.outputSchema as { validate: unknown }).validate = () => ({ ok: true });
    }).toThrow(TypeError);
    expect(() => {
      (resolved as { outputSchema: unknown }).outputSchema = { validate: () => ({ ok: true }) };
    }).toThrow(TypeError);

    expect(failureCode(await run(tools))).toBe("TOOL_OUTPUT_SCHEMA_MISMATCH");
    expect(handler.calls).toHaveLength(1);
  });

  it("mutation attempts through one lookup do not affect later lookups", () => {
    const { tools } = registered();
    tools.getSpec(LOOKUP_REF)!.permissionClasses.push("destructive");
    const first = binding(tools);
    // Even the internal binding's stored spec is deep-frozen.
    expect(() => first.spec.permissionClasses.push("destructive")).toThrow(TypeError);
    expect(() => {
      (first.spec.inputSchema as { required: string[] }).required = [];
    }).toThrow(TypeError);
    try {
      (first.inputSchema as { validate: unknown }).validate = () => ({ ok: true });
    } catch {
      // expected: frozen
    }
    const second = binding(tools);
    expect(second.spec).toEqual(buildToolSpec());
    expect(second.inputSchema.validate({ wrong: 1 }).ok).toBe(false);
    expect(second.handler.execute).toBe(first.handler.execute);
  });

  it("executeTool still invokes the originally registered handler after every mutation attempt", async () => {
    const { spec, handler, tools } = registered();
    spec.name = "Mutated";
    (handler as ToolHandler).execute = replacement;
    const resolved = binding(tools);
    for (const attempt of [
      () => ((resolved.handler as { execute: unknown }).execute = replacement),
      () => ((resolved.inputSchema as { validate: unknown }).validate = () => ({ ok: true })),
      () => ((resolved.outputSchema as { validate: unknown }).validate = () => ({ ok: true })),
    ]) {
      expect(attempt).toThrow(TypeError);
    }

    const outcome = await run(tools, buildRequest({ input: { query: "beta" } }));
    expect(outcome.ok && outcome.result.output).toEqual({ items: ["beta-result"] });
    expect(failureCode(await run(tools, buildRequest({ input: { query: 1 } })))).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
  });
});
