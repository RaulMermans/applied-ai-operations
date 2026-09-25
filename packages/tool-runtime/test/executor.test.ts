import { describe, expect, it } from "vitest";
import type { JsonObject } from "@aao/contracts";
import { executeTool } from "../src/executor.js";
import { ToolExecutionRequestSchema, ToolFailureSchema, ToolResultSchema, type ToolExecutionResult, type ToolHandlerResult } from "../src/types.js";
import { LOOKUP_REF, SECRET, buildRequest, buildToolSpec, lookupWorld } from "./fixtures.js";

function expectFailure(outcome: ToolExecutionResult) {
  if (outcome.ok) throw new Error(`expected failure, got ${JSON.stringify(outcome.result)}`);
  return outcome.failure;
}

function expectSuccess(outcome: ToolExecutionResult) {
  if (!outcome.ok) throw new Error(`expected success, got ${JSON.stringify(outcome.failure)}`);
  return outcome.result;
}

describe("executeTool — success", () => {
  it("validates, invokes the handler exactly once, validates output, and returns a JSON-safe ToolResult", async () => {
    const { tools, handler } = lookupWorld();
    const result = expectSuccess(await executeTool({ request: buildRequest(), tools }));
    expect(result).toEqual({ schemaVersion: 1, toolExecutionId: "exec.tool.1", toolRef: { ...LOOKUP_REF }, output: { items: ["alpha-result"] } });
    expect(handler.calls).toEqual([{ toolExecutionId: "exec.tool.1", tool: { ...LOOKUP_REF }, input: { query: "alpha" } }]);
    expect(ToolResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("the handler receives a clone: mutating its input cannot affect the caller's request", async () => {
    const request = buildRequest();
    const { tools } = lookupWorld({
      respond: (context) => {
        (context.input as { query: string }).query = "mutated";
        return { ok: true, output: { items: [] } };
      },
    });
    expectSuccess(await executeTool({ request, tools }));
    expect(request.input).toEqual({ query: "alpha" });
  });

  it("the result does not alias handler output", async () => {
    const shared = { items: ["alpha-result"] };
    const { tools } = lookupWorld({ respond: () => ({ ok: true, output: shared }) });
    const result = expectSuccess(await executeTool({ request: buildRequest(), tools }));
    shared.items.push("late");
    expect(result.output).toEqual({ items: ["alpha-result"] });
  });

  it("is deterministic for the same request, registry, and deterministic handler", async () => {
    const { tools } = lookupWorld();
    const first = await executeTool({ request: buildRequest(), tools });
    const second = await executeTool({ request: buildRequest(), tools });
    expect(second).toEqual(first);
  });

  it("keeps no memory between calls", async () => {
    const { tools, handler } = lookupWorld();
    await executeTool({ request: buildRequest({ toolExecutionId: "exec.a", input: { query: "one" } }), tools });
    await executeTool({ request: buildRequest({ toolExecutionId: "exec.b", input: { query: "two" } }), tools });
    expect(handler.calls.map((call) => call.input)).toEqual([{ query: "one" }, { query: "two" }]);
    expect(handler.calls[1]).not.toHaveProperty("history");
  });
});

describe("executeTool — request validation", () => {
  it.each<[string, unknown]>([
    ["non-object request", "local.lookup"],
    ["missing schemaVersion", { ...buildRequest(), schemaVersion: undefined }],
    ["wrong schemaVersion", buildRequest({ schemaVersion: 2 })],
    ["missing toolExecutionId", { ...buildRequest(), toolExecutionId: undefined }],
    ["invalid toolExecutionId (whitespace)", buildRequest({ toolExecutionId: "exec tool" })],
    ["over-long toolExecutionId", buildRequest({ toolExecutionId: "x".repeat(257) })],
    ["toolRef without version", buildRequest({ toolRef: { id: "local.lookup" } })],
    ["toolRef with invalid id", buildRequest({ toolRef: { id: "../local", version: "1.0.0" } })],
    ["toolRef with unknown field", buildRequest({ toolRef: { ...LOOKUP_REF, latest: true } })],
    ["missing input", { schemaVersion: 1, toolExecutionId: "exec.tool.1", toolRef: { ...LOOKUP_REF } }],
    ["unknown field (handler smuggling)", buildRequest({ handler: "module:./evil.js" })],
    ["unknown field (credentials)", buildRequest({ credentials: { token: "x" } })],
    ["function input", buildRequest({ input: () => "alpha" })],
    ["Date input", buildRequest({ input: new Date(0) })],
    ["Map input", buildRequest({ input: new Map([["query", "alpha"]]) })],
    ["Set input", buildRequest({ input: new Set(["alpha"]) })],
    ["class-instance input", buildRequest({ input: new (class Query { query = "alpha"; })() })],
    ["NaN input", buildRequest({ input: { query: Number.NaN } })],
    ["Infinity input", buildRequest({ input: { count: Number.POSITIVE_INFINITY } })],
    ["-Infinity input", buildRequest({ input: { count: Number.NEGATIVE_INFINITY } })],
  ])("%s → INVALID_TOOL_REQUEST; handler never called", async (_label, request) => {
    const { tools, handler } = lookupWorld();
    const failure = expectFailure(await executeTool({ request, tools }));
    expect(failure.code).toBe("INVALID_TOOL_REQUEST");
    expect(handler.calls).toHaveLength(0);
    expect(ToolFailureSchema.parse(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
  });

  it("accepts a valid request per ToolExecutionRequestSchema", () => {
    expect(ToolExecutionRequestSchema.safeParse(buildRequest()).success).toBe(true);
    expect(ToolExecutionRequestSchema.safeParse(buildRequest({ input: null })).success).toBe(true);
  });

  it("unregistered Tool or version → TOOL_NOT_FOUND; no \"latest\" resolution", async () => {
    const { tools, handler } = lookupWorld();
    for (const toolRef of [{ id: "local.missing", version: "1.0.0" }, { id: LOOKUP_REF.id, version: "latest" }, { id: LOOKUP_REF.id, version: "1.0" }]) {
      const failure = expectFailure(await executeTool({ request: buildRequest({ toolRef }), tools }));
      expect(failure).toEqual({ code: "TOOL_NOT_FOUND", message: `Tool "${toolRef.id}" version "${toolRef.version}" is not registered.`, toolExecutionId: "exec.tool.1", toolRef });
    }
    expect(handler.calls).toHaveLength(0);
  });
});

describe("executeTool — input schema", () => {
  const NESTED_INPUT: JsonObject = {
    type: "object",
    properties: {
      query: { type: "string" },
      filter: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1 }, tags: { type: "array", items: { type: "string" } } },
        required: ["limit"],
        additionalProperties: false,
      },
    },
    required: ["query", "filter"],
    additionalProperties: false,
  };

  it.each<[string, unknown, string]>([
    ["missing required field", {}, "(root): must have required property 'query'"],
    ["wrong primitive type", { query: 42 }, "/query: must be string"],
    ["empty string below minLength", { query: "" }, "/query: must NOT have fewer than 1 characters"],
    ["additional property", { query: "alpha", extra: true }, "(root): must NOT have additional properties"],
    ["non-object input", "alpha", "(root): must be object"],
    ["null input", null, "(root): must be object"],
  ])("%s → TOOL_INPUT_SCHEMA_MISMATCH before the handler; zero calls", async (_label, input, issue) => {
    const { tools, handler } = lookupWorld();
    const failure = expectFailure(await executeTool({ request: buildRequest({ input }), tools }));
    expect(failure).toEqual({
      code: "TOOL_INPUT_SCHEMA_MISMATCH",
      message: "Tool input does not match the Tool's inputSchema.",
      toolExecutionId: "exec.tool.1",
      toolRef: { ...LOOKUP_REF },
      issues: [issue],
    });
    expect(handler.calls).toHaveLength(0);
  });

  it("enforces nested object schemas", async () => {
    const { tools, handler } = lookupWorld({ spec: { inputSchema: NESTED_INPUT } });
    expect(expectFailure(await executeTool({ request: buildRequest({ input: { query: "a", filter: { limit: 0 } } }), tools })).issues).toEqual(["/filter/limit: must be >= 1"]);
    expect(expectFailure(await executeTool({ request: buildRequest({ input: { query: "a", filter: { limit: 1, tags: [1] } } }), tools })).issues).toEqual(["/filter/tags/0: must be string"]);
    expect(expectFailure(await executeTool({ request: buildRequest({ input: { query: "a", filter: { limit: 1, x: 1 } } }), tools })).code).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    expect(handler.calls).toHaveLength(0);
    expectSuccess(await executeTool({ request: buildRequest({ input: { query: "a", filter: { limit: 2, tags: ["t"] } } }), tools }));
    expect(handler.calls).toHaveLength(1);
  });

  it("an input-mismatch report never echoes input values", async () => {
    const { tools } = lookupWorld({ spec: { inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 3 } } } } });
    const failure = expectFailure(await executeTool({ request: buildRequest({ input: { query: SECRET } }), tools }));
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("allows additional properties when the Tool's schema does", async () => {
    const { tools } = lookupWorld({ spec: { inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } });
    expectSuccess(await executeTool({ request: buildRequest({ input: { query: "alpha", extra: true } }), tools }));
  });
});

describe("executeTool — handler output", () => {
  it.each<[string, unknown]>([
    ["missing required output field", { ok: true, output: {} }],
    ["wrong nested type", { ok: true, output: { items: [1, 2] } }],
    ["additional output property", { ok: true, output: { items: [], raw: { headers: { authorization: "Bearer x" } } } }],
    ["wrong top-level type", { ok: true, output: ["alpha-result"] }],
  ])("%s → TOOL_OUTPUT_SCHEMA_MISMATCH after exactly one call; nothing returned as success", async (_label, response) => {
    const { tools, handler } = lookupWorld({ respond: () => response as ToolHandlerResult });
    const failure = expectFailure(await executeTool({ request: buildRequest(), tools }));
    expect(failure).toEqual({ code: "TOOL_OUTPUT_SCHEMA_MISMATCH", message: "Tool output does not match the Tool's outputSchema.", toolExecutionId: "exec.tool.1", toolRef: { ...LOOKUP_REF } });
    expect(handler.calls).toHaveLength(1);
    expect(JSON.stringify(failure)).not.toMatch(/Bearer|headers/);
  });

  it.each<[string, unknown]>([
    ["function output", { ok: true, output: () => 1 }],
    ["Date output", { ok: true, output: new Date(0) }],
    ["Map output", { ok: true, output: new Map() }],
    ["Set output", { ok: true, output: new Set() }],
    ["class-instance output", { ok: true, output: new (class Items { items = []; })() }],
    ["NaN output", { ok: true, output: { items: [], score: Number.NaN } }],
    ["Infinity output", { ok: true, output: Number.POSITIVE_INFINITY }],
    ["-Infinity output", { ok: true, output: Number.NEGATIVE_INFINITY }],
    ["undefined output", { ok: true, output: undefined }],
    ["missing output", { ok: true }],
  ])("%s → INVALID_TOOL_RESULT (before output schema validation)", async (_label, response) => {
    const { tools, handler } = lookupWorld({ respond: () => response as ToolHandlerResult });
    const failure = expectFailure(await executeTool({ request: buildRequest(), tools }));
    expect(failure.code).toBe("INVALID_TOOL_RESULT");
    expect(handler.calls).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["a bare value", { items: ["alpha-result"] }],
    ["no ok discriminant", { output: { items: [] } }],
    ["success with extra metadata", { ok: true, output: { items: [] }, headers: { "set-cookie": "x" } }],
    ["failure with a message", { ok: false, code: "NOT_FOUND", message: SECRET }],
    ["failure with nested details", { ok: false, code: "NOT_FOUND", details: { response: SECRET } }],
    ["failure with free-text code", { ok: false, code: SECRET }],
    ["failure with lowercase code", { ok: false, code: "not_found" }],
    ["failure with over-long code", { ok: false, code: `E${"X".repeat(64)}` }],
    ["failure carrying an Error", { ok: false, code: new Error(SECRET) }],
  ])("malformed handler result (%s) → INVALID_TOOL_RESULT; nothing of it is exposed", async (_label, response) => {
    const { tools } = lookupWorld({ respond: () => response as ToolHandlerResult });
    const failure = expectFailure(await executeTool({ request: buildRequest(), tools }));
    expect(failure).toEqual({ code: "INVALID_TOOL_RESULT", message: "Tool handler returned a malformed result.", toolExecutionId: "exec.tool.1", toolRef: { ...LOOKUP_REF } });
    expect(JSON.stringify(failure)).not.toMatch(/secret|cookie|internal\.example/i);
  });
});

describe("executeTool — handler failure", () => {
  it("an explicit safe handler failure → TOOL_EXECUTION_FAILED + handlerFailureCode; exactly one call, no retry", async () => {
    const { tools, handler } = lookupWorld({ respond: () => ({ ok: false, code: "NOT_FOUND" }) });
    const failure = expectFailure(await executeTool({ request: buildRequest(), tools }));
    expect(failure).toEqual({
      code: "TOOL_EXECUTION_FAILED",
      message: 'Tool "local.lookup" version "1.0.0" handler reported a failure.',
      toolExecutionId: "exec.tool.1",
      toolRef: { ...LOOKUP_REF },
      handlerFailureCode: "NOT_FOUND",
    });
    expect(handler.calls).toHaveLength(1);
    expect(ToolFailureSchema.parse(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
  });

  it.each<[string, () => never]>([
    ["an Error with a secret", () => { throw new Error(SECRET); }],
    ["a non-Error value", () => { throw { token: SECRET, stack: "at internal" }; }],
    ["a string", () => { throw SECRET; }],
  ])("a handler throwing %s → generic TOOL_EXECUTION_FAILED, fully redacted, exactly one call", async (_label, thrower) => {
    const { tools, handler } = lookupWorld({ respond: thrower });
    const failure = expectFailure(await executeTool({ request: buildRequest(), tools }));
    expect(failure).toEqual({ code: "TOOL_EXECUTION_FAILED", message: 'Tool "local.lookup" version "1.0.0" handler failed.', toolExecutionId: "exec.tool.1", toolRef: { ...LOOKUP_REF } });
    expect(failure).not.toHaveProperty("handlerFailureCode");
    expect(handler.calls).toHaveLength(1);
    expect(JSON.stringify(failure)).not.toMatch(/secret|token|internal|stack|https?:/i);
  });

  it("a rejected promise is redacted the same way", async () => {
    const { tools } = lookupWorld({ respond: () => Promise.reject(new Error(SECRET)) });
    const failure = expectFailure(await executeTool({ request: buildRequest(), tools }));
    expect(failure.code).toBe("TOOL_EXECUTION_FAILED");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("no retry: one failing request is one handler call, and a later request is a fresh single call", async () => {
    let calls = 0;
    const { tools, handler } = lookupWorld({
      respond: () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return { ok: true, output: { items: ["second"] } };
      },
    });
    expectFailure(await executeTool({ request: buildRequest(), tools }));
    expect(handler.calls).toHaveLength(1);
    expectSuccess(await executeTool({ request: buildRequest({ toolExecutionId: "exec.tool.2" }), tools }));
    expect(handler.calls).toHaveLength(2);
  });
});

describe("serialization", () => {
  it("request, result, and failures round-trip through JSON; no handler or registry appears", async () => {
    const request = ToolExecutionRequestSchema.parse(buildRequest());
    expect(ToolExecutionRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);

    const { tools } = lookupWorld();
    const success = await executeTool({ request, tools });
    expect(JSON.parse(JSON.stringify(success))).toEqual(success);
    expect(JSON.stringify(success)).not.toMatch(/handler|execute|inputSchema|outputSchema/);

    const failed = lookupWorld({ respond: () => ({ ok: false, code: "RATE_LIMITED" }) });
    const failure = await executeTool({ request, tools: failed.tools });
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure);
    expect(!failure.ok && ToolFailureSchema.parse(JSON.parse(JSON.stringify(failure.failure)))).toEqual(!failure.ok && failure.failure);
  });

  it("ToolResultSchema rejects unknown fields (e.g. raw provider metadata)", () => {
    expect(ToolResultSchema.safeParse({ schemaVersion: 1, toolExecutionId: "exec.tool.1", toolRef: { ...LOOKUP_REF }, output: {}, headers: {} }).success).toBe(false);
    expect(ToolResultSchema.safeParse({ schemaVersion: 1, toolExecutionId: "exec.tool.1", toolRef: { ...LOOKUP_REF } }).success).toBe(false);
  });

  it("the ToolSpec used for execution stays canonical", () => {
    expect(buildToolSpec()).not.toHaveProperty("handler");
  });
});
