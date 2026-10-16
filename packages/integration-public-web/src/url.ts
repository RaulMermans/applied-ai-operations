import { createHash } from "node:crypto";
import { PUBLIC_WEB_LIMITS } from "./limits.js";

/**
 * The canonical form of a public-web URL, or `undefined` when the value is
 * not one AAO accepts. Accepted: an absolute `http:` or `https:` URL of at
 * most `maxUrlLength` characters, with a host and no embedded credentials.
 * Canonicalization is the WHATWG URL serializer (lowercase scheme and host,
 * default port removed, path normalized, unsafe characters percent-encoded)
 * with the fragment dropped: a fragment never names a different document.
 * The query string is kept as is.
 */
export function canonicalizePublicWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > PUBLIC_WEB_LIMITS.maxUrlLength) return undefined;
  if (value !== value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "" || url.username !== "" || url.password !== "") return undefined;
  url.hash = "";
  const canonical = url.href;
  return canonical.length <= PUBLIC_WEB_LIMITS.maxUrlLength ? canonical : undefined;
}

/**
 * The AAO-controlled identity of a public-web source: `src.` plus the first
 * 16 hex characters of SHA-256 over the canonical URL. The same URL always
 * yields the same id, across Runs and provider implementations. It never
 * depends on rank, array position, or any provider-supplied id.
 */
export function publicWebSourceId(url: string): string {
  const canonical = canonicalizePublicWebUrl(url);
  if (canonical === undefined) throw new TypeError("publicWebSourceId requires an http(s) URL");
  return `src.${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16)}`;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lowercase DNS name with at least two labels (`acme.example`), or `undefined`. No scheme, port, path, or wildcard. */
export function normalizePublicWebDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const domain = value.trim().toLowerCase();
  return DOMAIN.test(domain) ? domain : undefined;
}

/** True when the URL's host is the domain itself or one of its subdomains. */
export function hostMatchesDomain(canonicalUrl: string, domain: string): boolean {
  const host = new URL(canonicalUrl).hostname;
  return host === domain || host.endsWith(`.${domain}`);
}
