import { describe, expect, it } from "vitest";
import { validateModelRequest } from "../src/request.js";
import { buildStructuredRequest, buildTextRequest } from "./fixtures.js";

function expectInvalid(value: unknown) {
  const result = validateModelRequest(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe("INVALID_MODEL_REQUEST");
}

describe("validateModelRequest", () => {
  it("accepts a valid text request", () => {
    expect(validateModelRequest(buildTextRequest())).toEqual({ ok: true, request: buildTextRequest() });
  });

  it("accepts a valid structured request", () => {
    expect(validateModelRequest(buildStructuredRequest()).ok).toBe(true);
  });

  it.each([
    ["missing invocationId", { ...buildTextRequest(), invocationId: undefined }],
    ["empty message list", buildTextRequest({ messages: [] })],
    ["no user message", buildTextRequest({ messages: [{ role: "system", content: "x" }] })],
    ["malformed role", { ...buildTextRequest(), messages: [{ role: "tool", content: "x" }] }],
    ["non-string content", { ...buildTextRequest(), messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }],
    ["empty content", buildTextRequest({ messages: [{ role: "user", content: "" }] })],
    ["unknown output kind", { ...buildTextRequest(), output: { kind: "stream" } }],
    ["structured output without schema", { ...buildTextRequest(), output: { kind: "structured" } }],
    ["zero token limit", buildTextRequest({ maxOutputTokens: 0 })],
    ["fractional token limit", buildTextRequest({ maxOutputTokens: 1.5 })],
    ["absurd token limit", buildTextRequest({ maxOutputTokens: 10_000_000 })],
    ["unknown required capability", { ...buildTextRequest(), requiredCapabilities: ["model.tool_calling"] }],
    ["non-array required capabilities", { ...buildTextRequest(), requiredCapabilities: "model.text_generation" }],
    ["unknown top-level field (e.g. provider)", { ...buildTextRequest(), provider: "openai" }],
    ["wrong schemaVersion", { ...buildTextRequest(), schemaVersion: 2 }],
  ])("rejects %s", (_label, value) => {
    expectInvalid(value);
  });

  it("rejects non-JSON-safe requests (function, Date, NaN, Infinity) via canonical isJsonSafe", () => {
    expectInvalid({ ...buildTextRequest(), extra: () => 1 });
    expectInvalid({ ...buildTextRequest(), messages: [{ role: "user", content: new Date() }] });
    expectInvalid(buildTextRequest({ maxOutputTokens: Number.NaN }));
    expectInvalid(buildTextRequest({ maxOutputTokens: Number.POSITIVE_INFINITY }));
    expectInvalid({ ...buildStructuredRequest(), output: { kind: "structured", schema: { type: "object", properties: new Map() } } });
  });

  it("rejects a structured schema that is JSON but not a valid strict JSON Schema", () => {
    expectInvalid(buildStructuredRequest({ output: { kind: "structured", schema: { type: "object", properties: { a: { type: "strng" } } } } }));
    expectInvalid(buildStructuredRequest({ output: { kind: "structured", schema: { type: "object", unknownKeyword: true } } }));
  });

  it("rejects a structured schema whose top level is not an object", () => {
    expectInvalid(buildStructuredRequest({ output: { kind: "structured", schema: { type: "string" } } }));
  });

  it("reports safe, deterministic issues", () => {
    const result = validateModelRequest(buildTextRequest({ messages: [] }));
    expect(result).toEqual({
      ok: false,
      failure: { code: "INVALID_MODEL_REQUEST", message: "Model request does not match ModelRequestSchema.", details: { issues: ["messages: Array must contain at least 1 element(s)", "messages: messages must include at least one user message"] } },
    });
  });
});
