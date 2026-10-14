import { createHash } from "node:crypto";
import { EvalComparisonIdentitySchema, canonicalJsonStringify, type EvalComparisonIdentity, type EvalResult, type EvalVerdictSummary, type JsonValue } from "@aao/contracts";

/**
 * Identity layers (ADR-023), kept deliberately distinct:
 *
 * - `resultId` (Sprint 17): *observation* identity — one specific
 *   evaluation of one specific evidence. Never a comparison key.
 * - `evidenceFingerprint` (Sprint 17): the exact evidence evaluated.
 *   Its meaning is unchanged here.
 * - `comparisonKey`: the *logical* evaluation — Eval, grader, dataset,
 *   case, mode, target. Excludes Run, Trace, provider, model, result id,
 *   and evidence fingerprint.
 * - `semanticVerdictFingerprint`: the normalized *judgment* for a
 *   comparison key — status, error code, score, and assertion outcomes —
 *   excluding evidence references and execution identity. Provider A and
 *   provider B producing the same canonical AAO behavior share it while
 *   their evidence fingerprints differ.
 */

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(JSON.parse(JSON.stringify(value)) as JsonValue), "utf8").digest("hex");
}

/** Thrown when a result has no dataset/case identity: only dataset cases have a logical comparison identity. */
export class EvalComparisonIdentityError extends Error {
  constructor() {
    super("EVAL_DATASET_INVALID");
    this.name = "EvalComparisonIdentityError";
  }
}

/** The logical comparison identity of a dataset-case result. */
export function buildEvalComparisonIdentity(result: Pick<EvalResult, "evalRef" | "graderRef" | "datasetRef" | "caseId" | "mode" | "targetType">): EvalComparisonIdentity {
  if (result.datasetRef === undefined || result.caseId === undefined) throw new EvalComparisonIdentityError();
  return EvalComparisonIdentitySchema.parse({
    evalRef: { id: result.evalRef.id, version: result.evalRef.version },
    graderRef: { id: result.graderRef.id, version: result.graderRef.version },
    datasetRef: { id: result.datasetRef.id, version: result.datasetRef.version },
    caseId: result.caseId,
    mode: result.mode,
    targetType: result.targetType,
  });
}

export function comparisonKeyOf(identity: EvalComparisonIdentity): string {
  return `evk.${sha256Canonical({ domain: "aao.eval-comparison-key.v1", identity })}`;
}

/** `evk.<sha256>` over the logical identity only. The same case on any provider, Run, or day has one key. */
export function buildEvalComparisonKey(result: Pick<EvalResult, "evalRef" | "graderRef" | "datasetRef" | "caseId" | "mode" | "targetType">): string {
  return comparisonKeyOf(buildEvalComparisonIdentity(result));
}

/** A failed assertion without a reason code still counts, under one stable sentinel. */
export const UNSPECIFIED_REASON_CODE = "ASSERTION_FAILED";

/** The bounded semantic outcome of a result: status, error code, sorted unique failed-assertion reason codes, score. */
export function verdictSummary(result: EvalResult): EvalVerdictSummary {
  const reasonCodes = [...new Set(result.assertions.filter((entry) => entry.status === "failed").map((entry) => entry.reasonCode ?? UNSPECIFIED_REASON_CODE))].sort();
  return {
    status: result.status,
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    reasonCodes,
    ...(result.score !== undefined ? { score: result.score } : {}),
  };
}

/**
 * `evs.<sha256>` over the comparison key and the normalized judgment:
 * status, error code, score, and every assertion's id, status, score, and
 * reason code (sorted by id). Evidence references, Run/Trace ids, result
 * id, provider identity, and the evidence fingerprint never participate.
 */
export function semanticVerdictFingerprint(result: EvalResult): string {
  const assertions = [...result.assertions]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => ({ id: entry.id, status: entry.status, score: entry.score ?? null, reasonCode: entry.reasonCode ?? null }));
  return `evs.${sha256Canonical({
    domain: "aao.eval-semantic-verdict.v1",
    comparisonKey: buildEvalComparisonKey(result),
    status: result.status,
    errorCode: result.errorCode ?? null,
    score: result.score ?? null,
    assertions,
  })}`;
}
