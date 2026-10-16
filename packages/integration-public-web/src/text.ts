// Deterministic text normalization for untrusted provider strings. It
// changes representation only (line endings, control characters, length);
// it never interprets content. Retrieved text stays data.

// C0/C1 control characters except TAB and LF.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Cuts at most `max` UTF-16 code units without splitting a surrogate pair. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** Page text: CRLF/CR → LF, control characters removed, outer whitespace trimmed. */
export function cleanPageText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
}

/** A one-line field (title, snippet): every whitespace run becomes one space, controls removed, trimmed, then bounded. */
export function cleanInline(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return cleaned.length === 0 ? undefined : truncateText(cleaned, max).text;
}
