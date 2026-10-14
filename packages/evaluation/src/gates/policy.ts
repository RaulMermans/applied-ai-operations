import { parseDocument } from "yaml";
import type { z } from "zod";
import { EvalBaselineSchema, EvalGatePolicySchema, findForbiddenEvalCodeKeys, type EvalBaseline, type EvalGatePolicy } from "@aao/contracts";
import { MAX_EVAL_SOURCE_BYTES, type EvalSourceFormat, type EvalSourceIssue } from "../dataset.js";

export type GateSourceResult<T, C extends string> = { ok: true; value: T } | { ok: false; code: C; issues: EvalSourceIssue[] };

/** Inert data only, exactly as for Eval definitions and datasets: JSON or safe-core YAML, unique keys, bounded, no code-bearing keys. */
function parseInert(source: string, format: EvalSourceFormat): { ok: true; value: unknown } | { ok: false; issues: EvalSourceIssue[] } {
  if (new TextEncoder().encode(source).length > MAX_EVAL_SOURCE_BYTES) return { ok: false, issues: [{ path: "$", message: `source exceeds ${MAX_EVAL_SOURCE_BYTES} bytes` }] };
  let value: unknown;
  try {
    if (format === "json") value = JSON.parse(source);
    else {
      const document = parseDocument(source, { schema: "core", strict: true, uniqueKeys: true, logLevel: "silent" });
      if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("invalid YAML");
      value = document.toJS({ maxAliasCount: 100 });
    }
  } catch {
    return { ok: false, issues: [{ path: "$", message: `invalid ${format.toUpperCase()} source` }] };
  }
  const forbidden = findForbiddenEvalCodeKeys(value);
  if (forbidden.length > 0) return { ok: false, issues: forbidden.slice(0, 16).map((path) => ({ path, message: "code-bearing fields are not allowed in gate data" })) };
  return { ok: true, value };
}

const issuesOf = (error: z.ZodError): EvalSourceIssue[] => error.issues.slice(0, 32).map((issue) => ({ path: ["$", ...issue.path].join("."), message: issue.message }));

/** Parse a versioned `EvalGatePolicy` (schema version 1). Strict: unknown keys, code, oversize, or a weakened critical category set are rejected. */
export function parseEvalGatePolicy(source: string, format: EvalSourceFormat): GateSourceResult<EvalGatePolicy, "EVAL_GATE_POLICY_INVALID"> {
  const raw = parseInert(source, format);
  if (!raw.ok) return { ok: false, code: "EVAL_GATE_POLICY_INVALID", issues: raw.issues };
  const parsed = EvalGatePolicySchema.safeParse(raw.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: "EVAL_GATE_POLICY_INVALID", issues: issuesOf(parsed.error) };
}

/** Parse an approved `EvalBaseline` (schema version 1, JSON). */
export function parseEvalBaseline(source: string): GateSourceResult<EvalBaseline, "EVAL_BASELINE_INVALID"> {
  const raw = parseInert(source, "json");
  if (!raw.ok) return { ok: false, code: "EVAL_BASELINE_INVALID", issues: raw.issues };
  const parsed = EvalBaselineSchema.safeParse(raw.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: "EVAL_BASELINE_INVALID", issues: issuesOf(parsed.error) };
}
