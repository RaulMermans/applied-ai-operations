import { describe, expect, it } from "vitest";
import { compareIsoInstants } from "../src/timestamps.js";

describe("compareIsoInstants", () => {
  it("orders by instant", () => {
    expect(compareIsoInstants("2026-09-24T10:00:00Z", "2026-09-24T10:00:01Z")).toBeLessThan(0);
    expect(compareIsoInstants("2026-09-24T10:00:01Z", "2026-09-24T10:00:00Z")).toBeGreaterThan(0);
  });

  it("treats the same instant written with different UTC offsets as equal", () => {
    expect(compareIsoInstants("2026-09-24T10:00:00Z", "2026-09-24T12:00:00+02:00")).toBe(0);
  });

  it("does not compare raw strings: a lexicographically larger string can be an earlier instant", () => {
    // "11:30+02:00" (09:30Z) sorts after "10:00Z" as a string but is earlier.
    expect("2026-09-24T11:30:00+02:00" > "2026-09-24T10:00:00Z").toBe(true);
    expect(compareIsoInstants("2026-09-24T11:30:00+02:00", "2026-09-24T10:00:00Z")).toBeLessThan(0);
  });

  it("compares sub-millisecond fraction digits exactly", () => {
    expect(compareIsoInstants("2026-09-24T10:00:00.0001Z", "2026-09-24T10:00:00.0002Z")).toBeLessThan(0);
    expect(compareIsoInstants("2026-09-24T10:00:00.1000Z", "2026-09-24T10:00:00.1Z")).toBe(0);
  });

  it("throws on unparseable input", () => {
    expect(() => compareIsoInstants("nope", "2026-09-24T10:00:00Z")).toThrow();
  });
});
