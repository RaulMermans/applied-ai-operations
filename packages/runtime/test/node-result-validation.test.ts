import { describe, expect, it } from "vitest";
import { validateNodeExecutionResult } from "../src/node-result-validation.js";

describe("validateNodeExecutionResult", () => {
  it("accepts an empty result", () => {
    const result = validateNodeExecutionResult({});
    expect(result.ok).toBe(true);
  });

  it("accepts a result with only a statePatch", () => {
    const result = validateNodeExecutionResult({ statePatch: { a: 1 } });
    expect(result).toEqual({ ok: true, result: { statePatch: { a: 1 } } });
  });

  it("accepts a result with only output", () => {
    const result = validateNodeExecutionResult({ output: { a: [1, "two", null, true] } });
    expect(result).toEqual({ ok: true, result: { output: { a: [1, "two", null, true] } } });
  });

  it("rejects a non-object result", () => {
    const result = validateNodeExecutionResult("not an object");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_NODE_RESULT");
  });

  it("rejects null", () => {
    const result = validateNodeExecutionResult(null);
    expect(result.ok).toBe(false);
  });

  it("rejects an unexpected extra key", () => {
    const result = validateNodeExecutionResult({ statePatch: {}, bogus: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_NODE_RESULT");
  });

  it("rejects a function value inside output", () => {
    const result = validateNodeExecutionResult({ output: { fn: () => 1 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_NODE_RESULT");
  });

  it("rejects a Date instance inside statePatch", () => {
    const result = validateNodeExecutionResult({ statePatch: { when: new Date() } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_STATE_PATCH");
  });

  it("rejects a class instance inside output", () => {
    class Custom {
      value = 1;
    }
    const result = validateNodeExecutionResult({ output: { instance: new Custom() } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_NODE_RESULT");
  });

  it("rejects statePatch that is an array rather than an object", () => {
    const result = validateNodeExecutionResult({ statePatch: [1, 2, 3] as never });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_STATE_PATCH");
  });

  it("rejects a Map instance smuggled in as statePatch (would look empty to a naive structural check)", () => {
    const result = validateNodeExecutionResult({ statePatch: new Map() as never });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_STATE_PATCH");
  });
});
