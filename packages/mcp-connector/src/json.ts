import type { JsonValue } from "@aao/contracts";

/** Wire boundary guard: reject prototypes, cycles, accessors and lossy JSON before cloning. */
export function isWireJson(value: unknown, ancestors = new Set<object>(), depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors).filter(([key]) => !(Array.isArray(value) && key === "length"));
  const safe = (!Array.isArray(value) || (entries.length === value.length && entries.every(([key], index) => key === String(index)))) && entries.every(([, descriptor]) =>
    descriptor.enumerable && "value" in descriptor && isWireJson(descriptor.value, ancestors, depth + 1),
  );
  ancestors.delete(value);
  return safe;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
