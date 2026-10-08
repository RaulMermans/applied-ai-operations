/**
 * The one percentile algorithm AAO Metrics use: nearest-rank. For `n`
 * ascending values, the p-th percentile (integer 1 ≤ p ≤ 100) is the value at
 * 1-based rank `ceil(p × n / 100)`. It always returns an observed value,
 * never an interpolation, and no library default can change it. An empty
 * sample has no percentile (`null`), never 0.
 */
export function nearestRankPercentile(values: readonly number[], p: number): number | null {
  if (!Number.isInteger(p) || p < 1 || p > 100) throw new RangeError("percentile must be an integer in [1, 100]");
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Integer arithmetic: p × n is exact, so no floating-point rounding can shift the rank.
  const rank = Math.ceil((p * sorted.length) / 100);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}
