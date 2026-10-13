import { z } from "zod";
import { EvalReasonCodeSchema, identifierSchema, type JsonObject } from "@aao/contracts";
import { evidenceRefs } from "../evidence.js";
import { assertion, gradeError, judged, zodConfig, type EvalGrader } from "../grader.js";

/**
 * Optional, provider-independent model judge (ADR-022). AAO defines only
 * this port; the host injects an implementation (no model SDK is imported
 * here). Model judges are for genuinely semantic criteria — output quality,
 * groundedness wording — never for permission, Approval, Tool-authorization,
 * or state compliance, which deterministic graders own (the judge grader
 * does not even support those target types).
 */
export const MODEL_JUDGE_LIMITS = Object.freeze({
  maxCriteriaChars: 2000,
  maxDimensions: 8,
  maxDimensionDescriptionChars: 500,
  maxDefects: 16,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
});

export interface ModelJudgeRequest {
  readonly rubric: { readonly criteria: string; readonly dimensions: ReadonlyArray<{ readonly id: string; readonly description: string }> };
  /** Host-selected bounded content only — never the Trace, RunState, Audit stream, Tool payloads, or secrets. */
  readonly subject: { readonly id: string; readonly content: string; readonly context?: Readonly<JsonObject> };
}

/**
 * Structured judgment. No chain-of-thought or free-form rationale field
 * exists; an adapter that returns one (or any unknown field) is rejected.
 * Defect codes are validated but never persisted.
 */
export interface ModelJudgeResult {
  passed: boolean;
  score: number;
  dimensionScores?: Array<{ id: string; score: number }>;
  defects?: Array<{ code: string }>;
  confidence?: number;
}

export interface ModelJudgePort {
  judge(request: ModelJudgeRequest, options: { signal: AbortSignal }): Promise<ModelJudgeResult>;
}

const unit = z.number().min(0).max(1);
const JudgeResultSchema = z
  .object({
    passed: z.boolean(),
    score: unit,
    dimensionScores: z.array(z.object({ id: identifierSchema.max(64), score: unit }).strict()).max(MODEL_JUDGE_LIMITS.maxDimensions).optional(),
    defects: z.array(z.object({ code: EvalReasonCodeSchema }).strict()).max(MODEL_JUDGE_LIMITS.maxDefects).optional(),
    confidence: unit.optional(),
  })
  .strict();

const ConfigSchema = z
  .object({
    rubric: z
      .object({
        criteria: z.string().min(1).max(MODEL_JUDGE_LIMITS.maxCriteriaChars),
        dimensions: z.array(z.object({ id: identifierSchema.max(64), description: z.string().min(1).max(MODEL_JUDGE_LIMITS.maxDimensionDescriptionChars), minScore: unit.optional() }).strict()).max(MODEL_JUDGE_LIMITS.maxDimensions).default([]),
      })
      .strict(),
    passThreshold: unit,
  })
  .strict()
  .refine((config) => new Set(config.rubric.dimensions.map((dimension) => dimension.id)).size === config.rubric.dimensions.length, "dimension ids must be unique");
type Config = z.infer<typeof ConfigSchema>;

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => {
      controller.abort();
      fail(new Error("judge timeout"));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => run(controller.signal)), timeout]).finally(() => clearTimeout(timer));
}

/**
 * `aao.model-judge` — exactly one judge call per evaluation, with no
 * retry, no recursion, and a hard timeout. Any adapter failure, timeout, or
 * out-of-contract output is `error` (`EVAL_MODEL_JUDGE_ERROR`), never
 * `failed`: only a successful structured judgment can fail the criteria.
 * The verdict passes when the judge says `passed` and `score ≥
 * passThreshold` (and each dimension with `minScore` meets it).
 *
 * The result keeps the score and assertion statuses only. The subject,
 * rubric text, defects, and anything else the judge returns are never
 * copied into the EvalResult. A judgment is quality evidence: no code path
 * exists from it to Approval, Authorization, Governance, Tools, Run state,
 * retries, or recovery.
 */
export function createModelJudgeGrader(options: { judge: ModelJudgePort; timeoutMs?: number }): EvalGrader<Config> {
  const timeoutMs = Math.min(Math.max(1, Math.floor(options.timeoutMs ?? MODEL_JUDGE_LIMITS.defaultTimeoutMs)), MODEL_JUDGE_LIMITS.maxTimeoutMs);
  const port = options.judge;
  return {
    id: "aao.model-judge",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["artifact", "run", "node", "trajectory"],
    validateConfig: zodConfig(ConfigSchema),
    async evaluate({ config, evidence }) {
      const subject = evidence.subject;
      if (subject === undefined) return gradeError("EVAL_EVIDENCE_MISSING");
      const subjectRef = evidenceRefs.subject(subject.id);
      const request: ModelJudgeRequest = Object.freeze({
        rubric: Object.freeze({ criteria: config.rubric.criteria, dimensions: Object.freeze(config.rubric.dimensions.map((dimension) => Object.freeze({ id: dimension.id, description: dimension.description }))) }),
        subject: Object.freeze({ id: subject.id, content: subject.content, ...(subject.context ? { context: subject.context as JsonObject } : {}) }),
      });

      let raw: unknown;
      try {
        raw = await withTimeout((signal) => port.judge(request, { signal }), timeoutMs);
      } catch {
        return gradeError("EVAL_MODEL_JUDGE_ERROR", [subjectRef]);
      }
      const parsed = JudgeResultSchema.safeParse(raw);
      if (!parsed.success) return gradeError("EVAL_MODEL_JUDGE_ERROR", [subjectRef]);
      const result = parsed.data;
      const scores = new Map((result.dimensionScores ?? []).map((entry) => [entry.id, entry.score]));
      const known = new Set(config.rubric.dimensions.map((dimension) => dimension.id));
      if (scores.size !== (result.dimensionScores ?? []).length || [...scores.keys()].some((id) => !known.has(id))) return gradeError("EVAL_MODEL_JUDGE_ERROR", [subjectRef]);
      const gated = config.rubric.dimensions.filter((dimension) => dimension.minScore !== undefined);
      if (gated.some((dimension) => !scores.has(dimension.id))) return gradeError("EVAL_MODEL_JUDGE_ERROR", [subjectRef]);

      const verdictOk = result.passed && result.score >= config.passThreshold;
      return judged(
        [
          assertion("judge.verdict", verdictOk, { score: result.score, reasonCode: result.passed ? "JUDGE_SCORE_BELOW_THRESHOLD" : "JUDGE_CRITERIA_NOT_MET", evidenceRefs: [subjectRef] }),
          ...gated.map((dimension) => assertion(`judge.dimension:${dimension.id}`, scores.get(dimension.id)! >= dimension.minScore!, { score: scores.get(dimension.id)!, reasonCode: "JUDGE_DIMENSION_BELOW_MINIMUM", evidenceRefs: [subjectRef] })),
        ],
        result.score,
      );
    },
  };
}
