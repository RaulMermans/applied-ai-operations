import { parseDocument } from "yaml";
import { z } from "zod";
import {
  EvalDatasetRunSchema,
  EvalDatasetSchema,
  EvalDefinitionSchema,
  EvalEvidenceRefSchema,
  findForbiddenEvalCodeKeys,
  type EvalCase,
  type EvalDataset,
  type EvalDatasetRun,
  type EvalDefinition,
  type EvalResult,
} from "@aao/contracts";
import type { EvalEvidenceBundle } from "./evidence.js";
import type { EvaluatorRegistry } from "./registry.js";
import { evaluate, failedEvaluation } from "./runner.js";

/** Bound on one dataset or definitions source file. */
export const MAX_EVAL_SOURCE_BYTES = 1024 * 1024;
export const MAX_EVAL_DEFINITIONS = 200;

export type EvalSourceFormat = "yaml" | "json";
export interface EvalSourceIssue {
  path: string;
  message: string;
}
export type EvalSourceResult<T> = { ok: true; value: T } | { ok: false; code: "EVAL_DATASET_INVALID" | "EVAL_INVALID_DEFINITION"; issues: EvalSourceIssue[] };

/** Inert data only: JSON, or YAML with the safe core schema, strict, unique keys, bounded size. No code fields at any depth. */
function parseSource(source: string, format: EvalSourceFormat): { ok: true; value: unknown } | { ok: false; issues: EvalSourceIssue[] } {
  if (new TextEncoder().encode(source).length > MAX_EVAL_SOURCE_BYTES) return { ok: false, issues: [{ path: "$", message: `source exceeds ${MAX_EVAL_SOURCE_BYTES} bytes` }] };
  let value: unknown;
  try {
    if (format === "json") value = JSON.parse(source);
    else {
      // Unknown tags (e.g. `!!js/function`) are rejected outright, not degraded to strings.
      const document = parseDocument(source, { schema: "core", strict: true, uniqueKeys: true, logLevel: "silent" });
      if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("invalid YAML");
      value = document.toJS({ maxAliasCount: 100 });
    }
  } catch {
    return { ok: false, issues: [{ path: "$", message: `invalid ${format.toUpperCase()} source` }] };
  }
  const forbidden = findForbiddenEvalCodeKeys(value);
  if (forbidden.length > 0) return { ok: false, issues: forbidden.slice(0, 16).map((path) => ({ path, message: "code-bearing fields are not allowed in Eval data" })) };
  return { ok: true, value };
}

const zodIssues = (error: z.ZodError): EvalSourceIssue[] => error.issues.slice(0, 32).map((issue) => ({ path: ["$", ...issue.path].join("."), message: issue.message }));

/** Parse a version-controlled `EvalDataset` (schema version 1) from YAML or JSON. */
export function parseEvalDataset(source: string, format: EvalSourceFormat): EvalSourceResult<EvalDataset> {
  const raw = parseSource(source, format);
  if (!raw.ok) return { ok: false, code: "EVAL_DATASET_INVALID", issues: raw.issues };
  const parsed = EvalDatasetSchema.safeParse(raw.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: "EVAL_DATASET_INVALID", issues: zodIssues(parsed.error) };
}

/** A definitions file: `{ definitions: EvalDefinition[] }`, unique by exact id + version. */
export const EvalDefinitionFileSchema = z
  .object({ definitions: z.array(EvalDefinitionSchema).min(1).max(MAX_EVAL_DEFINITIONS) })
  .strict()
  .refine((file) => new Set(file.definitions.map((definition) => `${definition.id}@${definition.version}`)).size === file.definitions.length, "definitions must be unique by id and version");

export function parseEvalDefinitions(source: string, format: EvalSourceFormat): EvalSourceResult<EvalDefinition[]> {
  const raw = parseSource(source, format);
  if (!raw.ok) return { ok: false, code: "EVAL_INVALID_DEFINITION", issues: raw.issues };
  const parsed = EvalDefinitionFileSchema.safeParse(raw.value);
  return parsed.success ? { ok: true, value: parsed.data.definitions } : { ok: false, code: "EVAL_INVALID_DEFINITION", issues: zodIssues(parsed.error) };
}

/**
 * Dataset validation before any evaluation runs: schema (unique case ids,
 * no duplicate cases, bounded size, valid evidence refs), every case's
 * `evalRef` resolves to exactly one supplied definition, and the case mode
 * is one the definition supports.
 */
export function validateEvalDataset(params: { dataset: unknown; definitions: readonly unknown[] }): { ok: true; dataset: EvalDataset; definitions: Map<string, EvalDefinition> } | { ok: false; code: "EVAL_DATASET_INVALID"; issues: EvalSourceIssue[] } {
  const issues: EvalSourceIssue[] = [];
  const forbidden = findForbiddenEvalCodeKeys(params.dataset);
  if (forbidden.length > 0) return { ok: false, code: "EVAL_DATASET_INVALID", issues: forbidden.slice(0, 16).map((path) => ({ path, message: "code-bearing fields are not allowed in Eval data" })) };
  const dataset = EvalDatasetSchema.safeParse(params.dataset);
  if (!dataset.success) return { ok: false, code: "EVAL_DATASET_INVALID", issues: zodIssues(dataset.error) };
  const file = EvalDefinitionFileSchema.safeParse({ definitions: params.definitions });
  if (!file.success) return { ok: false, code: "EVAL_DATASET_INVALID", issues: zodIssues(file.error).map((issue) => ({ ...issue, path: issue.path.replace(/^\$/, "$definitions") })) };
  const definitions = new Map(file.data.definitions.map((definition) => [`${definition.id}@${definition.version}`, definition]));
  dataset.data.cases.forEach((evalCase, index) => {
    const definition = definitions.get(`${evalCase.evalRef.id}@${evalCase.evalRef.version}`);
    if (!definition) issues.push({ path: `$.cases.${index}.evalRef`, message: `unknown Eval definition ${evalCase.evalRef.id}@${evalCase.evalRef.version}` });
    else if (!definition.supportedModes.includes(evalCase.mode)) issues.push({ path: `$.cases.${index}.mode`, message: `${evalCase.mode} is not supported by ${definition.id}@${definition.version}` });
  });
  return issues.length > 0 ? { ok: false, code: "EVAL_DATASET_INVALID", issues } : { ok: true, dataset: dataset.data, definitions };
}

/**
 * Injected host mapping from an opaque evidence reference to evidence. The
 * Evaluation Runtime never touches the filesystem, fetches URIs, or uses
 * the network; a host decides what `fixture://…` or `trace://…` means.
 * Returning `undefined` means "no such evidence".
 */
export interface EvidenceResolver {
  resolve(evidenceRef: string): EvalEvidenceBundle | undefined | Promise<EvalEvidenceBundle | undefined>;
}

/** An in-memory resolver over explicit host-supplied entries (exact reference match). */
export function createStaticEvidenceResolver(entries: Iterable<readonly [string, EvalEvidenceBundle]>): EvidenceResolver {
  const map = new Map<string, EvalEvidenceBundle>();
  for (const [reference, bundle] of entries) {
    if (!EvalEvidenceRefSchema.safeParse(reference).success) throw new Error("invalid evidence reference");
    map.set(reference, bundle);
  }
  return Object.freeze({ resolve: (reference: string) => map.get(reference) });
}

export type RunEvalDatasetResult = { ok: true; run: EvalDatasetRun } | { ok: false; code: "EVAL_DATASET_INVALID"; issues: EvalSourceIssue[] };

/**
 * Run one dataset, sequentially and deterministically, in dataset case
 * order. Each case is isolated: an unresolvable or throwing evidence lookup,
 * a grader defect, or a judge failure becomes that case's `error` result,
 * and every other case still produces its own result. No case is skipped.
 * Returns serializable results only; nothing is stored.
 */
export async function runEvalDataset(params: { dataset: unknown; definitions: readonly unknown[]; registry: EvaluatorRegistry; evidenceResolver: EvidenceResolver }): Promise<RunEvalDatasetResult> {
  const validation = validateEvalDataset({ dataset: params.dataset, definitions: params.definitions });
  if (!validation.ok) return validation;
  const { dataset, definitions } = validation;
  const datasetRef = { id: dataset.id, version: dataset.version };
  const cases: EvalDatasetRun["cases"] = [];

  for (const evalCase of dataset.cases) {
    const definition = definitions.get(`${evalCase.evalRef.id}@${evalCase.evalRef.version}`)!;
    const caseContext = { definition, mode: evalCase.mode, datasetRef, caseId: evalCase.id, source: evalCase.evidenceRef };
    let result: EvalResult;
    let evidence: EvalEvidenceBundle | undefined;
    let resolved = true;
    try {
      evidence = await params.evidenceResolver.resolve(evalCase.evidenceRef);
    } catch {
      resolved = false;
    }
    if (!resolved) result = failedEvaluation({ ...caseContext, code: "EVAL_CASE_ERROR" });
    else if (evidence === undefined) result = failedEvaluation({ ...caseContext, code: "EVAL_EVIDENCE_MISSING" });
    else {
      try {
        result = await evaluate({ definition, mode: evalCase.mode, evidence: { ...evidence, source: evidence.source ?? evalCase.evidenceRef }, registry: params.registry, datasetRef, caseId: evalCase.id });
      } catch {
        result = failedEvaluation({ ...caseContext, code: "EVAL_CASE_ERROR" });
      }
    }
    cases.push({ caseId: evalCase.id, matchesExpectation: matchesExpectation(evalCase, result), result });
  }
  return { ok: true, run: EvalDatasetRunSchema.parse({ schemaVersion: 1, datasetRef, cases }) };
}

function matchesExpectation(evalCase: EvalCase, result: EvalResult): boolean | null {
  if (!evalCase.expected) return null;
  return evalCase.expected.status === result.status && (evalCase.expected.errorCode === undefined || evalCase.expected.errorCode === result.errorCode);
}
