import type { z } from "zod";
import type { EvalAssertion, EvalErrorCode, EvalMode, EvalTargetType, JsonObject } from "@aao/contracts";
import type { DeepReadonly, EvalEvidenceBundle } from "./evidence.js";

/**
 * What a grader sees: its own validated config, the mode, the target, and
 * a deep-frozen copy of the evidence. There is no Runtime, Governance,
 * Authorization, Approval, Tool, or Durability handle here — a grader can
 * only read evidence and return a verdict.
 */
export interface GraderContext<C> {
  readonly config: C;
  readonly mode: EvalMode;
  readonly targetType: EvalTargetType;
  readonly evidence: DeepReadonly<EvalEvidenceBundle>;
}

/**
 * `judged`: the evidence was trustworthy enough to judge; the result is
 * `passed` exactly when every assertion passed. `error`: no trustworthy
 * judgment (missing, invalid, or incomplete evidence; judge failure).
 */
export type GraderOutcome =
  | { kind: "judged"; assertions: EvalAssertion[]; score?: number }
  | { kind: "error"; code: EvalErrorCode; evidenceRefs?: string[] };

/**
 * A trusted, code-registered grader. Eval definitions select one by exact
 * `id` + `version`; they never name a module, function, or command. The
 * same grader serves OFFLINE and RUNTIME evidence with the same logic.
 * (Method syntax keeps registries of differently-configured graders assignable.)
 */
export interface EvalGrader<C = unknown> {
  readonly id: string;
  readonly version: string;
  readonly supportedModes: readonly EvalMode[];
  readonly supportedTargetTypes: readonly EvalTargetType[];
  validateConfig(config: JsonObject): { ok: true; config: C } | { ok: false };
  evaluate(context: GraderContext<C>): GraderOutcome | Promise<GraderOutcome>;
}

/** Config validation from a strict Zod schema; the parsed config is what the grader receives. */
export function zodConfig<S extends z.ZodTypeAny>(schema: S): (config: JsonObject) => { ok: true; config: z.infer<S> } | { ok: false } {
  return (config) => {
    const parsed = schema.safeParse(config);
    return parsed.success ? { ok: true, config: parsed.data as z.infer<S> } : { ok: false };
  };
}

export const judged = (assertions: EvalAssertion[], score?: number): GraderOutcome => ({ kind: "judged", assertions, ...(score !== undefined ? { score } : {}) });
export const gradeError = (code: EvalErrorCode, evidenceRefs?: string[]): GraderOutcome => ({ kind: "error", code, ...(evidenceRefs ? { evidenceRefs } : {}) });

/** One bounded assertion. Refs are capped and deduplicated; failure reasons are codes, never evidence values. */
export function assertion(id: string, passed: boolean, options: { reasonCode?: string; evidenceRefs?: readonly string[]; score?: number } = {}): EvalAssertion {
  return {
    id,
    status: passed ? "passed" : "failed",
    ...(options.score !== undefined ? { score: options.score } : {}),
    ...(!passed && options.reasonCode ? { reasonCode: options.reasonCode } : {}),
    evidenceRefs: [...new Set(options.evidenceRefs ?? [])].slice(0, 16),
  };
}
