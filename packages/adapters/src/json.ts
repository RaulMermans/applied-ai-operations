import { createHash } from "node:crypto";
import { canonicalJsonStringify, type JsonValue } from "@aao/contracts";

/**
 * Plain JSON data only: no functions, symbols, class instances, accessors,
 * cycles, or non-finite numbers. Checked *before* a defensive copy, so
 * nothing executable can be silently dropped by `JSON.stringify` and then
 * pass validation.
 */
export function isJsonData(value: unknown, ancestors = new Set<object>(), depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  ancestors.add(value);
  const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([key]) => !(Array.isArray(value) && key === "length"));
  const safe = descriptors.every(([, descriptor]) => descriptor.enumerable === true && "value" in descriptor && isJsonData(descriptor.value, ancestors, depth + 1));
  ancestors.delete(value);
  return safe;
}

export const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Freezes a value this package owns (never a caller's object) all the way down. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** SHA-256 over canonical JSON (sorted keys): a stable identity for semantic data, never a code signature. */
export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value as JsonValue), "utf8").digest("hex");
}
