import type { WorkflowDiagnostic, WorkflowDiagnosticCode } from "./types.js";

/**
 * The minimal structural shape this module needs from a Zod validation
 * error. Declared locally (rather than importing zod's `ZodError` type) so
 * this package's only production dependencies remain `@aao/contracts` and
 * `yaml` — `WorkflowSchema.safeParse(...)`'s real error value already
 * satisfies this shape structurally.
 */
interface SchemaValidationIssue {
  path: (string | number)[];
  message: string;
}
interface SchemaValidationError {
  issues: SchemaValidationIssue[];
}

/** The complete set of stable diagnostic codes this compiler emits. */
export const WORKFLOW_DIAGNOSTIC_CODES: readonly WorkflowDiagnosticCode[] = [
  "PARSE_ERROR",
  "SCHEMA_VALIDATION_ERROR",
  "DUPLICATE_NODE_ID",
  "ENTRY_NODE_NOT_FOUND",
  "EDGE_SOURCE_NOT_FOUND",
  "EDGE_TARGET_NOT_FOUND",
  "DUPLICATE_EDGE",
  "UNREACHABLE_NODE",
  "CYCLE_NOT_SUPPORTED",
  "FINAL_OUTPUT_HAS_OUTGOING_EDGE",
  "NON_FINAL_TERMINAL_NODE",
  "AMBIGUOUS_ROUTING",
  "CONDITIONAL_ROUTE_WITHOUT_DEFAULT",
];

/**
 * Normalizes Zod's raw issues into workflow diagnostics, enriching each with
 * `nodeId`/`edgeIndex` when the issue path makes one derivable (e.g.
 * "nodes.2.kind" -> nodeId of nodes[2]; "edges.0.condition" -> edgeIndex 0).
 * Raw Zod issue objects are never exposed directly through the public API.
 */
export function diagnosticsFromZodError(error: SchemaValidationError, rawSource: unknown): WorkflowDiagnostic[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    const diagnostic: WorkflowDiagnostic = {
      code: "SCHEMA_VALIDATION_ERROR",
      message: issue.message,
    };
    if (path.length > 0) diagnostic.path = path;

    const nodeId = deriveNodeId(rawSource, issue.path);
    if (nodeId !== undefined) diagnostic.nodeId = nodeId;

    const edgeIndex = deriveEdgeIndex(issue.path);
    if (edgeIndex !== undefined) diagnostic.edgeIndex = edgeIndex;

    return diagnostic;
  });
}

function deriveNodeId(rawSource: unknown, path: (string | number)[]): string | undefined {
  if (path[0] !== "nodes" || typeof path[1] !== "number") return undefined;
  if (typeof rawSource !== "object" || rawSource === null) return undefined;
  const nodes = (rawSource as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return undefined;
  const node = nodes[path[1]];
  if (typeof node !== "object" || node === null) return undefined;
  const id = (node as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function deriveEdgeIndex(path: (string | number)[]): number | undefined {
  if (path[0] !== "edges" || typeof path[1] !== "number") return undefined;
  return path[1];
}
