import { z } from "zod";
import { JsonObjectSchema, RunIdSchema, isoTimestampSchema } from "./common.js";

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

// The canonical durable execution checkpoint is `DurableCheckpoint` in
// `@aao/durability` (ADR-019). It wraps the Runtime-owned
// `RuntimeExecutionSnapshot`, which this package cannot depend on, so the
// early Sprint 2 `CheckpointRecord` placeholder was deleted rather than kept
// as a second, competing checkpoint contract.
