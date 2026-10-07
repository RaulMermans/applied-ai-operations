import { z } from "zod";

/**
 * Hard Runtime reliability ceilings. No trusted configuration, future DSL
 * surface, or Capability Pack recommendation may exceed them: a Node can
 * never be attempted more than `maxAttempts` times, never waits longer than
 * `maxAttemptTimeoutMs` per attempt, and never sleeps longer than
 * `maxRetryDelayMs` between attempts.
 */
export const RELIABILITY_LIMITS = Object.freeze({
  maxAttempts: 3,
  maxAttemptTimeoutMs: 600_000,
  maxRetryDelayMs: 60_000,
});

/**
 * Trusted, JSON-safe, per-Node Runtime reliability policy (ADR-018).
 * `maxAttempts` defaults to 1 (no retry). There is no backoff, jitter, or
 * adaptive window: a fixed `retryDelayMs` (default 0) separates attempts.
 * A policy only *permits* attempts; a retry additionally requires a
 * retryable failure category and a retry-safe operation.
 */
export const ReliabilityPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(RELIABILITY_LIMITS.maxAttempts),
    attemptTimeoutMs: z.number().int().min(1).max(RELIABILITY_LIMITS.maxAttemptTimeoutMs).optional(),
    retryDelayMs: z.number().int().min(0).max(RELIABILITY_LIMITS.maxRetryDelayMs).optional(),
  })
  .strict();
export type ReliabilityPolicy = z.infer<typeof ReliabilityPolicySchema>;

/** Trusted operation metadata. Absent or unknown means `unsafe`: no operation is retried by default. */
export const RetrySafetySchema = z.enum(["safe", "unsafe"]);
export type RetrySafety = z.infer<typeof RetrySafetySchema>;

/**
 * The single canonical failure taxonomy. Only `TIMEOUT`,
 * `TRANSIENT_DEPENDENCY`, and `RATE_LIMIT` are retryable in nature; every
 * other category — and every unclassified failure — is not.
 */
export const FailureCategorySchema = z.enum([
  "VALIDATION",
  "AUTHORIZATION",
  "POLICY",
  "APPROVAL",
  "TIMEOUT",
  "TRANSIENT_DEPENDENCY",
  "RATE_LIMIT",
  "EXECUTION",
  "INTERNAL",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const RETRYABLE_FAILURE_CATEGORIES: readonly FailureCategory[] = Object.freeze(["TIMEOUT", "TRANSIENT_DEPENDENCY", "RATE_LIMIT"]);

export function isRetryableFailureCategory(category: FailureCategory): boolean {
  return RETRYABLE_FAILURE_CATEGORIES.includes(category);
}
