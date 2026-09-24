import { z } from "zod";

/**
 * `schemaVersion` is the structure of an AAO contract (how a canonical object is
 * shaped). It is distinct from an entity's own `version` (how a particular
 * workflow/agent/tool/etc. has evolved). AAO does not implement a migration
 * engine; each canonical contract simply pins the schema version it currently
 * accepts.
 */
export function schemaVersionSchema(version: number) {
  return z.literal(version);
}

/**
 * A stable, human-readable identifier such as `sales.lead-qualification`,
 * `crm.accounts.search`, or `research.company-profile`. AAO does not require
 * UUIDs for identifiers, but every identifier must be non-empty and safe for
 * deterministic references: no leading/trailing separators, no whitespace.
 */
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9]+(?:[._:-][a-zA-Z0-9]+)*$/;

export const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    IDENTIFIER_PATTERN,
    "must be a non-empty, whitespace-free identifier using letters, numbers, and . _ : - separators",
  );

/** An entity/definition version (e.g. a workflow or tool revision), distinct from `schemaVersion`. */
export const entityVersionSchema = z.string().min(1).max(64);
export type EntityVersion = z.infer<typeof entityVersionSchema>;

/** A persisted timestamp. AAO contracts never carry `Date` instances; ISO strings only. */
export const isoTimestampSchema = z.string().datetime({ offset: true });

// Reusable identifier aliases. These are intentionally plain (non-branded)
// strings: branding would add friction to fixtures, tests, and serialization
// without changing runtime behavior, and the sprint favors simple, stable
// contracts over speculative type-level machinery.
export const WorkflowIdSchema = identifierSchema;
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;

export const NodeIdSchema = identifierSchema;
export type NodeId = z.infer<typeof NodeIdSchema>;

export const RunIdSchema = identifierSchema;
export type RunId = z.infer<typeof RunIdSchema>;

export const CheckpointIdSchema = identifierSchema;
export type CheckpointId = z.infer<typeof CheckpointIdSchema>;

export const AgentIdSchema = identifierSchema;
export type AgentId = z.infer<typeof AgentIdSchema>;

export const SkillIdSchema = identifierSchema;
export type SkillId = z.infer<typeof SkillIdSchema>;

export const ToolIdSchema = identifierSchema;
export type ToolId = z.infer<typeof ToolIdSchema>;

export const CapabilityIdSchema = identifierSchema;
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const PolicyIdSchema = identifierSchema;
export type PolicyId = z.infer<typeof PolicyIdSchema>;

export const ApprovalIdSchema = identifierSchema;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;

export const EvalIdSchema = identifierSchema;
export type EvalId = z.infer<typeof EvalIdSchema>;

export const TraceEventIdSchema = identifierSchema;
export type TraceEventId = z.infer<typeof TraceEventIdSchema>;

export const ArtifactIdSchema = identifierSchema;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const CompanyIdSchema = identifierSchema;
export type CompanyId = z.infer<typeof CompanyIdSchema>;

export const CapabilityPackIdSchema = identifierSchema;
export type CapabilityPackId = z.infer<typeof CapabilityPackIdSchema>;

/**
 * Not in the minimum list of section 6, but required by `AgentSpec.modelPolicyRef`.
 * Same shape as every other identifier; kept separate for read­ability at call sites.
 */
export const ModelPolicyIdSchema = identifierSchema;
export type ModelPolicyId = z.infer<typeof ModelPolicyIdSchema>;

// --- JSON-safe data -------------------------------------------------------
//
// Canonical contracts must not contain functions, class instances, Dates, or
// framework/SDK objects. Anywhere a subsystem's content cannot yet be
// meaningfully typed, it is bounded by JsonValue/JsonObject rather than `any`.

export const JsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, JsonArraySchema, JsonObjectSchema]),
);

export const JsonArraySchema: z.ZodType<JsonArray> = z.lazy(() => z.array(JsonValueSchema));

export const JsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() => z.record(z.string(), JsonValueSchema));
