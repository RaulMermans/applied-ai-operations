import { createHash } from "node:crypto";
import { z } from "zod";
import { EvalEvidenceRefSchema, JsonObjectSchema, NodeIdSchema, RunIdSchema, RunStatusSchema, canonicalJsonStringify, entityVersionSchema, identifierSchema, type JsonObject, type JsonValue, type RunStatus } from "@aao/contracts";

/**
 * The one explicit evidence boundary of the Evaluation Runtime (ADR-022).
 * A host assembles an `EvalEvidenceBundle` from evidence AAO already
 * produced — Trace, the Runtime's execution state, Trace-derived
 * RunMetrics, Audit — plus, only for semantic judges, an explicit bounded
 * subject. Evaluation reads it; it never reads stores, files, or the network.
 *
 * Trace, Metrics, and Audit stay `unknown` at this boundary on purpose: a
 * corrupt Trace must reach the trace-contract grader to be judged, and
 * every other grader validates what it reads with the canonical validators
 * (`validateTrace`, `RunMetricsSchema`, `validateAuditStream`) and reports
 * untrustworthy evidence as `error`, never as `passed`.
 */

export const MAX_EVAL_TRACE_EVENTS = 10_000;
export const MAX_EVAL_AUDIT_EVENTS = 10_000;
/** Bound on a semantic subject's content (UTF-8 bytes). */
export const MAX_EVAL_SUBJECT_BYTES = 16 * 1024;
/** Bound on a subject's host-selected structured context (serialized bytes). */
export const MAX_EVAL_SUBJECT_CONTEXT_BYTES = 4 * 1024;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/**
 * The structural Runtime execution evidence state assertions and
 * trace/execution comparison need. A `RuntimeExecutionState` (`@aao/runtime`)
 * satisfies it, so this package never depends on the Runtime.
 */
export const ExecutionEvidenceSchema = z
  .object({
    run: z.object({ runId: RunIdSchema, workflowId: identifierSchema, workflowVersion: entityVersionSchema, status: RunStatusSchema }).passthrough(),
    state: z.object({ runId: RunIdSchema, revision: z.number().int().nonnegative(), values: JsonObjectSchema }).strict(),
    nodeStatusesById: z.record(NodeIdSchema, z.string()),
    step: z.number().int().nonnegative(),
    history: z.array(z.object({ nodeId: NodeIdSchema, step: z.number().int().positive(), status: z.enum(["SUCCEEDED", "FAILED"]), attemptCount: z.number().int().positive() }).passthrough()).max(10_000),
    wait: z.object({ nodeId: NodeIdSchema, referenceId: identifierSchema }).passthrough().optional(),
  })
  .passthrough();

/**
 * The static shape of execution evidence: explicit structural fields with
 * no index signature, so a `RuntimeExecutionState` is assignable as-is.
 * `ExecutionEvidenceSchema` validates the same fields at runtime and lets
 * any additional Runtime fields through.
 */
export interface ExecutionEvidence {
  readonly run: { readonly runId: string; readonly workflowId: string; readonly workflowVersion: string; readonly status: RunStatus };
  readonly state: { readonly runId: string; readonly revision: number; readonly values: JsonObject };
  readonly nodeStatusesById: Readonly<Record<string, string>>;
  readonly step: number;
  readonly history: ReadonlyArray<{ readonly nodeId: string; readonly step: number; readonly status: "SUCCEEDED" | "FAILED"; readonly attemptCount: number }>;
  readonly wait?: { readonly nodeId: string; readonly referenceId: string };
}

/**
 * Explicit, bounded, host-selected content for a semantic (model-judge)
 * evaluation. It is never taken automatically from Trace, RunState, Audit,
 * or Tool payloads, and it is never copied into an EvalResult.
 */
export const EvalSubjectSchema = z
  .object({
    id: identifierSchema.max(128),
    content: z.string().min(1).refine((value) => utf8Bytes(value) <= MAX_EVAL_SUBJECT_BYTES, `content exceeds ${MAX_EVAL_SUBJECT_BYTES} bytes`),
    context: JsonObjectSchema.refine((value) => utf8Bytes(JSON.stringify(value)) <= MAX_EVAL_SUBJECT_CONTEXT_BYTES, `context exceeds ${MAX_EVAL_SUBJECT_CONTEXT_BYTES} bytes`).optional(),
  })
  .strict();
export type EvalSubject = z.infer<typeof EvalSubjectSchema>;

/**
 * `origin` states where the evidence came from and binds it to a mode:
 * `live_run` evidence (a real current Run, handed over after the Runtime
 * returned) is evaluated in `RUNTIME` mode; `recorded` evidence (fixtures,
 * regression traces, synthetic boundary cases, prior Runs) in `OFFLINE`
 * mode. `source` is an optional opaque reference to where the host found
 * it (e.g. `fixture://tool-denied-001`); it is not part of the fingerprint.
 */
export const EvalEvidenceBundleSchema = z
  .object({
    origin: z.enum(["live_run", "recorded"]),
    source: EvalEvidenceRefSchema.optional(),
    runId: RunIdSchema.optional(),
    trace: z.array(z.unknown()).max(MAX_EVAL_TRACE_EVENTS).optional(),
    execution: ExecutionEvidenceSchema.optional(),
    metrics: z.unknown().optional(),
    audit: z.array(z.unknown()).max(MAX_EVAL_AUDIT_EVENTS).optional(),
    subject: EvalSubjectSchema.optional(),
  })
  .strict();

/** The static evidence boundary; `EvalEvidenceBundleSchema` is its runtime validator. */
export interface EvalEvidenceBundle {
  readonly origin: "live_run" | "recorded";
  readonly source?: string;
  readonly runId?: string;
  readonly trace?: readonly unknown[];
  readonly execution?: ExecutionEvidence;
  readonly metrics?: unknown;
  readonly audit?: readonly unknown[];
  readonly subject?: EvalSubject;
}

export type DeepReadonly<T> = T extends (infer U)[] ? ReadonlyArray<DeepReadonly<U>> : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** True for plain JSON data (objects, arrays, strings, finite numbers, booleans, null); `undefined` object properties count as absent. */
export function isEvalJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isEvalJsonSafe(item, depth + 1));
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every((child) => child === undefined || isEvalJsonSafe(child, depth + 1));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * A defensive, deep-frozen JSON copy of the evidence. Graders receive only
 * this copy, so no grader can mutate the authoritative RuntimeExecutionState,
 * Trace events, RunMetrics, or Audit events the host passed in.
 */
export function freezeEvidence(bundle: EvalEvidenceBundle): DeepReadonly<EvalEvidenceBundle> {
  return deepFreeze(JSON.parse(JSON.stringify(bundle)) as EvalEvidenceBundle);
}

/**
 * Deterministic SHA-256 over the canonical JSON of the evidence actually
 * evaluated (Run id, Trace, execution, Metrics, Audit, subject). The
 * `origin` and `source` pointer are excluded: the same evidence found
 * through a different reference fingerprints the same. It is a
 * reproducibility key, never authority.
 */
export function evidenceFingerprint(bundle: DeepReadonly<EvalEvidenceBundle> | EvalEvidenceBundle): string {
  const material = { domain: "aao.eval-evidence.v1", runId: bundle.runId ?? null, trace: bundle.trace ?? null, execution: bundle.execution ?? null, metrics: bundle.metrics ?? null, audit: bundle.audit ?? null, subject: bundle.subject ?? null };
  return createHash("sha256").update(canonicalJsonStringify(JSON.parse(JSON.stringify(material)) as JsonValue), "utf8").digest("hex");
}

// --- Opaque evidence references (never payloads) -------------------------------------

export const evidenceRefs = Object.freeze({
  traceEvent: (runId: string, sequence: number) => `trace://${runId}/event/${sequence}`,
  auditEvent: (runId: string, sequence: number) => `audit://${runId}/event/${sequence}`,
  stateRevision: (runId: string, revision: number) => `execution://${runId}/state-revision/${revision}`,
  metrics: (runId: string) => `metrics://${runId}`,
  subject: (subjectId: string) => `subject://${subjectId}`,
});
