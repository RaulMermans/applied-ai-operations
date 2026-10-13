import { z } from "zod";
import { JsonValueSchema, canonicalJsonStringify, identifierSchema, type JsonValue } from "@aao/contracts";
import { evidenceRefs } from "../evidence.js";
import { assertion, gradeError, judged, zodConfig, type EvalGrader } from "../grader.js";

/** RFC 6901 JSON Pointer into `RunState.values` (`""` is the whole object). No expressions, no wildcards. */
const JsonPointerSchema = z.string().max(512).regex(/^(\/([^~/]|~[01])*)*$/);

const StateCheckSchema = z.discriminatedUnion("op", [
  z.object({ id: identifierSchema.max(64), op: z.literal("revision_equals"), revision: z.number().int().nonnegative() }).strict(),
  z.object({ id: identifierSchema.max(64), op: z.literal("path_exists"), path: JsonPointerSchema }).strict(),
  z.object({ id: identifierSchema.max(64), op: z.literal("path_not_exists"), path: JsonPointerSchema }).strict(),
  z.object({ id: identifierSchema.max(64), op: z.literal("path_equals"), path: JsonPointerSchema, value: JsonValueSchema }).strict(),
]);

const ConfigSchema = z
  .object({ checks: z.array(StateCheckSchema).min(1).max(32) })
  .strict()
  .refine((config) => new Set(config.checks.map((check) => check.id)).size === config.checks.length, "check ids must be unique");
type Config = z.infer<typeof ConfigSchema>;

const MISSING = Symbol("missing");

function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= current.length) return MISSING;
      current = current[Number(token)];
    } else if (current !== null && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return MISSING;
    }
  }
  return current;
}

/**
 * `aao.state-assertion` — bounded deterministic operators over the
 * Runtime's authoritative execution state (revision; JSON Pointer exists,
 * not-exists, equals). State values are compared, never reported: a result
 * carries only the check id, `STATE_ASSERTION_FAILED`, and an
 * `execution://…/state-revision/N` reference — never the actual or
 * expected value. Requires execution evidence.
 */
export function createStateAssertionGrader(): EvalGrader<Config> {
  return {
    id: "aao.state-assertion",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["state"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      const execution = evidence.execution;
      if (execution === undefined) return gradeError("EVAL_EVIDENCE_MISSING");
      if (execution.state.runId !== execution.run.runId) return gradeError("EVAL_EVIDENCE_INVALID");
      const stateRef = evidenceRefs.stateRevision(execution.run.runId, execution.state.revision);
      const values = execution.state.values;
      return judged(
        config.checks.map((check) => {
          let ok: boolean;
          switch (check.op) {
            case "revision_equals":
              ok = execution.state.revision === check.revision;
              break;
            case "path_exists":
              ok = resolvePointer(values, check.path) !== MISSING;
              break;
            case "path_not_exists":
              ok = resolvePointer(values, check.path) === MISSING;
              break;
            case "path_equals": {
              const actual = resolvePointer(values, check.path);
              ok = actual !== MISSING && canonicalJsonStringify(actual as JsonValue) === canonicalJsonStringify(check.value);
              break;
            }
          }
          return assertion(`state:${check.id}`, ok, { reasonCode: "STATE_ASSERTION_FAILED", evidenceRefs: [stateRef] });
        }),
      );
    },
  };
}
