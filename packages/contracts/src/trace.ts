import { z } from "zod";
import { JsonObjectSchema, NodeIdSchema, RunIdSchema, TraceEventIdSchema, identifierSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";

/**
 * The canonical event envelope a future observability layer will use. This
 * sprint builds no Trace Store, OpenTelemetry export, or metrics pipeline —
 * only the shape that makes those possible.
 *
 * `type` follows a stable dot-namespaced convention, e.g. `run.status_changed`,
 * `node.started`, `tool.invoked`, `approval.requested` (reusing `identifierSchema`,
 * which already allows `.` as a separator). `payload` is a JSON-safe boundary
 * so event-specific detail never forces changes to the envelope itself.
 */
export const TraceEventSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    eventId: TraceEventIdSchema,
    runId: RunIdSchema,
    sequence: z.number().int().nonnegative(),
    occurredAt: isoTimestampSchema,
    type: identifierSchema,
    nodeId: NodeIdSchema.optional(),
    payload: JsonObjectSchema,
  })
  .strict();
export type TraceEvent = z.infer<typeof TraceEventSchema>;
