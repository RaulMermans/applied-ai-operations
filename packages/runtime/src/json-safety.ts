import type { JsonValue } from "@aao/contracts";

/**
 * A deliberately strict JSON-safety check, used to validate executor output
 * at the Runtime boundary. `JSON.stringify`-based cloning is not enough here
 * on its own: `Object.entries`/`Object.values` on a `Date`, a `Map`, or a
 * class instance without any own enumerable properties can *look* like an
 * empty plain object to a naive structural check, silently hiding the fact
 * that untrusted executor output was not actually plain JSON. This function
 * instead checks each object's prototype explicitly, so a `Date`, a `Map`, a
 * `Set`, or any class instance is rejected regardless of its own properties.
 */
export function isJsonSafe(value: unknown): value is JsonValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return true;
  if (type !== "object") return false; // rejects function, undefined, symbol, bigint

  if (Array.isArray(value)) return value.every(isJsonSafe);

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false; // rejects Date, Map, Set, class instances

  return Object.values(value as Record<string, unknown>).every(isJsonSafe);
}

/** Deep-clones a JSON-safe value via serialize/deserialize, the smallest reliable approach without an immutable-data library. */
export function cloneJsonValue<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
