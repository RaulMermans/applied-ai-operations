/**
 * Compares two canonical ISO timestamps (already validated against
 * `isoTimestampSchema`) by the *instant* they denote, not by their raw
 * string form: `2026-09-24T10:00:00Z` and `2026-09-24T12:00:00+02:00` are
 * the same instant and compare equal. Returns a negative number if `a` is
 * earlier than `b`, zero if they are the same instant, positive if later.
 *
 * `Date.parse` resolves the offset but truncates to milliseconds, so any
 * sub-millisecond fraction digits are compared separately. UTC offsets are
 * whole minutes, so those digits are unaffected by the offset and can be
 * compared directly. This is deliberately the only temporal helper the
 * Runtime needs — not a general date/time framework.
 */
export function compareIsoInstants(a: string, b: string): number {
  const msA = Date.parse(a);
  const msB = Date.parse(b);
  if (Number.isNaN(msA) || Number.isNaN(msB)) {
    throw new Error(`compareIsoInstants: cannot compare "${a}" and "${b}" — not valid ISO timestamps.`);
  }
  if (msA !== msB) return msA - msB;
  const subA = subMillisecondDigits(a);
  const subB = subMillisecondDigits(b);
  const width = Math.max(subA.length, subB.length);
  const paddedA = subA.padEnd(width, "0");
  const paddedB = subB.padEnd(width, "0");
  // Equal-width digit strings order lexicographically exactly as numbers do.
  return paddedA < paddedB ? -1 : paddedA > paddedB ? 1 : 0;
}

function subMillisecondDigits(timestamp: string): string {
  const fraction = /\.(\d+)/.exec(timestamp)?.[1] ?? "";
  return fraction.slice(3);
}
