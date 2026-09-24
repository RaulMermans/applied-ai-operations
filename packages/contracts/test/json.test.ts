import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "../src/json.js";

describe("canonicalJsonStringify", () => {
  it("produces the same fingerprint for objects with reordered keys", () => {
    expect(canonicalJsonStringify({ a: 1, b: 2 })).toBe(canonicalJsonStringify({ b: 2, a: 1 }));
  });

  it("produces the same fingerprint for deeply nested objects with reordered keys", () => {
    const first = { outer: { a: 1, b: { x: 1, y: 2 } }, z: true };
    const second = { z: true, outer: { b: { y: 2, x: 1 }, a: 1 } };
    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
  });

  it("preserves array order (arrays are not sorted)", () => {
    expect(canonicalJsonStringify([1, 2, 3])).not.toBe(canonicalJsonStringify([3, 2, 1]));
  });

  it("matches plain JSON.stringify for primitives", () => {
    expect(canonicalJsonStringify("x")).toBe(JSON.stringify("x"));
    expect(canonicalJsonStringify(1)).toBe(JSON.stringify(1));
    expect(canonicalJsonStringify(true)).toBe(JSON.stringify(true));
    expect(canonicalJsonStringify(null)).toBe(JSON.stringify(null));
  });

  it("distinguishes objects with different values", () => {
    expect(canonicalJsonStringify({ a: 1, b: 2 })).not.toBe(canonicalJsonStringify({ a: 1, b: 3 }));
  });
});
