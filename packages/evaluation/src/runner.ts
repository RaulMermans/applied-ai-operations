import { createHash } from "node:crypto";
import {
  EVAL_LIMITS,
  EvalAssertionSchema,
  EvalDatasetRefSchema,
  EvalDefinitionSchema,
  EvalModeSchema,
  EvalResultSchema,
  canonicalJsonStringify,
  identifierSchema,
  type EvalAssertion,
  type EvalDatasetRef,
  type EvalDefinition,
  type EvalErrorCode,
  type EvalMode,
  type EvalResult,
  type JsonValue,
} from "@aao/contracts";
import { EvalEvidenceBundleSchema, evidenceFingerprint, freezeEvidence, isEvalJsonSafe, type DeepReadonly, type EvalEvidenceBundle } from "./evidence.js";
import type { GraderOutcome } from "./grader.js";
import type { EvaluatorRegistry } from "./registry.js";

/**
 * Thrown only when the caller passes something that cannot be identified as
 * an evaluation at all (a definition failing `EvalDefinitionSchema`, an
 * unknown mode, malformed dataset/case identity). Everything identifiable —
 * unknown grader, invalid grader config, unsupported mode or target,
 * missing or corrupt evidence, grader or judge failure — becomes an
 * `error` EvalResult instead, so a dataset never loses a case silently.
 */
export class EvalInputError extends Error {
  constructor(readonly code: "EVAL_INVALID_DEFINITION" | "EVAL_MODE_UNSUPPORTED" | "EVAL_DATASET_INVALID") {
    super(code);
    this.name = "EvalInputError";
  }
}

export interface EvaluateParams {
  definition: EvalDefinition;
  mode: EvalMode;
  evidence: EvalEvidenceBundle;
  registry: EvaluatorRegistry;
  /** Present together when the evaluation is one case of a versioned dataset. */
  datasetRef?: EvalDatasetRef;
  caseId?: string;
}

interface Identity {
  runId?: string;
  traceId?: string;
}

/**
 * Deterministic result identity: SHA-256 over the eval, grader, mode,
 * target, dataset/case, Run/Trace identity, and evidence fingerprint. No
 * clock and no randomness, so the same evaluation over identical evidence
 * always has the same id.
 */
export function deriveEvalResultId(material: { evalRef: { id: string; version: string }; graderRef: { id: string; version: string }; mode: EvalMode; targetType: string; datasetRef?: EvalDatasetRef; caseId?: string; runId?: string; traceId?: string; evidenceFingerprint: string }): string {
  const canonical = canonicalJsonStringify({
    domain: "aao.eval-result.v2",
    evalRef: material.evalRef,
    graderRef: material.graderRef,
    mode: material.mode,
    targetType: material.targetType,
    datasetRef: material.datasetRef ?? null,
    caseId: material.caseId ?? null,
    runId: material.runId ?? null,
    traceId: material.traceId ?? null,
    evidenceFingerprint: material.evidenceFingerprint,
  } as unknown as JsonValue);
  return `evr.${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/**
 * Run and Trace identity across every evidence part. Evidence from two
 * different Runs (or a trace whose events disagree with the Metrics' trace
 * id) cannot be judged together: that is untrustworthy evidence, not a
 * behavior violation.
 */
function identityOf(evidence: DeepReadonly<EvalEvidenceBundle>): { ok: true; identity: Identity } | { ok: false } {
  const runIds = new Set<string>();
  const traceIds = new Set<string>();
  const addRun = (value: unknown) => { if (typeof value === "string") runIds.add(value); };
  const addTrace = (value: unknown) => { if (typeof value === "string") traceIds.add(value); };
  addRun(evidence.runId);
  addRun(evidence.execution?.run.runId);
  addRun(evidence.execution?.state.runId);
  const firstEvent = asRecord(evidence.trace?.[0]);
  addRun(firstEvent?.runId);
  addTrace(firstEvent?.traceId);
  const metrics = asRecord(evidence.metrics);
  addRun(metrics?.runId);
  addTrace(metrics?.traceId);
  for (const event of evidence.audit ?? []) addRun(asRecord(event)?.runId);
  if (runIds.size > 1 || traceIds.size > 1) return { ok: false };
  const [runId] = [...runIds];
  const [traceId] = [...traceIds];
  return { ok: true, identity: { ...(runId !== undefined ? { runId } : {}), ...(traceId !== undefined && /^[a-f0-9]{32}$/.test(traceId) ? { traceId } : {}) } };
}

function build(params: { definition: EvalDefinition; mode: EvalMode; datasetRef?: EvalDatasetRef; caseId?: string; identity: Identity; fingerprint: string; source?: string; outcome: GraderOutcome }): EvalResult {
  const { definition, mode, identity, fingerprint, outcome } = params;
  const evalRef = { id: definition.id, version: definition.version };
  const graderRef = { id: definition.graderRef.id, version: definition.graderRef.version };
  const base = {
    schemaVersion: 2 as const,
    resultId: deriveEvalResultId({ evalRef, graderRef, mode, targetType: definition.targetType, ...(params.datasetRef ? { datasetRef: params.datasetRef } : {}), ...(params.caseId ? { caseId: params.caseId } : {}), ...identity, evidenceFingerprint: fingerprint }),
    evalRef,
    graderRef,
    ...(params.datasetRef ? { datasetRef: { id: params.datasetRef.id, version: params.datasetRef.version } } : {}),
    ...(params.caseId ? { caseId: params.caseId } : {}),
    mode,
    targetType: definition.targetType,
    ...identity,
    evidenceFingerprint: fingerprint,
  };
  const refs = (extra: readonly string[]) => [...new Set([...(params.source ? [params.source] : []), ...extra])].slice(0, EVAL_LIMITS.maxEvidenceRefsPerResult);

  if (outcome.kind === "error") {
    const candidate = { ...base, status: "error" as const, errorCode: outcome.code, assertions: [], evidenceRefs: refs(outcome.evidenceRefs ?? []) };
    const parsed = EvalResultSchema.safeParse(candidate);
    return parsed.success ? parsed.data : { ...base, status: "error", errorCode: outcome.code, assertions: [], evidenceRefs: refs([]) };
  }
  const assertions = outcome.assertions;
  const status = assertions.every((entry) => entry.status === "passed") ? ("passed" as const) : ("failed" as const);
  const candidate = { ...base, status, ...(outcome.score !== undefined ? { score: outcome.score } : {}), assertions, evidenceRefs: refs(assertions.flatMap((entry) => entry.evidenceRefs)) };
  const parsed = EvalResultSchema.safeParse(candidate);
  // A grader that produced an out-of-contract verdict is a grader defect, never a system failure.
  return parsed.success ? parsed.data : build({ ...params, outcome: { kind: "error", code: "EVAL_GRADER_ERROR" } });
}

function validGraderOutcome(outcome: unknown): GraderOutcome | undefined {
  const record = asRecord(outcome);
  if (record?.kind === "error") return typeof record.code === "string" ? (outcome as GraderOutcome) : undefined;
  if (record?.kind !== "judged" || !Array.isArray(record.assertions)) return undefined;
  if (record.assertions.length === 0 || record.assertions.length > EVAL_LIMITS.maxAssertionsPerResult) return undefined;
  if (!record.assertions.every((entry) => EvalAssertionSchema.safeParse(entry).success)) return undefined;
  if (record.score !== undefined && (typeof record.score !== "number" || !(record.score >= 0 && record.score <= 1))) return undefined;
  return { kind: "judged", assertions: (record.assertions as EvalAssertion[]).map((entry) => ({ ...entry, evidenceRefs: [...entry.evidenceRefs] })), ...(record.score !== undefined ? { score: record.score as number } : {}) };
}

/**
 * Evaluate one definition against one evidence bundle. Read-only and
 * non-authoritative: it receives evidence the host already holds, hands a
 * deep-frozen copy to a trusted registered grader, and returns a
 * serializable EvalResult. It never calls back into execution.
 *
 * Order: definition identity → mode support → grader lookup (exact
 * version) → grader mode/target support → grader config validation →
 * evidence shape, JSON safety, mode/origin binding, and identity coherence
 * → grader (exceptions contained) → bounded result.
 */
export async function evaluate(params: EvaluateParams): Promise<EvalResult> {
  const definitionParsed = EvalDefinitionSchema.safeParse(params.definition);
  if (!definitionParsed.success) throw new EvalInputError("EVAL_INVALID_DEFINITION");
  if (!EvalModeSchema.safeParse(params.mode).success) throw new EvalInputError("EVAL_MODE_UNSUPPORTED");
  if ((params.datasetRef === undefined) !== (params.caseId === undefined) || (params.datasetRef && !EvalDatasetRefSchema.safeParse(params.datasetRef).success) || (params.caseId !== undefined && !identifierSchema.safeParse(params.caseId).success)) throw new EvalInputError("EVAL_DATASET_INVALID");
  const definition = definitionParsed.data;
  const mode = params.mode;
  const context = { definition, mode, ...(params.datasetRef ? { datasetRef: params.datasetRef, caseId: params.caseId! } : {}) };

  // Evidence is copied before anything else touches it; the host's objects are never handed to a grader.
  const shapeOk = isEvalJsonSafe(params.evidence) && EvalEvidenceBundleSchema.safeParse(params.evidence).success;
  const evidence = shapeOk ? freezeEvidence(params.evidence) : undefined;
  const fingerprint = evidence ? evidenceFingerprint(evidence) : evidenceFingerprint({ origin: "recorded" });
  const identityResult: ReturnType<typeof identityOf> = evidence ? identityOf(evidence) : { ok: true, identity: {} };
  const identity: Identity = identityResult.ok ? identityResult.identity : {};
  const source = evidence?.source;
  const fail = (code: EvalErrorCode): EvalResult => build({ ...context, identity, fingerprint, ...(source ? { source } : {}), outcome: { kind: "error", code } });

  if (!definition.supportedModes.includes(mode)) return fail("EVAL_MODE_UNSUPPORTED");
  const lookup = params.registry.resolve(definition.graderRef);
  if (!lookup.ok) return fail(lookup.code);
  const grader = lookup.grader;
  if (!grader.supportedModes.includes(mode)) return fail("EVAL_MODE_UNSUPPORTED");
  if (!grader.supportedTargetTypes.includes(definition.targetType)) return fail("EVAL_TARGET_UNSUPPORTED");

  let config: { ok: true; config: unknown } | { ok: false };
  try {
    config = grader.validateConfig(definition.config);
  } catch {
    config = { ok: false };
  }
  if (!config.ok) return fail("EVAL_INVALID_DEFINITION");

  if (!evidence || !identityResult.ok) return fail("EVAL_EVIDENCE_INVALID");
  // RUNTIME judges evidence from a real current Run; OFFLINE judges recorded evidence. Never mixed.
  if ((mode === "RUNTIME") !== (evidence.origin === "live_run")) return fail("EVAL_MODE_UNSUPPORTED");
  if (mode === "RUNTIME" && identity.runId === undefined) return fail("EVAL_EVIDENCE_MISSING");

  let outcome: GraderOutcome | undefined;
  try {
    outcome = validGraderOutcome(await grader.evaluate({ config: config.config, mode, targetType: definition.targetType, evidence }));
  } catch {
    // No stack or message is kept: a grader defect is reported only as a bounded code.
    outcome = undefined;
  }
  return build({ ...context, identity, fingerprint, ...(source ? { source } : {}), outcome: outcome ?? { kind: "error", code: "EVAL_GRADER_ERROR" } });
}

/**
 * An `error` result for an identifiable evaluation that never reached a
 * grader because its evidence could not be obtained (dataset case isolation).
 */
export function failedEvaluation(params: { definition: EvalDefinition; mode: EvalMode; datasetRef?: EvalDatasetRef; caseId?: string; source?: string; code: EvalErrorCode }): EvalResult {
  const { code, ...context } = params;
  return build({ ...context, identity: {}, fingerprint: evidenceFingerprint({ origin: "recorded" }), outcome: { kind: "error", code } });
}
