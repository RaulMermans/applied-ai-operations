import { describe, expect, it } from "vitest";
import { JsonObjectSchema, JsonPrimitiveSchema, WorkflowIdSchema, entityVersionSchema, isoTimestampSchema, schemaVersionSchema } from "../src/common.js";

describe("identifierSchema (via WorkflowIdSchema)", () => {
  it.each([
    ["sales.lead-qualification"],
    ["crm.accounts.search"],
    ["research.company-profile"],
    ["simple-id"],
    ["a"],
  ])("accepts a valid identifier: %s", (value) => {
    expect(WorkflowIdSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    [""],
    [" "],
    ["leading .dot"],
    ["has space"],
    [".leading-separator"],
    ["trailing-separator."],
    ["new\nline"],
  ])("rejects an invalid identifier: %j", (value) => {
    expect(WorkflowIdSchema.safeParse(value).success).toBe(false);
  });
});

describe("isoTimestampSchema", () => {
  it("accepts a valid ISO timestamp with an offset", () => {
    expect(isoTimestampSchema.safeParse("2026-09-23T12:00:00Z").success).toBe(true);
    expect(isoTimestampSchema.safeParse("2026-09-23T12:00:00.123Z").success).toBe(true);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(isoTimestampSchema.safeParse("2026-09-23").success).toBe(false);
    expect(isoTimestampSchema.safeParse("not-a-date").success).toBe(false);
    expect(isoTimestampSchema.safeParse(1758628800000).success).toBe(false);
  });
});

describe("schemaVersionSchema", () => {
  it("accepts only the exact pinned version", () => {
    const v1 = schemaVersionSchema(1);
    expect(v1.safeParse(1).success).toBe(true);
    expect(v1.safeParse(2).success).toBe(false);
    expect(v1.safeParse("1").success).toBe(false);
  });
});

describe("entityVersionSchema", () => {
  it("accepts a non-empty version string", () => {
    expect(entityVersionSchema.safeParse("1.0.0").success).toBe(true);
    expect(entityVersionSchema.safeParse("").success).toBe(false);
  });
});

describe("JsonObjectSchema (JSON-safe values)", () => {
  it("accepts nested JSON-safe data", () => {
    const value = {
      a: 1,
      b: "two",
      c: true,
      d: null,
      e: [1, "two", { nested: true }],
      f: { g: { h: [] } },
    };
    expect(JsonObjectSchema.safeParse(value).success).toBe(true);
  });

  it("rejects a function value", () => {
    expect(JsonObjectSchema.safeParse({ fn: () => 1 }).success).toBe(false);
  });

  it("rejects a Date instance", () => {
    expect(JsonObjectSchema.safeParse({ when: new Date() }).success).toBe(false);
  });

  it("rejects undefined at a key", () => {
    expect(JsonObjectSchema.safeParse({ a: undefined }).success).toBe(false);
  });

  it("rejects non-finite numbers (NaN, Infinity, -Infinity) at any depth", () => {
    expect(JsonObjectSchema.safeParse({ a: Number.NaN }).success).toBe(false);
    expect(JsonObjectSchema.safeParse({ a: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(JsonObjectSchema.safeParse({ a: Number.NEGATIVE_INFINITY }).success).toBe(false);
    expect(JsonObjectSchema.safeParse({ nested: { deep: [Number.POSITIVE_INFINITY] } }).success).toBe(false);
  });
});

describe("JsonPrimitiveSchema", () => {
  it("accepts finite numbers, strings, booleans, and null", () => {
    expect(JsonPrimitiveSchema.safeParse(1).success).toBe(true);
    expect(JsonPrimitiveSchema.safeParse(-1.5).success).toBe(true);
    expect(JsonPrimitiveSchema.safeParse("x").success).toBe(true);
    expect(JsonPrimitiveSchema.safeParse(true).success).toBe(true);
    expect(JsonPrimitiveSchema.safeParse(null).success).toBe(true);
  });

  it("rejects NaN, Infinity, and -Infinity — every JsonPrimitive must survive JSON.stringify/parse unchanged", () => {
    expect(JsonPrimitiveSchema.safeParse(Number.NaN).success).toBe(false);
    expect(JsonPrimitiveSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(JsonPrimitiveSchema.safeParse(Number.NEGATIVE_INFINITY).success).toBe(false);
  });
});
