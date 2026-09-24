import { describe, expect, it } from "vitest";
import { isoTimestampSchema } from "@aao/contracts";
import { createSystemClock } from "../src/clock.js";
import { buildTestClock } from "./fixtures.js";

describe("createSystemClock", () => {
  it("produces a canonical ISO timestamp with an explicit offset", () => {
    const clock = createSystemClock();
    const now = clock.now();
    expect(isoTimestampSchema.safeParse(now).success).toBe(true);
  });

  it("never returns a decreasing timestamp across successive calls", () => {
    const clock = createSystemClock();
    const first = clock.now();
    const second = clock.now();
    expect(second >= first).toBe(true);
  });
});

describe("buildTestClock (fixture)", () => {
  it("is deterministic and strictly increasing from a fixed start", () => {
    const clock = buildTestClock("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toBe("2026-01-01T00:00:01.000Z");
    expect(clock.now()).toBe("2026-01-01T00:00:02.000Z");
  });

  it("produces the identical sequence for two independent instances started at the same instant", () => {
    const a = buildTestClock("2026-01-01T00:00:00.000Z");
    const b = buildTestClock("2026-01-01T00:00:00.000Z");
    expect([a.now(), a.now(), a.now()]).toEqual([b.now(), b.now(), b.now()]);
  });
});
