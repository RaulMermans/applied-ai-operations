/**
 * A tiny deterministic JSON canonicalizer used only for structural equality
 * comparisons (currently: duplicate-edge detection on `Edge.condition`). It
 * recursively sorts object keys so two objects with the same keys in a
 * different order compare equal, while preserving array order and primitive
 * values exactly — this is a structural-equality tool, not a condition
 * evaluator. Condition semantics are never evaluated here or anywhere else in
 * this package.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
