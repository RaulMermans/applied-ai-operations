import type { JsonValue } from "./common.js";

/**
 * A tiny deterministic JSON canonicalizer used only for structural-equality
 * comparisons (e.g. duplicate-edge detection on `Edge.condition` in
 * `@aao/workflow-dsl`, and the equivalent edge-fingerprint comparison in
 * `@aao/runtime`'s preflight). It recursively sorts object keys so two
 * objects with the same keys in a different order compare equal, while
 * preserving array order and primitive values exactly — this is a
 * structural-equality tool, not a condition evaluator or a general-purpose
 * canonicalization scheme. Condition semantics are never evaluated here.
 * Lives in `@aao/contracts` (rather than being duplicated per package)
 * because both `@aao/workflow-dsl` and `@aao/runtime` need the exact same
 * fingerprint semantics and both already depend on this package.
 */
export function canonicalJsonStringify(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key] as JsonValue);
  }
  return sorted;
}
