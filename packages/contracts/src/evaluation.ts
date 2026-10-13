import { z } from "zod";
import { EvalIdSchema, JsonObjectSchema, RunIdSchema, entityVersionSchema, identifierSchema, schemaVersionSchema } from "./common.js";

/**
 * Canonical AAO Evaluation contracts (ADR-022,
 * docs/architecture/evaluation-runtime.md). Sprint 2's placeholders
 * (`EvalDefinition` and `EvalResult`, schema version 1) were migrated here
 * rather than duplicated: there is one Eval contract family.
 *
 * Evaluation *observes and judges* AAO execution evidence (Trace, Runtime
 * state, Metrics, Audit). It is never execution authority: no Eval contract
 * can grant permission, approve, change Run state, trigger a Tool, retry,
 * route, recover, or modify Governance. Definitions target canonical AAO
 * semantics (event types, ToolRefs, Run status, permission classes), never
 * a framework or provider. Results reference evidence; they never copy
 * prompts, model output, Tool input/output, state values, approval subjects,
 * or reasoning.
 */

// --- Bounds ----------------------------------------------------------------------

export const EVAL_LIMITS = Object.freeze({
  /** Serialized size of one definition's grader config. */
  maxConfigBytes: 16 * 1024,
  maxAssertionsPerResult: 64,
  maxEvidenceRefsPerResult: 32,
  maxEvidenceRefsPerAssertion: 16,
  maxEvidenceRefLength: 256,
  maxCasesPerDataset: 200,
  maxTagsPerCase: 16,
  maxCategories: 8,
});

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const boundedName = z.string().min(1).max(200);
const boundedDescription = z.string().min(1).max(2000);

/** A machine-readable reason code. Never free text, never a value from the evaluated evidence. */
export const EvalReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

// --- Modes, targets, categories ---------------------------------------------------

/**
 * `OFFLINE`: recorded evidence — committed fixtures, regression cases,
 * synthetic boundary cases, prior Run evidence. No live execution needed.
 * `RUNTIME`: evidence from an actual, current AAO Run at a terminal or safe
 * boundary, handed to the Evaluation Runtime by the host *after* the Runtime
 * returned. Runtime mode is read-only; it is not an evaluator inside the
 * Runtime loop and can never gate execution.
 */
export const EvalModeSchema = z.enum(["OFFLINE", "RUNTIME"]);
export type EvalMode = z.infer<typeof EvalModeSchema>;

/**
 * *What* is evaluated (the grader is *how*). `approval` and `state` were
 * added in Sprint 17 for the Approval-compliance and state-assertion
 * graders. Trajectory evaluation is one grader family under `trajectory`,
 * not a built-in concept.
 */
export const EvalTargetTypeSchema = z.enum(["run", "node", "tool_use", "artifact", "trajectory", "authorization", "approval", "state"]);
export type EvalTargetType = z.infer<typeof EvalTargetTypeSchema>;

/** Descriptive classification for selection and reporting. Categories are not graders and never change grading. */
export const EvalCategorySchema = z.enum(["capability", "regression", "tool_use", "safety", "output_quality", "model_benchmark", "trace_contract", "approval", "trajectory"]);
export type EvalCategory = z.infer<typeof EvalCategorySchema>;

// --- References ----------------------------------------------------------------------

/** Exact Eval Definition identity. A material criterion change requires a new `version`. */
export const EvalRefSchema = z.object({ id: EvalIdSchema, version: entityVersionSchema }).strict();
export type EvalRef = z.infer<typeof EvalRefSchema>;

/** Exact trusted grader identity: a registered implementation, never a module path. Semantic changes require a new version. */
export const EvalGraderRefSchema = z.object({ id: identifierSchema.max(128), version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/) }).strict();
export type EvalGraderRef = z.infer<typeof EvalGraderRefSchema>;

export const EvalDatasetRefSchema = z.object({ id: identifierSchema, version: entityVersionSchema }).strict();
export type EvalDatasetRef = z.infer<typeof EvalDatasetRefSchema>;

/**
 * An opaque, bounded evidence reference such as `trace://run-123/event/17`,
 * `audit://run-123/event/3`, `execution://run-123/state-revision/2`,
 * `metrics://run-123`, or `fixture://tool-denied-001`. A reference names
 * evidence; it never contains it, and AAO never fetches it.
 */
export const EvalEvidenceRefSchema = z
  .string()
  .max(EVAL_LIMITS.maxEvidenceRefLength)
  .regex(/^[a-z][a-z0-9-]{0,31}:\/\/[A-Za-z0-9._:/@+~_-]{1,220}$/, "must be an opaque scheme://path evidence reference");
export type EvalEvidenceRef = z.infer<typeof EvalEvidenceRefSchema>;

// --- No code in Eval data -------------------------------------------------------------

/**
 * Keys that would let Eval data name executable code. Eval definitions and
 * datasets select trusted registered graders by exact reference; they can
 * never load a module, evaluate JavaScript, or run a shell command.
 * Matched exactly, case-insensitively, at any depth.
 */
export const FORBIDDEN_EVAL_CODE_KEYS: readonly string[] = Object.freeze([
  "callback", "code", "command", "eval", "exec", "function", "functionbody", "handler", "import", "javascript", "module", "modulepath", "require", "script", "shell", "shellcommand",
]);

/** Paths of forbidden code-bearing keys anywhere in a JSON value (bounded depth-first scan). */
export function findForbiddenEvalCodeKeys(value: unknown, path = "$"): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbiddenEvalCodeKeys(item, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(FORBIDDEN_EVAL_CODE_KEYS.includes(key.toLowerCase()) ? [`${path}.${key}`] : []),
    ...findForbiddenEvalCodeKeys(child, `${path}.${key}`),
  ]);
}

function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

// --- Eval Definition (schema version 2) -------------------------------------------------

/**
 * An executable, versioned evaluation criterion: which trusted grader
 * (exact id + version) judges which target, under which modes, with which
 * JSON-safe config. The config is generic here; the selected grader
 * validates it before anything executes. Supersedes the Sprint 2
 * placeholder (schema version 1, single `mode`, optional `targetType`).
 */
export const EvalDefinitionSchema = z
  .object({
    schemaVersion: schemaVersionSchema(2),
    id: EvalIdSchema,
    version: entityVersionSchema,
    name: boundedName,
    description: boundedDescription.optional(),
    categories: z.array(EvalCategorySchema).min(1).max(EVAL_LIMITS.maxCategories).optional(),
    supportedModes: z.array(EvalModeSchema).min(1).max(2),
    targetType: EvalTargetTypeSchema,
    graderRef: EvalGraderRefSchema,
    config: JsonObjectSchema,
  })
  .strict()
  .superRefine((definition, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (!uniqueValues(definition.supportedModes)) issue("supportedModes", "modes must be unique");
    if (definition.categories && !uniqueValues(definition.categories)) issue("categories", "categories must be unique");
    if (new TextEncoder().encode(JSON.stringify(definition.config)).length > EVAL_LIMITS.maxConfigBytes) issue("config", `config exceeds ${EVAL_LIMITS.maxConfigBytes} bytes`);
    const forbidden = findForbiddenEvalCodeKeys(definition.config);
    if (forbidden.length > 0) issue("config", `config may not carry code-bearing keys: ${forbidden.slice(0, 4).join(", ")}`);
  });
export type EvalDefinition = z.infer<typeof EvalDefinitionSchema>;

// --- Eval Result (schema version 2) --------------------------------------------------------

/**
 * `passed`: the evaluated system satisfied the criteria. `failed`: the
 * evidence was trustworthy and the system violated a criterion. `error`: the
 * evaluator could not produce a trustworthy judgment (invalid definition,
 * missing/corrupt/incomplete evidence, grader or judge failure). Evaluator
 * error is never reported as `failed`, and missing evidence is never `passed`.
 */
export const EvalResultStatusSchema = z.enum(["passed", "failed", "error"]);
export type EvalResultStatus = z.infer<typeof EvalResultStatusSchema>;

/** The focused Evaluation error taxonomy. Never Runtime failure codes. */
export const EVAL_ERROR_CODES = [
  "EVAL_DEFINITION_NOT_FOUND",
  "EVAL_GRADER_NOT_FOUND",
  "EVAL_GRADER_VERSION_MISMATCH",
  "EVAL_INVALID_DEFINITION",
  "EVAL_MODE_UNSUPPORTED",
  "EVAL_TARGET_UNSUPPORTED",
  "EVAL_EVIDENCE_MISSING",
  "EVAL_EVIDENCE_INVALID",
  "EVAL_REQUIRED_EVIDENCE_INCOMPLETE",
  "EVAL_GRADER_ERROR",
  "EVAL_MODEL_JUDGE_ERROR",
  "EVAL_DATASET_INVALID",
  "EVAL_CASE_ERROR",
] as const;
export const EvalErrorCodeSchema = z.enum(EVAL_ERROR_CODES);
export type EvalErrorCode = z.infer<typeof EvalErrorCodeSchema>;

/**
 * One bounded check. `score` is optional: boolean checks need not invent
 * percentages. `reasonCode` explains a failure without reproducing evidence
 * values (e.g. `STATE_ASSERTION_FAILED`, never the state value).
 */
export const EvalAssertionSchema = z
  .object({
    id: identifierSchema.max(128),
    status: z.enum(["passed", "failed"]),
    score: z.number().min(0).max(1).optional(),
    reasonCode: EvalReasonCodeSchema.optional(),
    evidenceRefs: z.array(EvalEvidenceRefSchema).max(EVAL_LIMITS.maxEvidenceRefsPerAssertion),
  })
  .strict();
export type EvalAssertion = z.infer<typeof EvalAssertionSchema>;

/**
 * The outcome of one evaluation. `resultId` is deterministic over the eval,
 * grader, mode, target, dataset/case, Run/Trace identity, and
 * `evidenceFingerprint` (SHA-256 of the canonical evidence evaluated): the
 * same evaluation over identical evidence yields the same id; changed
 * evidence yields a different one. No timestamp participates. `score`, when
 * present, is normalized to `[0, 1]`.
 */
export const EvalResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema(2),
    resultId: z.string().regex(/^evr\.[a-f0-9]{64}$/),
    evalRef: EvalRefSchema,
    graderRef: EvalGraderRefSchema,
    datasetRef: EvalDatasetRefSchema.optional(),
    caseId: identifierSchema.optional(),
    mode: EvalModeSchema,
    targetType: EvalTargetTypeSchema,
    runId: RunIdSchema.optional(),
    traceId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
    evidenceFingerprint: hex64,
    status: EvalResultStatusSchema,
    score: z.number().min(0).max(1).optional(),
    errorCode: EvalErrorCodeSchema.optional(),
    assertions: z.array(EvalAssertionSchema).max(EVAL_LIMITS.maxAssertionsPerResult),
    evidenceRefs: z.array(EvalEvidenceRefSchema).max(EVAL_LIMITS.maxEvidenceRefsPerResult),
  })
  .strict()
  .superRefine((result, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if ((result.status === "error") !== (result.errorCode !== undefined)) issue("errorCode", "errorCode is present exactly when status is error");
    if ((result.datasetRef === undefined) !== (result.caseId === undefined)) issue("caseId", "datasetRef and caseId come together");
    if (!uniqueValues(result.assertions.map((assertion) => assertion.id))) issue("assertions", "assertion ids must be unique");
    if (result.status === "passed" && (result.assertions.length === 0 || result.assertions.some((assertion) => assertion.status !== "passed"))) issue("status", "a passed result has at least one assertion and every assertion passed");
    if (result.status === "failed" && !result.assertions.some((assertion) => assertion.status === "failed")) issue("status", "a failed result names at least one failed assertion");
  });
export type EvalResult = z.infer<typeof EvalResultSchema>;

// --- Eval Dataset (schema version 1) ----------------------------------------------------------

/**
 * One stable, human-assigned case. The case references its evidence
 * (`evidenceRef`, resolved by an injected host resolver) instead of
 * embedding Runs or Traces, so the same case can later point at a live Run,
 * a recorded regression Trace, or an alternate adapter's Trace. `expected`
 * states the verdict the case exists to prove — including deliberate
 * `failed` (forbidden behavior) and `error` (untrustworthy evidence) cases.
 */
export const EvalCaseSchema = z
  .object({
    id: identifierSchema.max(128),
    name: boundedName.optional(),
    evalRef: EvalRefSchema,
    mode: EvalModeSchema,
    evidenceRef: EvalEvidenceRefSchema,
    expected: z.object({ status: EvalResultStatusSchema, errorCode: EvalErrorCodeSchema.optional() }).strict().optional(),
    tags: z.array(identifierSchema.max(64)).max(EVAL_LIMITS.maxTagsPerCase).optional(),
  })
  .strict()
  .superRefine((evalCase, ctx) => {
    if (evalCase.expected?.errorCode !== undefined && evalCase.expected.status !== "error") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expected", "errorCode"], message: "an expected errorCode requires expected status error" });
    if (evalCase.tags && !uniqueValues(evalCase.tags)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tags"], message: "tags must be unique" });
  });
export type EvalCase = z.infer<typeof EvalCaseSchema>;

/** A versioned, version-controlled product asset: an ordered, bounded list of uniquely identified cases. */
export const EvalDatasetSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: identifierSchema,
    version: entityVersionSchema,
    name: boundedName,
    description: boundedDescription.optional(),
    cases: z.array(EvalCaseSchema).min(1).max(EVAL_LIMITS.maxCasesPerDataset),
  })
  .strict()
  .superRefine((dataset, ctx) => {
    const ids = new Set<string>();
    const contents = new Set<string>();
    dataset.cases.forEach((evalCase, index) => {
      if (ids.has(evalCase.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases", index, "id"], message: `duplicate case id "${evalCase.id}"` });
      ids.add(evalCase.id);
      const content = JSON.stringify([evalCase.evalRef.id, evalCase.evalRef.version, evalCase.mode, evalCase.evidenceRef]);
      if (contents.has(content)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases", index], message: "duplicate case: same eval, mode, and evidence" });
      contents.add(content);
    });
  });
export type EvalDataset = z.infer<typeof EvalDatasetSchema>;

/**
 * The bounded, ordered output of running one dataset: one result per case,
 * in dataset case order. `matchesExpectation` is null when the case states
 * no expectation. This is not analytics — no rates, history, baselines, or
 * thresholds (Sprint 18).
 */
export const EvalDatasetRunSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    datasetRef: EvalDatasetRefSchema,
    cases: z
      .array(z.object({ caseId: identifierSchema.max(128), matchesExpectation: z.boolean().nullable(), result: EvalResultSchema }).strict())
      .max(EVAL_LIMITS.maxCasesPerDataset),
  })
  .strict()
  .superRefine((run, ctx) => {
    run.cases.forEach((entry, index) => {
      if (entry.result.caseId !== entry.caseId || entry.result.datasetRef?.id !== run.datasetRef.id || entry.result.datasetRef?.version !== run.datasetRef.version) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases", index], message: "a case result must carry its dataset and case identity" });
    });
  });
export type EvalDatasetRun = z.infer<typeof EvalDatasetRunSchema>;
