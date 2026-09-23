import { z } from "zod";
import { EvalIdSchema, RunIdSchema, entityVersionSchema, schemaVersionSchema } from "./common.js";

/** Offline evaluation runs outside a live execution (regression/benchmark suites); runtime evaluation runs during/against a live run. */
export const EvalModeSchema = z.enum(["OFFLINE", "RUNTIME"]);
export type EvalMode = z.infer<typeof EvalModeSchema>;

/**
 * The kinds of thing a future evaluator can target. GPA/trajectory
 * evaluation is intentionally not hardcoded into the base architecture — it
 * is expected to become one evaluator family under `trajectory`, not a
 * built-in concept.
 */
export const EvalTargetTypeSchema = z.enum(["run", "node", "tool_use", "artifact", "trajectory", "authorization"]);
export type EvalTargetType = z.infer<typeof EvalTargetTypeSchema>;

/**
 * The definition of an evaluation, not its execution. No evaluator
 * implementation, evaluation runtime, or CI regression gate is built in this
 * sprint.
 */
export const EvalDefinitionSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: EvalIdSchema,
    version: entityVersionSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    mode: EvalModeSchema,
    targetType: EvalTargetTypeSchema.optional(),
  })
  .strict();
export type EvalDefinition = z.infer<typeof EvalDefinitionSchema>;

/**
 * Not every evaluator naturally produces a numeric score — a `passed` or
 * `failed` result is allowed to exist without one. When `score` is present it
 * is a normalized value in `[0, 1]`, where `1` means fully meets the
 * evaluation criteria and `0` means it does not meet them at all; individual
 * evaluators define what the criteria are.
 */
export const EvalResultStatusSchema = z.enum(["passed", "failed", "error"]);
export type EvalResultStatus = z.infer<typeof EvalResultStatusSchema>;

export const EvalResultSchema = z
  .object({
    evalId: EvalIdSchema,
    runId: RunIdSchema.optional(),
    status: EvalResultStatusSchema,
    score: z.number().min(0).max(1).optional(),
    reason: z.string().optional(),
    evidenceRefs: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type EvalResult = z.infer<typeof EvalResultSchema>;
