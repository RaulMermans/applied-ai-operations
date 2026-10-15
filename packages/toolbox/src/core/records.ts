import { canonicalJsonStringify } from "@aao/contracts";
import { defineTool, type JsonValue, type ToolDefinition, type ToolHandlerResult } from "@aao/framework";
import { CORE_TOOL_LIMITS } from "./limits.js";
import { compareScalars, fieldNameSchema, hasField, isScalar, pickFields, readField, recordsOutputSchema, recordsSchema, recordsTooLarge, type JsonRecord, type Scalar } from "./records-common.js";

// Record Tools over caller-supplied JSON records. Exact and deterministic:
// no fuzzy similarity, embeddings, model judgment, JSONPath, expressions, or
// dynamic code. Fields are top-level and read as own properties only.
// Values are never coerced: "1", 1, and true are different; a missing field
// and a null field are different.

const RECORDS_TOO_LARGE = { ok: false, code: "INPUT_TOO_LARGE" } as const;
const selectedFields = (description: string) => ({ type: "array", minItems: 1, maxItems: CORE_TOOL_LIMITS.maxSelectedFields, uniqueItems: true, items: fieldNameSchema, description });
const SIDE_EFFECTS = "Pure computation: no side effects, no model, network, filesystem, or environment access.";
const RECORD_LIMITS = `Limits: at most ${CORE_TOOL_LIMITS.maxRecords} records of at most ${CORE_TOOL_LIMITS.maxFieldsPerRecord} fields each, and ${CORE_TOOL_LIMITS.maxRecordsSerializedLength} characters of serialized records (INPUT_TOO_LARGE).`;

const recordsResultSchema = (meta: Record<string, JsonValue>, required: string[]) => ({
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "empty"] },
    data: { type: "object", properties: { records: recordsOutputSchema }, required: ["records"], additionalProperties: false },
    meta: { type: "object", properties: meta, required, additionalProperties: false },
  },
  required: ["status", "data", "meta"],
  additionalProperties: false,
});

// --- records.dedupe ----------------------------------------------------------------

export interface RecordsDedupeInput {
  records: JsonRecord[];
  keys: string[];
  keep?: "first" | "last";
}

/**
 * Two records are duplicates when every selected key has an equal value:
 * both missing, or both present with equal canonical JSON (object key order
 * ignored; arrays ordered; no type coercion). `keep: "first"` (default) keeps
 * the first record of each group, `"last"` the last one. Either way the kept
 * records stay in their original relative order.
 */
export function dedupeRecords(input: RecordsDedupeInput): ToolHandlerResult {
  const { records, keys } = input;
  if (recordsTooLarge(records)) return RECORDS_TOO_LARGE;
  const keep = input.keep ?? "first";
  const identity = (record: JsonRecord) => JSON.stringify(keys.map((key) => (hasField(record, key) ? ["value", canonicalJsonStringify(record[key] as JsonValue)] : ["missing"])));
  const keptIndexByIdentity = new Map<string, number>();
  records.forEach((record, index) => {
    const id = identity(record);
    if (keep === "last" || !keptIndexByIdentity.has(id)) keptIndexByIdentity.set(id, index);
  });
  const kept = new Set(keptIndexByIdentity.values());
  const output = records.filter((_, index) => kept.has(index));
  return { ok: true, output: { status: output.length === 0 ? "empty" : "success", data: { records: output }, meta: { inputCount: records.length, outputCount: output.length, duplicatesRemoved: records.length - output.length, keys: [...keys], keep } } };
}

export const recordsDedupe: ToolDefinition = defineTool({
  spec: {
    schemaVersion: 1,
    id: "records.dedupe",
    version: "1.0.0",
    name: "Deduplicate records by exact key values",
    description: `Removes duplicate JSON records, where duplicates have exactly equal values for every caller-selected top-level key (a missing key and a null value are different; "1", 1, and true are different; object values compare by canonical JSON). Keeps the first record of each duplicate group by default, or the last with keep: "last", and preserves the original order of kept records. Use it to remove exact repeats before projecting, sorting, or counting. It is not fuzzy matching, similarity search, or entity resolution. ${RECORD_LIMITS} At most ${CORE_TOOL_LIMITS.maxSelectedFields} keys. ${SIDE_EFFECTS}`,
    inputSchema: {
      type: "object",
      properties: { records: recordsSchema, keys: selectedFields("Top-level fields whose values identify a record."), keep: { type: "string", enum: ["first", "last"], description: "Which record of a duplicate group to keep. Default first." } },
      required: ["records", "keys"],
      additionalProperties: false,
    },
    outputSchema: recordsResultSchema(
      { inputCount: { type: "integer", minimum: 0 }, outputCount: { type: "integer", minimum: 0 }, duplicatesRemoved: { type: "integer", minimum: 0 }, keys: { type: "array", items: { type: "string" } }, keep: { type: "string", enum: ["first", "last"] } },
      ["inputCount", "outputCount", "duplicatesRemoved", "keys", "keep"],
    ),
    permissionClasses: ["read_only"],
  },
  handler: { execute: async ({ input }) => dedupeRecords(input as unknown as RecordsDedupeInput) },
  retrySafety: "safe",
});

// --- records.project ---------------------------------------------------------------

export interface RecordsProjectInput {
  records: JsonRecord[];
  fields: string[];
}

/**
 * Keeps only the listed top-level fields, in the listed order, in every
 * record; record order is preserved. A field a record does not have is
 * omitted from that record (never invented as null), and counted in
 * `meta.missing`.
 */
export function projectRecords(input: RecordsProjectInput): ToolHandlerResult {
  const { records, fields } = input;
  if (recordsTooLarge(records)) return RECORDS_TOO_LARGE;
  const output = records.map((record) => pickFields(record, fields));
  const missing = fields.map((field) => ({ field, count: records.filter((record) => !hasField(record, field)).length }));
  return { ok: true, output: { status: output.length === 0 ? "empty" : "success", data: { records: output }, meta: { recordCount: records.length, fields: [...fields], missing } } };
}

export const recordsProject: ToolDefinition = defineTool({
  spec: {
    schemaVersion: 1,
    id: "records.project",
    version: "1.0.0",
    name: "Project record fields",
    description: `Keeps only an explicit list of top-level fields in each JSON record, in the listed order, and preserves record order. A field a record lacks is omitted from that record (never invented as null) and counted per field in meta.missing. Use it to drop fields a later step must not see or does not need. It is not a query language: no JSONPath, nested paths, renaming, computed fields, or expressions. ${RECORD_LIMITS} At most ${CORE_TOOL_LIMITS.maxSelectedFields} fields. ${SIDE_EFFECTS}`,
    inputSchema: {
      type: "object",
      properties: { records: recordsSchema, fields: selectedFields("Top-level fields to keep, in output order.") },
      required: ["records", "fields"],
      additionalProperties: false,
    },
    outputSchema: recordsResultSchema(
      {
        recordCount: { type: "integer", minimum: 0 },
        fields: { type: "array", items: { type: "string" } },
        missing: { type: "array", items: { type: "object", properties: { field: { type: "string" }, count: { type: "integer", minimum: 0 } }, required: ["field", "count"], additionalProperties: false } },
      },
      ["recordCount", "fields", "missing"],
    ),
    permissionClasses: ["read_only"],
  },
  handler: { execute: async ({ input }) => projectRecords(input as unknown as RecordsProjectInput) },
  retrySafety: "safe",
});

// --- records.sort ------------------------------------------------------------------

export interface RecordsSortInput {
  records: JsonRecord[];
  keys: { field: string; direction?: "asc" | "desc" }[];
}

/**
 * Stable, deterministic sort by up to three top-level scalar fields, using
 * the canonical scalar order (`compareScalars`): booleans < numbers <
 * strings (code-unit order, no locale), with null and then missing always
 * last whatever the direction. Ties keep input order. An object or array
 * value in a sort field is refused (`UNSORTABLE_VALUE`); a repeated sort
 * field is refused (`DUPLICATE_SORT_KEY`).
 */
export function sortRecords(input: RecordsSortInput): ToolHandlerResult {
  const { records, keys } = input;
  if (recordsTooLarge(records)) return RECORDS_TOO_LARGE;
  if (new Set(keys.map((key) => key.field)).size !== keys.length) return { ok: false, code: "DUPLICATE_SORT_KEY" };
  const rows: { index: number; values: (Scalar | undefined)[] }[] = [];
  for (const [index, record] of records.entries()) {
    const values: (Scalar | undefined)[] = [];
    for (const key of keys) {
      const value = readField(record, key.field);
      if (value !== undefined && !isScalar(value)) return { ok: false, code: "UNSORTABLE_VALUE" };
      values.push(value);
    }
    rows.push({ index, values });
  }
  const directions = keys.map((key) => (key.direction === "desc" ? -1 : 1) as 1 | -1);
  rows.sort((a, b) => {
    for (let k = 0; k < keys.length; k += 1) {
      const order = compareScalars(a.values[k], b.values[k], directions[k]);
      if (order !== 0) return order;
    }
    return a.index - b.index;
  });
  const output = rows.map((row) => records[row.index]!);
  return { ok: true, output: { status: output.length === 0 ? "empty" : "success", data: { records: output }, meta: { recordCount: records.length, keys: keys.map((key) => ({ field: key.field, direction: key.direction ?? "asc" })) } } };
}

export const recordsSort: ToolDefinition = defineTool({
  spec: {
    schemaVersion: 1,
    id: "records.sort",
    version: "1.0.0",
    name: "Sort records by scalar fields",
    description: `Stably sorts JSON records by up to ${CORE_TOOL_LIMITS.maxSortKeys} top-level scalar fields, each ascending (default) or descending. Order within a field: booleans (false before true), then numbers, then strings by UTF-16 code units (no locale collation); null and then missing values always sort last; ties keep input order. Use it to put records in a deterministic order before presenting or chunking them. It does not sort by nested paths, objects, arrays, or locale rules: a non-scalar value in a sort field fails with UNSORTABLE_VALUE. ${RECORD_LIMITS} ${SIDE_EFFECTS}`,
    inputSchema: {
      type: "object",
      properties: {
        records: recordsSchema,
        keys: {
          type: "array",
          minItems: 1,
          maxItems: CORE_TOOL_LIMITS.maxSortKeys,
          items: { type: "object", properties: { field: fieldNameSchema, direction: { type: "string", enum: ["asc", "desc"] } }, required: ["field"], additionalProperties: false },
          description: "Sort keys, most significant first. Fields must be distinct.",
        },
      },
      required: ["records", "keys"],
      additionalProperties: false,
    },
    outputSchema: recordsResultSchema(
      {
        recordCount: { type: "integer", minimum: 0 },
        keys: { type: "array", items: { type: "object", properties: { field: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] } }, required: ["field", "direction"], additionalProperties: false } },
      },
      ["recordCount", "keys"],
    ),
    permissionClasses: ["read_only"],
  },
  handler: { execute: async ({ input }) => sortRecords(input as unknown as RecordsSortInput) },
  retrySafety: "safe",
});

// --- records.count_by --------------------------------------------------------------

export interface RecordsCountByInput {
  records: JsonRecord[];
  field: string;
}

type GroupKind = "missing" | "null" | "boolean" | "number" | "string";
const kindOf = (value: Scalar | undefined): GroupKind => (value === undefined ? "missing" : value === null ? "null" : (typeof value as "boolean" | "number" | "string"));

/**
 * Counts records per value of one top-level scalar field. Each group names
 * its `kind` (`missing`, `null`, `boolean`, `number`, `string`) and, for
 * the last three, its `value` — no sentinel string that could collide with
 * real data. Groups are ordered by count descending, then by the canonical
 * scalar order (booleans < numbers < strings, then null, then missing). An
 * object or array value is refused (`UNGROUPABLE_VALUE`).
 */
export function countRecordsBy(input: RecordsCountByInput): ToolHandlerResult {
  const { records, field } = input;
  if (recordsTooLarge(records)) return RECORDS_TOO_LARGE;
  const groups = new Map<string, { value: Scalar | undefined; count: number }>();
  for (const record of records) {
    const value = readField(record, field);
    if (value !== undefined && !isScalar(value)) return { ok: false, code: "UNGROUPABLE_VALUE" };
    const key = JSON.stringify([kindOf(value), value ?? null]);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { value, count: 1 });
  }
  const ordered = [...groups.values()].sort((a, b) => b.count - a.count || compareScalars(a.value, b.value));
  const output = ordered.map(({ value, count }): JsonValue => {
    const kind = kindOf(value);
    return kind === "missing" || kind === "null" ? { kind, count } : { kind, value: value as boolean | number | string, count };
  });
  return { ok: true, output: { status: records.length === 0 ? "empty" : "success", data: { groups: output }, meta: { recordCount: records.length, groupCount: output.length, field } } };
}

export const recordsCountBy: ToolDefinition = defineTool({
  spec: {
    schemaVersion: 1,
    id: "records.count_by",
    version: "1.0.0",
    name: "Count records by field value",
    description: `Counts JSON records grouped by the value of one top-level scalar field. Each group reports its kind (missing, null, boolean, number, or string), its value when it has one, and its count, so a missing field, a null, the string "null", and the number 1 versus the string "1" are never confused. Groups are ordered by count (highest first), then booleans, numbers, strings (code-unit order), null, missing. Use it to summarize the distribution of a status or category field. It does not group by nested paths, objects, or arrays (UNGROUPABLE_VALUE), and it computes no other statistics. ${RECORD_LIMITS} ${SIDE_EFFECTS}`,
    inputSchema: {
      type: "object",
      properties: { records: recordsSchema, field: { ...fieldNameSchema, description: "The top-level field to group by." } },
      required: ["records", "field"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "empty"] },
        data: {
          type: "object",
          properties: {
            groups: {
              type: "array",
              maxItems: CORE_TOOL_LIMITS.maxRecords,
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["missing", "null", "boolean", "number", "string"] },
                  value: { anyOf: [{ type: "boolean" }, { type: "number" }, { type: "string" }] },
                  count: { type: "integer", minimum: 1 },
                },
                required: ["kind", "count"],
                additionalProperties: false,
              },
            },
          },
          required: ["groups"],
          additionalProperties: false,
        },
        meta: { type: "object", properties: { recordCount: { type: "integer", minimum: 0 }, groupCount: { type: "integer", minimum: 0 }, field: { type: "string" } }, required: ["recordCount", "groupCount", "field"], additionalProperties: false },
      },
      required: ["status", "data", "meta"],
      additionalProperties: false,
    },
    permissionClasses: ["read_only"],
  },
  handler: { execute: async ({ input }) => countRecordsBy(input as unknown as RecordsCountByInput) },
  retrySafety: "safe",
});
