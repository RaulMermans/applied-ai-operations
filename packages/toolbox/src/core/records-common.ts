import type { JsonObject, JsonValue } from "@aao/framework";
import { CORE_TOOL_LIMITS } from "./limits.js";

/** A record: one plain JSON object. Field access is own-property only, so `__proto__`, `constructor`, and `prototype` are ordinary field names. */
export type JsonRecord = JsonObject;

export const recordsSchema = Object.freeze({
  type: "array",
  maxItems: CORE_TOOL_LIMITS.maxRecords,
  items: { type: "object", maxProperties: CORE_TOOL_LIMITS.maxFieldsPerRecord },
  description: `Records (plain JSON objects), at most ${CORE_TOOL_LIMITS.maxRecords}, each with at most ${CORE_TOOL_LIMITS.maxFieldsPerRecord} top-level fields.`,
});

export const fieldNameSchema = Object.freeze({ type: "string", minLength: 1, maxLength: CORE_TOOL_LIMITS.maxFieldNameLength });

export const recordsOutputSchema = Object.freeze({ type: "array", maxItems: CORE_TOOL_LIMITS.maxRecords, items: { type: "object" } });

export const hasField = (record: JsonRecord, field: string): boolean => Object.prototype.hasOwnProperty.call(record, field);

/** Own-property read; `undefined` means the field is missing. */
export const readField = (record: JsonRecord, field: string): JsonValue | undefined => (hasField(record, field) ? (record[field] as JsonValue) : undefined);

/** Copies selected fields with own data properties only (`Object.fromEntries`), never by assignment: no key can reach a prototype. */
export const pickFields = (record: JsonRecord, fields: readonly string[]): JsonRecord => Object.fromEntries(fields.filter((field) => hasField(record, field)).map((field) => [field, record[field] as JsonValue])) as JsonRecord;

/** The serialized-size bound shared by the record Tools. */
export const recordsTooLarge = (records: readonly JsonRecord[]): boolean => JSON.stringify(records).length > CORE_TOOL_LIMITS.maxRecordsSerializedLength;

/** JSON scalars the record Tools compare. Objects and arrays are not comparable. */
export type Scalar = null | boolean | number | string;
export const isScalar = (value: JsonValue): value is Scalar => value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string";

/** Type rank among present non-null scalars: boolean < number < string. */
const typeRank = (value: boolean | number | string): number => (typeof value === "boolean" ? 0 : typeof value === "number" ? 1 : 2);

/**
 * The one canonical scalar order (ascending), used by `records.sort` and
 * `records.count_by`: booleans (false < true), then numbers (numeric), then
 * strings (UTF-16 code-unit order — no locale), then `null`, then missing.
 * A total order, so it is transitive and deterministic. `direction` flips
 * only the order among present non-null values: null and missing always
 * sort last.
 */
export function compareScalars(a: Scalar | undefined, b: Scalar | undefined, direction: 1 | -1 = 1): number {
  const absent = (value: Scalar | undefined) => (value === undefined ? 2 : value === null ? 1 : 0);
  const absentA = absent(a);
  const absentB = absent(b);
  if (absentA !== 0 || absentB !== 0) return absentA - absentB;
  const x = a as boolean | number | string;
  const y = b as boolean | number | string;
  const byType = typeRank(x) - typeRank(y);
  if (byType !== 0) return byType * direction;
  return (x < y ? -1 : x > y ? 1 : 0) * direction;
}
