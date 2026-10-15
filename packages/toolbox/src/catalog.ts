import { z } from "zod";
import type { JsonObject, JsonValue, PermissionClass, RetrySafety, ToolIdempotency } from "@aao/contracts";
import type { ToolDefinition } from "@aao/framework";
import { ToolboxToolRefSchema, toolRefKey, toolboxState, type Toolbox, type ToolboxCatalogEntry, type ToolboxExample, type ToolboxToolRef } from "./contract.js";
import { ToolboxError } from "./errors.js";
import { compareCodeUnits, deepFreeze, jsonClone } from "./json.js";

// The Toolbox Catalog describes discoverable reusable capabilities. The Tool
// Registry remains authoritative for executable Tool schemas, handlers,
// permissions, and versions. Nothing here executes, registers, or authorizes
// anything, and no result carries a handler, validator, or runtime state.
// Discovery grants zero permissions.

/** Catalog filters. All optional; an absent filter matches everything. */
export interface ToolboxEntryFilter {
  category?: string;
  tag?: string;
  status?: "active" | "deprecated";
}

const FilterSchema = z
  .object({
    category: z.string().min(1).max(32).optional(),
    tag: z.string().min(1).max(32).optional(),
    status: z.enum(["active", "deprecated"]).optional(),
  })
  .strict();

export const TOOLBOX_SEARCH_LIMITS = Object.freeze({ maxQueryLength: 256, maxQueryTokens: 32, defaultLimit: 5, maxLimit: 20 });

export interface ToolboxSearchQuery extends ToolboxEntryFilter {
  /** Free text, at most 256 characters, with at least one letter or digit. */
  query: string;
  /** 1–20; default 5. */
  limit?: number;
}

const SearchSchema = FilterSchema.extend({
  query: z.string().max(TOOLBOX_SEARCH_LIMITS.maxQueryLength),
  limit: z.number().int().min(1).max(TOOLBOX_SEARCH_LIMITS.maxLimit).optional(),
}).strict();

/** The searchable fields, in the fixed order `matchedFields` reports them. */
export const TOOLBOX_SEARCH_FIELDS = ["id", "name", "description", "category", "tags", "whenToUse", "whenNotToUse", "examples"] as const;
export type ToolboxSearchField = (typeof TOOLBOX_SEARCH_FIELDS)[number];

/** Integer field weights. A token matching a field exactly scores 2 × weight; a prefix match (3+ characters) scores 1 × weight. */
const FIELD_WEIGHTS: Readonly<Record<ToolboxSearchField, number>> = Object.freeze({ id: 8, name: 3, description: 2, category: 4, tags: 5, whenToUse: 3, whenNotToUse: 1, examples: 1 });
/** Added when the whole query equals the Tool id (case-insensitive). */
const EXACT_ID_BONUS = 50;

/** A ranked match: identity and why it matched. Never a handler, schema, Authorization context, or executable access. */
export interface ToolboxSearchResult {
  readonly toolRef: ToolboxToolRef;
  readonly category: string;
  readonly status: "active" | "deprecated";
  readonly score: number;
  readonly matchedFields: readonly ToolboxSearchField[];
}

/** Every entry matching the filter, ordered by exact Tool ref (id, then version, by code units). */
export function listToolboxEntries(toolbox: Toolbox, filter: ToolboxEntryFilter = {}): readonly ToolboxCatalogEntry[] {
  const { entries } = toolboxState(toolbox);
  const parsed = FilterSchema.safeParse(filter);
  if (!parsed.success) throw invalidQuery("filter", parsed.error.issues);
  return Object.freeze(entries.filter((entry) => matchesFilter(entry, parsed.data)));
}

/** The entry for one exact Tool ref, or `undefined`. There is no "latest" and no fuzzy lookup. */
export function getToolboxEntry(toolbox: Toolbox, ref: ToolboxToolRef): ToolboxCatalogEntry | undefined {
  const { entries } = toolboxState(toolbox);
  const parsed = ToolboxToolRefSchema.safeParse(ref);
  if (!parsed.success) throw invalidQuery("toolRef", parsed.error.issues);
  return entries.find((entry) => toolRefKey(entry.toolRef) === toolRefKey(parsed.data));
}

/**
 * Deterministic lexical search over static discovery metadata: Tool id,
 * name, description, category, tags, whenToUse, whenNotToUse, and example
 * titles/notes. No embeddings, model, Run history, popularity, or learned
 * ranking. The same Toolbox, query, and filters always produce the same
 * ordered results and scores. Ties break by exact Tool ref.
 *
 * Tokens are maximal runs of Unicode letters and digits, lowercased with
 * the locale-independent `String.prototype.toLowerCase`. A result is
 * information only: it grants no permission and registers nothing.
 */
export function searchToolbox(toolbox: Toolbox, search: ToolboxSearchQuery): readonly ToolboxSearchResult[] {
  const { entries } = toolboxState(toolbox);
  const parsed = SearchSchema.safeParse(search);
  if (!parsed.success) throw invalidQuery("search", parsed.error.issues);
  const tokens = [...new Set(tokenize(parsed.data.query))];
  if (tokens.length === 0) throw new ToolboxError("TOOLBOX_QUERY_INVALID", "search query must contain at least one letter or digit");
  if (tokens.length > TOOLBOX_SEARCH_LIMITS.maxQueryTokens) throw new ToolboxError("TOOLBOX_QUERY_INVALID", `search query may contain at most ${TOOLBOX_SEARCH_LIMITS.maxQueryTokens} distinct terms`);
  const wholeQuery = parsed.data.query.trim().toLowerCase();
  const results: ToolboxSearchResult[] = [];
  for (const entry of entries) {
    if (!matchesFilter(entry, parsed.data)) continue;
    const fields = searchableFields(entry);
    let score = wholeQuery === entry.toolRef.id.toLowerCase() ? EXACT_ID_BONUS : 0;
    const matched = new Set<ToolboxSearchField>(score > 0 ? ["id"] : []);
    for (const field of TOOLBOX_SEARCH_FIELDS) {
      const fieldTokens = fields[field];
      for (const token of tokens) {
        const points = fieldTokens.has(token) ? 2 : token.length >= 3 && [...fieldTokens].some((candidate) => candidate.startsWith(token)) ? 1 : 0;
        if (points > 0) {
          score += points * FIELD_WEIGHTS[field];
          matched.add(field);
        }
      }
    }
    if (score > 0) results.push({ toolRef: { ...entry.toolRef }, category: entry.category, status: entry.status, score, matchedFields: TOOLBOX_SEARCH_FIELDS.filter((field) => matched.has(field)) });
  }
  results.sort((a, b) => b.score - a.score || compareCodeUnits(a.toolRef.id, b.toolRef.id) || compareCodeUnits(a.toolRef.version, b.toolRef.version));
  return deepFreeze(results.slice(0, parsed.data.limit ?? TOOLBOX_SEARCH_LIMITS.defaultLimit));
}

/**
 * Resolves exact Tool refs to this Toolbox's frozen Tool definitions, in
 * the order given, for explicit registration (`createAAO({ tools })`).
 * Every ref must be exact and present; duplicates are refused. A
 * deprecated Tool is returned only when named, and is never replaced.
 * Selecting a Tool grants nothing: the Tool Runtime support gate and
 * Authorization still decide every call.
 */
export function selectToolboxTools(toolbox: Toolbox, refs: readonly ToolboxToolRef[]): readonly ToolDefinition[] {
  const { tools } = toolboxState(toolbox);
  const parsed = z.array(ToolboxToolRefSchema).min(1).max(64).safeParse(refs);
  if (!parsed.success) throw invalidQuery("refs", parsed.error.issues);
  const keys = parsed.data.map(toolRefKey);
  if (new Set(keys).size !== keys.length) throw new ToolboxError("TOOLBOX_QUERY_INVALID", "refs must not repeat a Tool");
  const missing = parsed.data.filter((ref) => !tools.has(toolRefKey(ref)));
  if (missing.length > 0) throw new ToolboxError("TOOLBOX_TOOL_NOT_FOUND", `${toolbox.ref.id}@${toolbox.ref.version} has no Tool ${missing.map((ref) => `${ref.id}@${ref.version}`).join(", ")}`);
  return Object.freeze(keys.map((key) => tools.get(key)!));
}

/** One Tool in a Toolbox description: catalog metadata plus the canonical, non-executable registration facts. */
export interface ToolboxToolDescription {
  readonly toolRef: ToolboxToolRef;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly status: "active" | "deprecated";
  readonly replacementRef?: ToolboxToolRef;
  /** From the canonical `ToolSpec`. */
  readonly permissionClasses: readonly PermissionClass[];
  /** From the Tool definition's trusted registration metadata (canonical defaults applied). */
  readonly retrySafety: RetrySafety;
  readonly idempotency: ToolIdempotency;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly examples: readonly ToolboxExample[];
  /** From the canonical `ToolSpec`. */
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
}

/** A static, JSON-safe description of a Toolbox. It has no authority, and it contains no handler, source, module path, or Run data. */
export interface ToolboxDescription {
  readonly schemaVersion: 1;
  readonly kind: "aao.toolbox-catalog";
  readonly authority: "none";
  readonly toolbox: { readonly id: string; readonly version: string; readonly name: string; readonly description: string; readonly fingerprint: string };
  readonly tools: readonly ToolboxToolDescription[];
}

/** Describes a Toolbox from its manifest and its actual Tool definitions: the canonical source for generated catalogs. */
export function describeToolbox(toolbox: Toolbox): ToolboxDescription {
  const { entries, tools } = toolboxState(toolbox);
  const description = {
    schemaVersion: 1 as const,
    kind: "aao.toolbox-catalog" as const,
    authority: "none" as const,
    toolbox: { id: toolbox.manifest.id, version: toolbox.manifest.version, name: toolbox.manifest.name, description: toolbox.manifest.description, fingerprint: toolbox.fingerprint },
    tools: entries.map((entry): ToolboxToolDescription => {
      const tool = tools.get(toolRefKey(entry.toolRef))!;
      return {
        toolRef: { ...entry.toolRef },
        name: entry.name,
        description: entry.description,
        category: entry.category,
        tags: [...entry.tags],
        status: entry.status,
        ...(entry.replacementRef !== undefined ? { replacementRef: { ...entry.replacementRef } } : {}),
        permissionClasses: [...tool.spec.permissionClasses],
        retrySafety: tool.retrySafety ?? "unsafe",
        idempotency: tool.idempotency ?? "none",
        whenToUse: [...entry.whenToUse],
        whenNotToUse: [...entry.whenNotToUse],
        examples: jsonClone(entry.examples),
        inputSchema: jsonClone(tool.spec.inputSchema),
        outputSchema: jsonClone(tool.spec.outputSchema),
      };
    }),
  };
  return deepFreeze(jsonClone(description as unknown as JsonValue) as unknown as ToolboxDescription);
}

function matchesFilter(entry: ToolboxCatalogEntry, filter: ToolboxEntryFilter): boolean {
  return (filter.category === undefined || entry.category === filter.category) && (filter.tag === undefined || entry.tags.includes(filter.tag)) && (filter.status === undefined || entry.status === filter.status);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function searchableFields(entry: ToolboxCatalogEntry): Record<ToolboxSearchField, ReadonlySet<string>> {
  const set = (...texts: readonly string[]) => new Set(texts.flatMap(tokenize));
  return {
    id: set(entry.toolRef.id),
    name: set(entry.name),
    description: set(entry.description),
    category: set(entry.category),
    tags: set(...entry.tags),
    whenToUse: set(...entry.whenToUse),
    whenNotToUse: set(...entry.whenNotToUse),
    examples: set(...entry.examples.flatMap((example) => [example.title, ...(example.notes !== undefined ? [example.notes] : [])])),
  };
}

function invalidQuery(what: string, issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>): ToolboxError {
  return new ToolboxError("TOOLBOX_QUERY_INVALID", `${what} is invalid`, issues.map((issue) => `${issue.path.join(".") || `(${what})`}: ${issue.message}`));
}
