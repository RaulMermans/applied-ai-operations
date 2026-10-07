import { describe, expect, it } from "vitest";
import { FailureCategorySchema, RELIABILITY_LIMITS, RETRYABLE_FAILURE_CATEGORIES, ReliabilityPolicySchema, RetrySafetySchema, isRetryableFailureCategory } from "../src/index.js";

describe("reliability contracts", () => {
  it("pins hard, frozen Runtime limits", () => {
    expect(RELIABILITY_LIMITS).toEqual({ maxAttempts: 3, maxAttemptTimeoutMs: 600_000, maxRetryDelayMs: 60_000 });
    expect(Object.isFrozen(RELIABILITY_LIMITS)).toBe(true);
    expect(Object.isFrozen(RETRYABLE_FAILURE_CATEGORIES)).toBe(true);
  });

  it("accepts bounded JSON-safe policies and rejects everything outside the caps", () => {
    for (const ok of [{ maxAttempts: 1 }, { maxAttempts: 3, attemptTimeoutMs: 1, retryDelayMs: 0 }, { maxAttempts: 2, attemptTimeoutMs: 600_000, retryDelayMs: 60_000 }]) {
      expect(ReliabilityPolicySchema.parse(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    }
    for (const bad of [{}, { maxAttempts: 0 }, { maxAttempts: 4 }, { maxAttempts: 1.5 }, { maxAttempts: 2, attemptTimeoutMs: 0 }, { maxAttempts: 2, attemptTimeoutMs: 600_001 }, { maxAttempts: 2, retryDelayMs: -1 }, { maxAttempts: 2, retryDelayMs: 60_001 }, { maxAttempts: 2, jitter: true }, { maxAttempts: "2" }]) {
      expect(ReliabilityPolicySchema.safeParse(bad).success).toBe(false);
    }
  });

  it("has one failure taxonomy where only timeout, transient dependency, and rate limit are retryable", () => {
    expect(FailureCategorySchema.options.filter(isRetryableFailureCategory)).toEqual(["TIMEOUT", "TRANSIENT_DEPENDENCY", "RATE_LIMIT"]);
    expect(RetrySafetySchema.options).toEqual(["safe", "unsafe"]);
  });
});
