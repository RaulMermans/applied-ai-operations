import { EvalGraderRefSchema, EvalModeSchema, EvalTargetTypeSchema, type EvalGraderRef } from "@aao/contracts";
import type { EvalGrader } from "./grader.js";

export const EVALUATOR_REGISTRY_ERROR_CODES = ["EVALUATOR_INVALID_GRADER", "EVALUATOR_DUPLICATE_GRADER"] as const;
export type EvaluatorRegistryErrorCode = (typeof EVALUATOR_REGISTRY_ERROR_CODES)[number];

export class EvaluatorRegistryError extends Error {
  constructor(readonly code: EvaluatorRegistryErrorCode) {
    super(code);
    this.name = "EvaluatorRegistryError";
  }
}

export type GraderLookup = { ok: true; grader: EvalGrader } | { ok: false; code: "EVAL_GRADER_NOT_FOUND" | "EVAL_GRADER_VERSION_MISMATCH" };

/**
 * Explicit, constructible (never a singleton) registry of trusted grader
 * code. Registration is the only way in: no filesystem discovery, no
 * dynamic import, no module path. Lookup is exact on id + version, so a
 * grader's semantics cannot change under an existing EvalResult.
 */
export interface EvaluatorRegistry {
  register(grader: EvalGrader): void;
  resolve(ref: EvalGraderRef): GraderLookup;
  list(): EvalGraderRef[];
}

const key = (ref: EvalGraderRef) => `${ref.id}@${ref.version}`;

export function createEvaluatorRegistry(graders: readonly EvalGrader[] = []): EvaluatorRegistry {
  const byKey = new Map<string, EvalGrader>();
  const ids = new Set<string>();

  const register = (grader: EvalGrader) => {
    const ref = EvalGraderRefSchema.safeParse({ id: grader?.id, version: grader?.version });
    const modes = grader?.supportedModes;
    const targets = grader?.supportedTargetTypes;
    if (
      !ref.success ||
      !Array.isArray(modes) || modes.length === 0 || !modes.every((mode) => EvalModeSchema.safeParse(mode).success) ||
      !Array.isArray(targets) || targets.length === 0 || !targets.every((target) => EvalTargetTypeSchema.safeParse(target).success) ||
      typeof grader.validateConfig !== "function" || typeof grader.evaluate !== "function"
    ) throw new EvaluatorRegistryError("EVALUATOR_INVALID_GRADER");
    if (byKey.has(key(ref.data))) throw new EvaluatorRegistryError("EVALUATOR_DUPLICATE_GRADER");
    // Snapshot the declared capabilities so later mutation of the grader object cannot widen them.
    const supportedModes = Object.freeze([...modes]);
    const supportedTargetTypes = Object.freeze([...targets]);
    byKey.set(key(ref.data), Object.freeze({
      id: ref.data.id,
      version: ref.data.version,
      supportedModes,
      supportedTargetTypes,
      validateConfig: (config) => grader.validateConfig(config),
      evaluate: (context) => grader.evaluate(context),
    } satisfies EvalGrader));
    ids.add(ref.data.id);
  };

  for (const grader of graders) register(grader);

  return Object.freeze({
    register,
    resolve(ref: EvalGraderRef): GraderLookup {
      const grader = byKey.get(key(ref));
      if (grader) return { ok: true, grader };
      return { ok: false, code: ids.has(ref.id) ? "EVAL_GRADER_VERSION_MISMATCH" : "EVAL_GRADER_NOT_FOUND" };
    },
    list: () => [...byKey.values()].map((grader) => ({ id: grader.id, version: grader.version })).sort((a, b) => key(a).localeCompare(key(b))),
  });
}
