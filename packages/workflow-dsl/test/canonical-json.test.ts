import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "../src/canonical-json.js";

describe("canonicalJsonStringify", () => {
  it("produces the same string for objects with the same keys in a different order", () => {
    expect(canonicalJsonStringify({ a: 1, b: 2 })).toBe(canonicalJsonStringify({ b: 2, a: 1 }));
  });

  it("preserves array order — arrays are not sorted", () => {
    expect(canonicalJsonStringify([1, 2, 3])).not.toBe(canonicalJsonStringify([3, 2, 1]));
  });

  it("preserves primitive values exactly", () => {
    expect(canonicalJsonStringify("x")).toBe(JSON.stringify("x"));
    expect(canonicalJsonStringify(1)).toBe(JSON.stringify(1));
    expect(canonicalJsonStringify(true)).toBe(JSON.stringify(true));
    expect(canonicalJsonStringify(null)).toBe(JSON.stringify(null));
  });

  it("sorts keys recursively at every nesting depth", () => {
    const first = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const second = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
  });

  it("distinguishes objects that are not actually equivalent", () => {
    expect(canonicalJsonStringify({ a: 1, b: 2 })).not.toBe(canonicalJsonStringify({ a: 1, b: 3 }));
  });
});
