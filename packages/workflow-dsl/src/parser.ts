import { parse as parseYaml } from "yaml";
import { WorkflowSchema } from "@aao/contracts";
import { diagnosticsFromZodError } from "./diagnostics.js";
import type { WorkflowDiagnostic, WorkflowParseResult, WorkflowSourceFormat } from "./types.js";

type RawParseResult = { ok: true; value: unknown } | { ok: false; diagnostics: WorkflowDiagnostic[] };

/**
 * One source document = one workflow. Multi-document YAML is not supported
 * in V1. YAML is parsed with the safe "core" schema (no custom/executable
 * tags) and the library's default alias-expansion cap, so source content is
 * always treated as inert data, never as code.
 */
function parseRaw(source: string, format: WorkflowSourceFormat): RawParseResult {
  if (format === "json") {
    try {
      return { ok: true, value: JSON.parse(source) };
    } catch (error) {
      return { ok: false, diagnostics: [parseErrorDiagnostic("JSON", error)] };
    }
  }

  try {
    const value: unknown = parseYaml(source, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, diagnostics: [parseErrorDiagnostic("YAML", error)] };
  }
}

function parseErrorDiagnostic(format: "JSON" | "YAML", error: unknown): WorkflowDiagnostic {
  const message = error instanceof Error ? error.message : "unknown parse error";
  return { code: "PARSE_ERROR", message: `Invalid ${format} source: ${message}` };
}

/**
 * Source -> raw value -> canonical WorkflowSchema. Malformed source or a
 * value that fails the canonical Workflow schema both return deterministic
 * diagnostics rather than throwing; only unexpected internal errors throw.
 */
export function parseWorkflowSource(source: string, format: WorkflowSourceFormat): WorkflowParseResult {
  const raw = parseRaw(source, format);
  if (!raw.ok) return raw;

  const result = WorkflowSchema.safeParse(raw.value);
  if (!result.success) {
    return { ok: false, diagnostics: diagnosticsFromZodError(result.error, raw.value) };
  }

  return { ok: true, workflow: result.data };
}
