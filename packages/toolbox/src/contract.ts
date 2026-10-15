import { z } from "zod";
import { JsonObjectSchema, ToolIdSchema, identifierSchema, type JsonValue, type PermissionClass } from "@aao/contracts";
import { defineTool, type ToolDefinition } from "@aao/framework";
import { ToolboxError } from "./errors.js";
import { compareCodeUnits, deepFreeze, isJsonData, jsonClone, sha256Hex } from "./json.js";

// --- Exact identity -------------------------------------------------------------

/** An exact version: `MAJOR.MINOR.PATCH`. No ranges (`^1`, `>=1`), tags, or "latest". */
export const ToolboxVersionSchema = z.string().regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/, "must be an exact MAJOR.MINOR.PATCH version");

/** An exact Tool reference: the canonical Tool id plus one exact version. A Toolbox pins Tools; it never resolves a "latest". */
export const ToolboxToolRefSchema = z.object({ id: ToolIdSchema.max(128), version: ToolboxVersionSchema }).strict();
export type ToolboxToolRef = z.infer<typeof ToolboxToolRefSchema>;

/** Canonical Toolbox identity: id + exact version. */
export const ToolboxRefSchema = z.object({ id: identifierSchema.max(128), version: ToolboxVersionSchema }).strict();
export type ToolboxRef = z.infer<typeof ToolboxRefSchema>;

// --- Discovery metadata -----------------------------------------------------------

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "must be a lowercase slug (a-z, 0-9, -; at most 32 characters)");
const guidance = z.string().trim().min(1).max(300);
const MAX_EXAMPLE_INPUT_LENGTH = 4096;

/** An illustrative call: a title and a JSON input object. Data only — never code, never a recorded Run input. */
export const ToolboxExampleSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    input: JsonObjectSchema,
    notes: guidance.optional(),
  })
  .strict()
  .refine((example) => JSON.stringify(example.input).length <= MAX_EXAMPLE_INPUT_LENGTH, { message: `example input must serialize to at most ${MAX_EXAMPLE_INPUT_LENGTH} characters`, path: ["input"] });
export type ToolboxExample = z.infer<typeof ToolboxExampleSchema>;

/**
 * How a catalog presents one Tool to humans and agents. Discovery metadata
 * only, and never authority: strict, so a field such as `permissionClasses`,
 * `inputSchema`, `outputSchema`, `retrySafety`, `idempotency`, `handler`, or
 * an Approval policy is rejected. Those stay with the Tool definition and
 * the Tool Registry. `replacementRef` informs readers; nothing rewrites a
 * call to a deprecated Tool.
 */
export const ToolboxEntrySchema = z
  .object({
    toolRef: ToolboxToolRefSchema,
    category: slug,
    tags: z.array(slug).min(1).max(16),
    whenToUse: z.array(guidance).min(1).max(8),
    whenNotToUse: z.array(guidance).min(1).max(8),
    examples: z.array(ToolboxExampleSchema).min(1).max(4),
    status: z.enum(["active", "deprecated"]).default("active"),
    replacementRef: ToolboxToolRefSchema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (new Set(entry.tags).size !== entry.tags.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tags"], message: "tags must be unique" });
    if (entry.replacementRef !== undefined && entry.status !== "deprecated") context.addIssue({ code: z.ZodIssueCode.custom, path: ["replacementRef"], message: "replacementRef is allowed only on a deprecated entry" });
    if (entry.replacementRef !== undefined && toolRefKey(entry.replacementRef) === toolRefKey(entry.toolRef)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["replacementRef"], message: "an entry cannot replace itself" });
  });
export type ToolboxEntry = z.infer<typeof ToolboxEntrySchema>;
export type ToolboxEntryInput = z.input<typeof ToolboxEntrySchema>;

/** ToolboxManifest V1: identity, a human description, and one entry per Tool. Strict and JSON-safe. */
export const ToolboxManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifierSchema.max(128),
    version: ToolboxVersionSchema,
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(1000),
    entries: z.array(ToolboxEntrySchema).min(1).max(64),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    manifest.entries.forEach((entry, index) => {
      const key = toolRefKey(entry.toolRef);
      if (seen.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index, "toolRef"], message: `Tool ${entry.toolRef.id}@${entry.toolRef.version} has more than one entry` });
      seen.add(key);
    });
    manifest.entries.forEach((entry, index) => {
      if (entry.replacementRef !== undefined && !seen.has(toolRefKey(entry.replacementRef))) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", index, "replacementRef"], message: `replacement ${entry.replacementRef.id}@${entry.replacementRef.version} is not an entry of this Toolbox` });
      }
    });
  });
export type ToolboxManifest = z.infer<typeof ToolboxManifestSchema>;
/** What a developer writes: the manifest with `schemaVersion` and entry `status` optional (they default to 1 and "active"). */
export type ToolboxManifestInput = Omit<z.input<typeof ToolboxManifestSchema>, "schemaVersion"> & { schemaVersion?: 1 };

// --- The Toolbox ------------------------------------------------------------------

/** A catalog view of one entry: the entry's discovery metadata plus descriptive fields read from the Tool's canonical `ToolSpec`. No handler, schema validator, or runtime state. */
export interface ToolboxCatalogEntry {
  readonly toolRef: ToolboxToolRef;
  /** From the canonical `ToolSpec`. */
  readonly name: string;
  /** From the canonical `ToolSpec`. */
  readonly description: string;
  /** From the canonical `ToolSpec`: informational. Authorization reads the registered spec, never this copy. */
  readonly permissionClasses: readonly PermissionClass[];
  readonly category: string;
  readonly tags: readonly string[];
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly examples: readonly ToolboxExample[];
  readonly status: "active" | "deprecated";
  readonly replacementRef?: ToolboxToolRef;
}

/**
 * A defined Toolbox: an exact identity, its frozen manifest, and a catalog
 * fingerprint. It holds no executable state that a caller can reach: the
 * Tool definitions are private, and only `selectToolboxTools` hands out
 * the exact ones a host names. A Toolbox never executes, authorizes,
 * retries, or registers anything.
 */
export interface Toolbox {
  readonly ref: ToolboxRef;
  readonly manifest: ToolboxManifest;
  /**
   * SHA-256 over the canonical manifest (non-executable metadata and exact
   * Tool refs): catalog/package identity. It is not a software attestation
   * and never hashes handler code.
   */
  readonly fingerprint: string;
}

export interface DefineToolboxInput {
  manifest: ToolboxManifestInput;
  /** Normal AAO Tool definitions (`defineTool`). Exactly one per manifest entry. */
  tools: readonly ToolDefinition[];
}

/** Private per-Toolbox state, keyed by the Toolbox object itself. Not global: an entry exists only for a Toolbox some caller defined. */
interface ToolboxState {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly entries: readonly ToolboxCatalogEntry[];
}
const states = new WeakMap<Toolbox, ToolboxState>();

/** Permission classes a Toolbox admits. A curation rule, not authority: the Tool Runtime support gate and Authorization still decide every execution. */
const ADMISSIBLE_PERMISSION_CLASSES: readonly PermissionClass[] = ["read_only", "write_draft"];
const MIN_TOOL_DESCRIPTION_LENGTH = 40;
const MAX_TOOLS = 64;

export const toolRefKey = (ref: { id: string; version: string }): string => JSON.stringify([ref.id, ref.version]);
const label = (ref: { id: string; version: string }) => `${ref.id}@${ref.version}`;
const compareRefs = (a: { id: string; version: string }, b: { id: string; version: string }) => compareCodeUnits(a.id, b.id) || compareCodeUnits(a.version, b.version);

/**
 * Defines a Toolbox from a manifest and normal AAO Tool definitions,
 * validated as one coherent package:
 *
 * - the manifest is strict, JSON-safe, versioned, and exact-ref only;
 * - every Tool is re-validated through `defineTool` (the canonical Tool
 *   Registry checks) and snapshotted, so later mutation of the caller's
 *   spec or handler object cannot change it;
 * - every Tool version is exact, its description is substantive, and its
 *   permission classes are `read_only`/`write_draft` only;
 * - entries and Tools correspond one to one: no orphan entry, no
 *   undocumented Tool, no duplicate ref.
 *
 * Defining a Toolbox registers nothing and grants nothing. Hosts select
 * Tools explicitly (`selectToolboxTools`) and register them with
 * `createAAO`, where the normal Tool Runtime governs every call.
 */
export function defineToolbox(input: DefineToolboxInput): Toolbox {
  if (input === null || typeof input !== "object") throw new ToolboxError("TOOLBOX_MANIFEST_INVALID", "defineToolbox requires { manifest, tools }");
  const manifest = parseManifest(input.manifest);
  const tools = snapshotTools(input.tools);

  const issues: string[] = [];
  for (const entry of manifest.entries) if (!tools.has(toolRefKey(entry.toolRef))) issues.push(`entry ${label(entry.toolRef)} has no Tool definition`);
  const entryKeys = new Set(manifest.entries.map((entry) => toolRefKey(entry.toolRef)));
  for (const tool of tools.values()) if (!entryKeys.has(toolRefKey(tool.spec))) issues.push(`Tool ${label(tool.spec)} has no manifest entry`);
  if (issues.length > 0) throw new ToolboxError("TOOLBOX_ENTRY_MISMATCH", "manifest entries and Tool definitions must correspond one to one", issues);

  const entries = manifest.entries.map((entry): ToolboxCatalogEntry => {
    const spec = tools.get(toolRefKey(entry.toolRef))!.spec;
    return {
      toolRef: { ...entry.toolRef },
      name: spec.name,
      description: spec.description!,
      permissionClasses: [...spec.permissionClasses],
      category: entry.category,
      tags: [...entry.tags],
      whenToUse: [...entry.whenToUse],
      whenNotToUse: [...entry.whenNotToUse],
      examples: jsonClone(entry.examples),
      status: entry.status,
      ...(entry.replacementRef !== undefined ? { replacementRef: { ...entry.replacementRef } } : {}),
    };
  });

  const toolbox: Toolbox = deepFreeze({ ref: { id: manifest.id, version: manifest.version }, manifest, fingerprint: sha256Hex(manifest as unknown as JsonValue) });
  states.set(toolbox, Object.freeze({ tools, entries: deepFreeze(entries) }));
  return toolbox;
}

/** Toolbox-internal: the private state of a Toolbox created by `defineToolbox`. A look-alike object is refused. */
export function toolboxState(toolbox: Toolbox): ToolboxState {
  const state = toolbox !== null && typeof toolbox === "object" ? states.get(toolbox) : undefined;
  if (state === undefined) throw new ToolboxError("TOOLBOX_QUERY_INVALID", "not a Toolbox created by defineToolbox");
  return state;
}

/** Strict parse to a canonical, detached, frozen manifest: entries ordered by exact Tool ref, tags sorted, `status` explicit. */
function parseManifest(input: unknown): ToolboxManifest {
  if (!isJsonData(input) || input === null || typeof input !== "object" || Array.isArray(input)) throw new ToolboxError("TOOLBOX_MANIFEST_INVALID", "manifest must be a plain JSON object (no functions, class instances, symbols, or accessors)");
  const candidate = jsonClone(input) as Record<string, unknown>;
  const parsed = ToolboxManifestSchema.safeParse({ schemaVersion: 1, ...candidate });
  if (!parsed.success) throw new ToolboxError("TOOLBOX_MANIFEST_INVALID", "manifest does not satisfy ToolboxManifestSchema", parsed.error.issues.map((issue) => `${issue.path.join(".") || "(manifest)"}: ${issue.message}`));
  const manifest = parsed.data;
  manifest.entries.sort((a, b) => compareRefs(a.toolRef, b.toolRef));
  for (const entry of manifest.entries) entry.tags.sort(compareCodeUnits);
  return deepFreeze(manifest);
}

function snapshotTools(input: unknown): Map<string, ToolDefinition> {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TOOLS) throw new ToolboxError("TOOLBOX_TOOL_INVALID", `tools must be an array of 1 to ${MAX_TOOLS} Tool definitions`);
  const tools = new Map<string, ToolDefinition>();
  for (const [index, candidate] of [...input].entries()) {
    let tool: ToolDefinition;
    try {
      const source = candidate as ToolDefinition;
      // Re-validated and re-captured: the Toolbox owns a frozen spec and a handler bound to the execute function present now.
      tool = defineTool({ spec: source.spec, handler: source.handler, ...(source.retrySafety !== undefined ? { retrySafety: source.retrySafety } : {}), ...(source.idempotency !== undefined ? { idempotency: source.idempotency } : {}) });
    } catch (error) {
      throw new ToolboxError("TOOLBOX_TOOL_INVALID", `tools[${index}] is not a valid AAO Tool definition`, [error instanceof Error ? error.message : "invalid Tool definition"]);
    }
    const { spec } = tool;
    const issues: string[] = [];
    if (!ToolboxVersionSchema.safeParse(spec.version).success) issues.push(`version "${spec.version}" must be an exact MAJOR.MINOR.PATCH version`);
    if ((spec.description?.trim().length ?? 0) < MIN_TOOL_DESCRIPTION_LENGTH || spec.description!.length > 2000) issues.push(`description must state what the Tool does, its limits, and its side effects (${MIN_TOOL_DESCRIPTION_LENGTH}–2000 characters)`);
    const excluded = spec.permissionClasses.filter((permissionClass) => !ADMISSIBLE_PERMISSION_CLASSES.includes(permissionClass));
    if (excluded.length > 0) issues.push(`permission classes ${excluded.join(", ")} are not admissible in a Toolbox (read_only and write_draft only)`);
    if (tools.has(toolRefKey(spec))) issues.push("is defined more than once");
    if (issues.length > 0) throw new ToolboxError("TOOLBOX_TOOL_INVALID", `Tool ${label(spec)} is not admissible`, issues);
    tools.set(toolRefKey(spec), tool);
  }
  return tools;
}
