import { z } from "zod";
import { CheckpointIdSchema, JsonObjectSchema, RunIdSchema, isoTimestampSchema, schemaVersionSchema } from "./common.js";

/**
 * State, short-term context, and long-term memory are distinct AAO concepts
 * (see `docs/architecture/state-memory-durability.md`). `RunState` is
 * authoritative active workflow data for one run — not model context, not
 * logs, not long-term memory. It implements no reducer; this is a data
 * contract only.
 */
export const RunStateSchema = z
  .object({
    runId: RunIdSchema,
    revision: z.number().int().nonnegative(),
    values: JsonObjectSchema,
  })
  .strict();
export type RunState = z.infer<typeof RunStateSchema>;

/**
 * An immutable point-in-execution capture of `RunState`. A snapshot is domain
 * data, not a persistence guarantee — it says nothing about how or whether it
 * was durably stored.
 */
export const StateSnapshotSchema = z
  .object({
    runId: RunIdSchema,
    revision: z.number().int().nonnegative(),
    values: JsonObjectSchema,
    capturedAt: isoTimestampSchema,
  })
  .strict();
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;

/**
 * A contract for recovery state, not proof that persistence exists. This
 * schema makes no claim of exactly-once execution, transactional external
 * actions, or crash-safe/durable storage — those are future implementation
 * guarantees layered on top of this shape.
 */
export const CheckpointRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    checkpointId: CheckpointIdSchema,
    runId: RunIdSchema,
    stateRevision: z.number().int().nonnegative(),
    createdAt: isoTimestampSchema,
    stateSnapshot: StateSnapshotSchema,
  })
  .strict();
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;
