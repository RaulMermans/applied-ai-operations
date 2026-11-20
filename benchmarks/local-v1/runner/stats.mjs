export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.length === 0 ? null : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

export async function measure(fn, { warmup = 3, samples = 15 } = {}) {
  for (let i = 0; i < warmup; i += 1) await fn();
  const elapsedNs = [];
  let lastResult;
  for (let i = 0; i < samples; i += 1) {
    const start = process.hrtime.bigint();
    lastResult = await fn();
    elapsedNs.push(Number(process.hrtime.bigint() - start));
  }
  return { elapsedNs, statsMs: summarize(elapsedNs.map((ns) => ns / 1e6)), lastResult };
}
