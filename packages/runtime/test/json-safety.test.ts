import { describe, expect, it } from "vitest";
import { cloneJsonValue, isJsonSafe } from "../src/json-safety.js";

describe("isJsonSafe", () => {
  it.each([null, "s", 1, true, false, [1, "a", null], { a: 1, b: { c: [true, null] } }])(
    "accepts %j",
    (value) => {
      expect(isJsonSafe(value)).toBe(true);
    },
  );

  it("rejects undefined", () => expect(isJsonSafe(undefined)).toBe(false));
  it("rejects a function", () => expect(isJsonSafe(() => 1)).toBe(false));
  it("rejects a function nested in an object", () => expect(isJsonSafe({ fn: () => 1 })).toBe(false));
  it("rejects a Date instance", () => expect(isJsonSafe(new Date())).toBe(false));
  it("rejects a Date instance nested in an object", () => expect(isJsonSafe({ when: new Date() })).toBe(false));
  it("rejects a class instance", () => {
    class Custom {}
    expect(isJsonSafe(new Custom())).toBe(false);
  });
  it("rejects a Map", () => expect(isJsonSafe(new Map())).toBe(false));
  it("rejects a Set", () => expect(isJsonSafe(new Set())).toBe(false));
});

describe("cloneJsonValue", () => {
  it("deep clones without sharing references", () => {
    const original = { nested: { a: 1 } };
    const cloned = cloneJsonValue(original);
    cloned.nested.a = 2;
    expect(original.nested.a).toBe(1);
  });
});
