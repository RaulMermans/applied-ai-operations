import { describe, expect, it } from "vitest";
import { executeModelRequest } from "../src/executor.js";
import { ModelFailureSchema, ModelRequestSchema, ModelResultSchema, type ModelExecutionResult } from "../src/types.js";
import { TEXT_AND_STRUCTURED, TEXT_ONLY, buildPolicy, buildRegistries, buildStructuredRequest, buildTextRequest, spyAdapter, succeeded } from "./fixtures.js";

const SECRET = "sk-live-SECRET https://api.example.com/v1?key=abc Authorization: Bearer xyz";

function failureOf(result: ModelExecutionResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  return result.failure;
}

describe("executeModelRequest — success", () => {
  it("text: routes, invokes the selected adapter once, and returns a normalized ModelResult", async () => {
    const fast = spyAdapter(succeeded("Hello!", { finishReason: "stop", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }));
    const structured = spyAdapter(succeeded("unused"));
    const registries = buildRegistries([
      { id: "local.fast", priority: 20, capabilities: TEXT_ONLY, adapter: fast },
      { id: "local.structured", priority: 10, capabilities: TEXT_AND_STRUCTURED, adapter: structured },
    ]);
    const result = await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries });
    expect(result).toEqual({
      ok: true,
      result: {
        schemaVersion: 1,
        invocationId: "inv.text.1",
        modelBindingId: "local.fast",
        outputKind: "text",
        output: "Hello!",
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      },
    });
    expect(fast.calls).toEqual([{ messages: buildTextRequest().messages, output: { kind: "text" } }]);
    expect(structured.calls).toHaveLength(0);
  });

  it("structured: excludes text-only bindings and validates the object against the schema", async () => {
    const fast = spyAdapter(succeeded("unused"));
    const structured = spyAdapter(succeeded({ category: "research" }, { finishReason: "stop" }));
    const registries = buildRegistries([
      { id: "local.fast", priority: 20, capabilities: TEXT_ONLY, adapter: fast },
      { id: "local.structured", priority: 10, capabilities: TEXT_AND_STRUCTURED, adapter: structured },
    ]);
    const result = await executeModelRequest({ request: buildStructuredRequest({ maxOutputTokens: 64 }), modelPolicyRef: "policy.default", ...registries });
    expect(result.ok && result.result).toMatchObject({ modelBindingId: "local.structured", outputKind: "structured", output: { category: "research" } });
    expect(structured.calls[0]?.maxOutputTokens).toBe(64);
    expect(fast.calls).toHaveLength(0);
  });

  it("a policy-required capability participates in routing", async () => {
    const fast = spyAdapter(succeeded("from fast"));
    const structured = spyAdapter(succeeded("from structured"));
    const registries = buildRegistries(
      [
        { id: "local.fast", priority: 20, capabilities: TEXT_ONLY, adapter: fast },
        { id: "local.structured", priority: 10, capabilities: TEXT_AND_STRUCTURED, adapter: structured },
      ],
      [buildPolicy({ id: "policy.strict", requiredCapabilities: ["model.structured_output"] })],
    );
    const result = await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.strict", ...registries });
    expect(result.ok && result.result.modelBindingId).toBe("local.structured");
  });

  it("a request-required capability participates in routing", async () => {
    const registries = buildRegistries([
      { id: "local.fast", priority: 20, capabilities: TEXT_ONLY, adapter: spyAdapter(succeeded("a")) },
      { id: "local.structured", priority: 10, capabilities: TEXT_AND_STRUCTURED, adapter: spyAdapter(succeeded("b")) },
    ]);
    const request = buildTextRequest({ requiredCapabilities: ["model.structured_output"] });
    const result = await executeModelRequest({ request, modelPolicyRef: "policy.default", ...registries });
    expect(result.ok && result.result.modelBindingId).toBe("local.structured");
  });

  it("omits usage/finishReason when the adapter does not report them", async () => {
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter: spyAdapter(succeeded("x", { usage: {} })) }]);
    const result = await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries });
    expect(result.ok && result.result).toEqual({ schemaVersion: 1, invocationId: "inv.text.1", modelBindingId: "m", outputKind: "text", output: "x" });
  });
});

describe("executeModelRequest — failures before invocation", () => {
  it("INVALID_MODEL_REQUEST invokes no adapter", async () => {
    const adapter = spyAdapter(succeeded("x"));
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter }]);
    const failure = failureOf(await executeModelRequest({ request: { nope: true }, modelPolicyRef: "policy.default", ...registries }));
    expect(failure.code).toBe("INVALID_MODEL_REQUEST");
    expect(adapter.calls).toHaveLength(0);
  });

  it("MODEL_POLICY_NOT_FOUND invokes no adapter", async () => {
    const adapter = spyAdapter(succeeded("x"));
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter }]);
    const failure = failureOf(await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.missing", ...registries }));
    expect(failure).toEqual({ code: "MODEL_POLICY_NOT_FOUND", message: 'Model policy "policy.missing" is not registered.', invocationId: "inv.text.1" });
    expect(adapter.calls).toHaveLength(0);
  });

  it("UNSUPPORTED_MODEL_POLICY_CONSTRAINTS fails closed and invokes no adapter", async () => {
    const adapter = spyAdapter(succeeded("x"));
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter }], [buildPolicy({ constraints: { region: "eu" } })]);
    const failure = failureOf(await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries }));
    expect(failure.code).toBe("UNSUPPORTED_MODEL_POLICY_CONSTRAINTS");
    expect(adapter.calls).toHaveLength(0);
  });

  it("empty constraints are supported", async () => {
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter: spyAdapter(succeeded("x")) }], [buildPolicy({ constraints: {} })]);
    expect((await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries })).ok).toBe(true);
  });

  it("MODEL_ROUTE_NOT_FOUND invokes no adapter and reports the requirement set", async () => {
    const adapter = spyAdapter(succeeded("x"));
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter }]);
    const failure = failureOf(await executeModelRequest({ request: buildStructuredRequest(), modelPolicyRef: "policy.default", ...registries }));
    expect(failure).toEqual({
      code: "MODEL_ROUTE_NOT_FOUND",
      message: "No registered model binding satisfies every required capability.",
      invocationId: "inv.structured.1",
      details: { requiredCapabilities: ["model.structured_output"] },
    });
    expect(adapter.calls).toHaveLength(0);
  });
});

describe("executeModelRequest — invocation failures, redaction, and no fallback", () => {
  it("a throwing adapter becomes MODEL_INVOCATION_FAILED with no raw error data", async () => {
    const registries = buildRegistries([
      {
        id: "m",
        priority: 1,
        capabilities: TEXT_ONLY,
        adapter: spyAdapter(() => {
          throw Object.assign(new Error(SECRET), { headers: { authorization: SECRET }, url: SECRET });
        }),
      },
    ]);
    const failure = failureOf(await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries }));
    expect(failure).toEqual({ code: "MODEL_INVOCATION_FAILED", message: 'Model binding "m" invocation failed.', invocationId: "inv.text.1", modelBindingId: "m", details: { reason: "provider_error" } });
    expect(JSON.stringify(failure)).not.toMatch(/SECRET|example\.com|Bearer|stack/);
  });

  it("a rejected promise (non-Error thrown value) is redacted the same way", async () => {
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter: { invoke: () => Promise.reject({ secret: SECRET }) } }]);
    const failure = failureOf(await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries }));
    expect(failure.code).toBe("MODEL_INVOCATION_FAILED");
    expect(JSON.stringify(failure)).not.toContain("SECRET");
  });

  it("does not fall back to a second compatible binding after the selected one fails", async () => {
    const primary = spyAdapter({ status: "failed", reason: "provider_error" });
    const secondary = spyAdapter(succeeded("would have worked"));
    const registries = buildRegistries([
      { id: "model.primary", priority: 100, capabilities: TEXT_ONLY, adapter: primary },
      { id: "model.secondary", priority: 1, capabilities: TEXT_ONLY, adapter: secondary },
    ]);
    const failure = failureOf(await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries }));
    expect(failure.code).toBe("MODEL_INVOCATION_FAILED");
    expect(failure.modelBindingId).toBe("model.primary");
    expect(primary.calls).toHaveLength(1); // no retry
    expect(secondary.calls).toHaveLength(0); // no fallback
  });

  it.each([
    ["unsupported_response", "INVALID_MODEL_RESULT"],
    ["unparseable_output", "INVALID_MODEL_RESULT"],
  ])("adapter failure reason %s maps to %s", async (reason, code) => {
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter: spyAdapter({ status: "failed", reason }) }]);
    const failure = failureOf(await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries }));
    expect(failure).toMatchObject({ code, details: { reason } });
  });
});

describe("executeModelRequest — result boundary validation", () => {
  class Custom {
    value = 1;
  }

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["missing status", { output: "x" }],
    ["unknown failure reason", { status: "failed", reason: SECRET }],
    ["raw SDK-like object", { text: "x", response: { headers: {} } }],
  ])("malformed adapter result (%s) → INVALID_MODEL_RESULT", async (_label, raw) => {
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter: spyAdapter(raw) }]);
    const failure = failureOf(await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries }));
    expect(failure.code).toBe("INVALID_MODEL_RESULT");
    expect(JSON.stringify(failure)).not.toContain("SECRET");
  });

  it.each([
    ["function", () => "x"],
    ["Date", new Date(0)],
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1])],
    ["class instance", new Custom()],
    ["NaN", { category: Number.NaN }],
    ["Infinity", { category: Number.POSITIVE_INFINITY }],
    ["nested Date", { category: "research", at: new Date(0) }],
  ])("non-JSON-safe structured output (%s) never becomes a ModelResult", async (_label, output) => {
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_AND_STRUCTURED, adapter: spyAdapter(succeeded(output)) }]);
    const failure = failureOf(await executeModelRequest({ request: buildStructuredRequest(), modelPolicyRef: "policy.default", ...registries }));
    expect(failure.code).toBe("INVALID_MODEL_RESULT");
  });

  it("text output must be a string", async () => {
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter: spyAdapter(succeeded({ text: "x" })) }]);
    expect(failureOf(await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries })).code).toBe("INVALID_MODEL_RESULT");
  });

  it("structured output must be an object", async () => {
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_AND_STRUCTURED, adapter: spyAdapter(succeeded(["research"])) }]);
    expect(failureOf(await executeModelRequest({ request: buildStructuredRequest(), modelPolicyRef: "policy.default", ...registries })).code).toBe("INVALID_MODEL_RESULT");
  });

  it.each([
    ["wrong type", { category: 42 }],
    ["value outside enum", { category: "gossip" }],
    ["missing required field", {}],
    ["extra field", { category: "research", extra: true }],
  ])("schema mismatch (%s) → MODEL_OUTPUT_SCHEMA_MISMATCH even though the adapter claimed success", async (_label, output) => {
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_AND_STRUCTURED, adapter: spyAdapter(succeeded(output)) }]);
    const failure = failureOf(await executeModelRequest({ request: buildStructuredRequest(), modelPolicyRef: "policy.default", ...registries }));
    expect(failure).toEqual({ code: "MODEL_OUTPUT_SCHEMA_MISMATCH", message: "Structured output does not match the requested schema.", invocationId: "inv.structured.1", modelBindingId: "m" });
  });

  it("rejects an unsupported finish reason or malformed usage", async () => {
    for (const extra of [{ finishReason: "tool-calls" }, { usage: { inputTokens: -1 } }, { usage: { inputTokens: Number.NaN } }, { usage: { costUsd: 1 } }]) {
      const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_ONLY, adapter: spyAdapter(succeeded("x", extra as never)) }]);
      expect(failureOf(await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries })).code).toBe("INVALID_MODEL_RESULT");
    }
  });

  it("the ModelResult shares no reference with the adapter's output", async () => {
    const output = { category: "research" };
    const registries = buildRegistries([{ id: "m", priority: 1, capabilities: TEXT_AND_STRUCTURED, adapter: spyAdapter(succeeded(output)) }]);
    const result = await executeModelRequest({ request: buildStructuredRequest(), modelPolicyRef: "policy.default", ...registries });
    output.category = "mutated";
    expect(result.ok && result.result.output).toEqual({ category: "research" });
  });
});

describe("serialization", () => {
  it("ModelRequest, text/structured ModelResult, and ModelFailure all JSON round-trip and re-validate", async () => {
    const registries = buildRegistries([
      { id: "local.fast", priority: 2, capabilities: TEXT_ONLY, adapter: spyAdapter(succeeded("hi", { finishReason: "length", usage: { outputTokens: 1 } })) },
      { id: "local.structured", priority: 1, capabilities: TEXT_AND_STRUCTURED, adapter: spyAdapter(succeeded({ category: "sales" })) },
    ]);
    const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

    for (const request of [buildTextRequest(), buildStructuredRequest()]) {
      expect(ModelRequestSchema.parse(roundTrip(request))).toEqual(request);
    }

    const text = await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.default", ...registries });
    const structured = await executeModelRequest({ request: buildStructuredRequest(), modelPolicyRef: "policy.default", ...registries });
    const failed = await executeModelRequest({ request: buildTextRequest(), modelPolicyRef: "policy.missing", ...registries });
    if (!text.ok || !structured.ok || failed.ok) throw new Error("unexpected outcome");

    expect(ModelResultSchema.parse(roundTrip(text.result))).toEqual(text.result);
    expect(ModelResultSchema.parse(roundTrip(structured.result))).toEqual(structured.result);
    expect(ModelFailureSchema.parse(roundTrip(failed.failure))).toEqual(failed.failure);
    // Registries and adapters are live dependencies: they never appear in results.
    expect(JSON.stringify([text, structured, failed])).not.toMatch(/adapter|invoke|priority/);
  });
});
