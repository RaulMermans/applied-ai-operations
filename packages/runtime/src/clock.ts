/**
 * The Runtime's only boundary for "what time is it": every lifecycle
 * timestamp (`RunRecord.createdAt`/`updatedAt`, `StateSnapshot.capturedAt`)
 * flows through a `RuntimeClock` rather than a scattered `new Date()` /
 * `Date.now()` call. This makes every timestamp-producing path deterministic
 * and testable — a test injects a fake clock; production wiring uses
 * `createSystemClock()`. Callers that use a timestamp produced elsewhere
 * (e.g. a value round-tripped through storage) still validate it against
 * `isoTimestampSchema` at the point it enters a canonical record — this
 * module only controls where a *new* timestamp is minted.
 */
export interface RuntimeClock {
  now(): string;
}

/** The production clock: real wall-clock time, ISO-8601 with an explicit offset. */
export function createSystemClock(): RuntimeClock {
  return {
    now(): string {
      return new Date().toISOString();
    },
  };
}
