import { describe, expect, it } from "vitest";
import type { ToolSpec } from "@aao/contracts";
import { executeTool } from "../src/executor.js";
import { createToolRegistry } from "../src/registry.js";
import type { ToolExecutionResult, ToolHandler, ToolHandlerContext, ToolHandlerResult } from "../src/types.js";
import { LOOKUP_REF, buildRequest, buildToolSpec, spyHandler } from "./fixtures.js";

/**
 * Registration captures stable, trusted execution behavior. Nothing a caller
 * does to its own objects after registration, or to anything a lookup
 * returns, can change the spec, handler, or schema enforcement that later
 * `executeTool` calls use.
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

const replacement = async (): Promise<ToolHandlerResult> => ({ ok: true, output: { items: ["REPLACED"] } });

describe("Tool Registry binding immutability", () => {
  it("mutating the original ToolSpec after registration does not affect registered behavior", async () => {
    const { spec, tools, handler } = registered();
    spec.permissionClasses.splice(0, 1, "external_side_effect");
    (spec.inputSchema as { required: string[] }).required.push("other");
    (spec.outputSchema as { properties: Record<string, unknown> }).properties.items = { type: "number" };

    const outcome = await executeTool({ request: buildRequest(), tools });
    expect(outcome.ok && outcome.result.output).toEqual({ items: ["alpha-result"] });
    expect(handler.calls).toHaveLength(1);
    expect(tools.get(LOOKUP_REF)?.spec).toEqual(buildToolSpec());
  });

  it("reassigning execute on the original handler object does not replace the captured execution", async () => {
    const { handler, tools } = registered();
    const original = handler.execute;
    (handler as ToolHandler).execute = replacement;

    const outcome = await executeTool({ request: buildRequest(), tools });
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
    const outcome = await executeTool({ request: buildRequest(), tools });
    expect(outcome.ok && outcome.result.output).toEqual({ items: ["p:alpha"] });
  });

  it("a resolved handler cannot be replaced", async () => {
    const { tools, handler } = registered();
    const resolved = tools.get(LOOKUP_REF)!;
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.handler)).toBe(true);
    expect(() => {
      (resolved.handler as { execute: unknown }).execute = replacement;
    }).toThrow(TypeError);
    expect(() => {
      (resolved as { handler: unknown }).handler = { execute: replacement };
    }).toThrow(TypeError);

    const outcome = await executeTool({ request: buildRequest(), tools });
    expect(outcome.ok && outcome.result.output).toEqual({ items: ["alpha-result"] });
    expect(handler.calls).toHaveLength(1);
  });

  it("resolved input validation cannot be replaced; executeTool still enforces the registered inputSchema", async () => {
    const { tools, handler } = registered();
    const resolved = tools.get(LOOKUP_REF)!;
    expect(Object.isFrozen(resolved.inputSchema)).toBe(true);
    expect(() => {
      (resolved.inputSchema as { validate: unknown }).validate = () => ({ ok: true });
    }).toThrow(TypeError);
    expect(() => {
      (resolved as { inputSchema: unknown }).inputSchema = { validate: () => ({ ok: true }) };
    }).toThrow(TypeError);

    expect(failureCode(await executeTool({ request: buildRequest({ input: { wrong: 1 } }), tools }))).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    expect(handler.calls).toHaveLength(0);
  });

  it("resolved output validation cannot be replaced; executeTool still enforces the registered outputSchema", async () => {
    const handler = spyHandler(() => ({ ok: true, output: { items: "not-an-array" } }));
    const tools = createToolRegistry();
    tools.register({ spec: buildToolSpec(), handler });
    const resolved = tools.get(LOOKUP_REF)!;
    expect(Object.isFrozen(resolved.outputSchema)).toBe(true);
    expect(() => {
      (resolved.outputSchema as { validate: unknown }).validate = () => ({ ok: true });
    }).toThrow(TypeError);
    expect(() => {
      (resolved as { outputSchema: unknown }).outputSchema = { validate: () => ({ ok: true }) };
    }).toThrow(TypeError);

    expect(failureCode(await executeTool({ request: buildRequest(), tools }))).toBe("TOOL_OUTPUT_SCHEMA_MISMATCH");
    expect(handler.calls).toHaveLength(1);
  });

  it("mutation attempts through one lookup do not affect later lookups", () => {
    const { tools } = registered();
    const first = tools.get(LOOKUP_REF)!;
    first.spec.permissionClasses.push("destructive");
    try {
      (first.inputSchema as { validate: unknown }).validate = () => ({ ok: true });
    } catch {
      // expected: frozen
    }
    const second = tools.get(LOOKUP_REF)!;
    expect(second.spec).toEqual(buildToolSpec());
    expect(second.inputSchema.validate({ wrong: 1 }).ok).toBe(false);
    expect(second.handler.execute).toBe(first.handler.execute);
  });

  it("executeTool still invokes the originally registered handler after every mutation attempt", async () => {
    const { spec, handler, tools } = registered();
    spec.name = "Mutated";
    (handler as ToolHandler).execute = replacement;
    const resolved = tools.get(LOOKUP_REF)!;
    for (const attempt of [
      () => ((resolved.handler as { execute: unknown }).execute = replacement),
      () => ((resolved.inputSchema as { validate: unknown }).validate = () => ({ ok: true })),
      () => ((resolved.outputSchema as { validate: unknown }).validate = () => ({ ok: true })),
    ]) {
      expect(attempt).toThrow(TypeError);
    }

    const outcome = await executeTool({ request: buildRequest({ input: { query: "beta" } }), tools });
    expect(outcome.ok && outcome.result.output).toEqual({ items: ["beta-result"] });
    expect(failureCode(await executeTool({ request: buildRequest({ input: { query: 1 } }), tools }))).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
  });
});
