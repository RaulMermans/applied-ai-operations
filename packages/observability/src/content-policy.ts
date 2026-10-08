import { MAX_TRACE_EVENT_BYTES, TraceEventSchema, canonicalJsonStringify, type JsonValue, type TraceEvent } from "@aao/contracts";

/**
 * Metadata-only content policy (ADR-020). Typed strict payload schemas are
 * the primary guarantee; this is defense in depth against a future payload
 * field that accidentally carries content. Keys are normalized (lowercase,
 * `_`/`-` removed) and matched *exactly* against an explicit list — never by
 * substring — so legitimate metadata such as `inputTokens` or
 * `outputKind` stays valid while `token`, `apiKey`, or `messages` do not.
 */
export const FORBIDDEN_TRACE_KEYS: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "authorization",
  "authheader",
  "cookie",
  "setcookie",
  "privatekey",
  "credential",
  "credentials",
  "headers",
  "messages",
  "prompt",
  "prompts",
  "systemprompt",
  "instructions",
  "content",
  "input",
  "rawinput",
  "output",
  "rawoutput",
  "finaloutput",
  "workingoutput",
  "result",
  "response",
  "rawresponse",
  "values",
  "statevalues",
  "subject",
  "proposal",
  "task",
  "rationale",
  "reasoning",
  "chainofthought",
  "thoughts",
  "stack",
  "stacktrace",
  "error",
  "exception",
  "email",
  "phone",
  "displayname",
]);

const forbidden = new Set(FORBIDDEN_TRACE_KEYS);

function normalize(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/**
 * Every forbidden key path inside an event's payload (and envelope).
 * `tool.call.completed` legitimately uses the key `result` with the fixed
 * value `"success"`; that single literal is the only allowed exception.
 */
export function findForbiddenTraceKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    const allowedResultLiteral = key === "result" && nested === "success";
    if (forbidden.has(normalize(key)) && !allowedResultLiteral) found.push(here);
    found.push(...findForbiddenTraceKeys(nested, here));
  }
  return found;
}

/** Strict JSON-safety: plain objects/arrays, finite numbers, strings, booleans, null; no cycles, Dates, functions, or class instances. */
export function isTraceJsonSafe(value: unknown, seen: Set<unknown> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const ok = Array.isArray(value) ? value.every((item) => isTraceJsonSafe(item, seen)) : Object.values(value).every((item) => isTraceJsonSafe(item, seen));
  seen.delete(value);
  return ok;
}

/** Deterministic serialization: canonical key order, no whitespace. */
export function serializeTraceEvent(event: TraceEvent): string {
  return canonicalJsonStringify(event as unknown as JsonValue);
}

export type TraceEventCheck = { ok: true; event: TraceEvent } | { ok: false; code: "TRACE_INVALID_EVENT" | "TRACE_EVENT_TOO_LARGE" | "TRACE_FORBIDDEN_CONTENT" };

/** Every check an event passes before it may be stored: JSON-safety, the V2 schema with its typed payload, the size bound, and the content policy. */
export function checkTraceEvent(raw: unknown): TraceEventCheck {
  if (!isTraceJsonSafe(raw)) return { ok: false, code: "TRACE_INVALID_EVENT" };
  const parsed = TraceEventSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "TRACE_INVALID_EVENT" };
  const event = parsed.data as TraceEvent;
  if (Buffer.byteLength(serializeTraceEvent(event), "utf8") > MAX_TRACE_EVENT_BYTES) return { ok: false, code: "TRACE_EVENT_TOO_LARGE" };
  if (findForbiddenTraceKeys(event.payload).length > 0) return { ok: false, code: "TRACE_FORBIDDEN_CONTENT" };
  return { ok: true, event };
}
