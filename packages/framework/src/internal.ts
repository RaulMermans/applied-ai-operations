import { isJsonSafe } from "@aao/runtime";
import { AAOFrameworkError, type AAOFrameworkDiagnostic, type AAOFrameworkErrorCode } from "./errors.js";

/** The structural shape of a canonical schema's `safeParse` (every AAO contract is a Zod schema). */
interface CanonicalSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> } };
}

/** Recursively freezes a JSON-safe value the framework owns (never a caller's object). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** A detached JSON copy: the caller can never alias framework-owned definition state. */
export const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function schemaDiagnostics(issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>): AAOFrameworkDiagnostic[] {
  return issues.map((issue) => ({ code: "SCHEMA_VALIDATION_ERROR", message: issue.message, ...(issue.path.length > 0 ? { path: issue.path.map(String).join(".") } : {}) }));
}

/**
 * Validates a declarative definition against its *canonical* AAO schema and
 * returns a detached, deep-frozen copy. JSON safety is checked first so a
 * function, symbol, class instance, or cycle can never be silently dropped
 * by the copy and then pass validation.
 */
export function canonicalDefinition<T>(schema: CanonicalSchema<T>, input: unknown, what: string, code: AAOFrameworkErrorCode = "FRAMEWORK_INVALID_DEFINITION"): T {
  if (!isJsonSafe(input)) throw new AAOFrameworkError(code, `${what} must be a JSON-safe value`);
  const parsed = schema.safeParse(jsonClone(input));
  if (!parsed.success) throw new AAOFrameworkError(code, `${what} does not satisfy its canonical AAO schema`, schemaDiagnostics(parsed.error.issues));
  return deepFreeze(parsed.data);
}

/** A thrown host-registration error as a bounded framework error; only the trusted registry's own message is kept. */
export function registrationFailure(code: AAOFrameworkErrorCode, what: string, error: unknown): AAOFrameworkError {
  const detail = error instanceof Error ? error.message : "registration failed";
  return new AAOFrameworkError(code, `${what}: ${detail}`);
}
