import { createHash } from "node:crypto";
import { identifierSchema } from "@aao/contracts";

/** Domain-separation tag, so a Tool execution digest can never equal another subsystem's digest of the same Run + Node. */
const TOOL_EXECUTION_ID_DOMAIN = "aao.tool-execution.v1";

/**
 * Derives the workflow-owned `toolExecutionId` for one Tool node execution
 * from Run + Node identity: `tool.<sha256 hex>` (69 characters), whatever
 * the lengths of `runId` and `nodeId` (each up to the canonical 256). The
 * hash input is the JSON array `[domain, runId, nodeId]`, which is
 * unambiguous: no two distinct (runId, nodeId) pairs serialize to the same
 * text, unlike plain concatenation.
 *
 * Deterministic and pure — no randomness, clock, or counter. The id names
 * the logical Tool Node execution: Runtime retry attempts (ADR-018) reuse
 * it, and the attempt number lives in Runtime attempt accounting, never in
 * an ad hoc suffix. Direct `executeTool` callers supply their own id.
 */
export function deriveToolExecutionId(runId: string, nodeId: string): string {
  // Both already passed Runtime input validation; anything else is a caller bug, not a runtime failure.
  if (!identifierSchema.safeParse(runId).success || !identifierSchema.safeParse(nodeId).success) {
    throw new Error("deriveToolExecutionId requires canonical runId and nodeId identifiers.");
  }
  const digest = createHash("sha256").update(JSON.stringify([TOOL_EXECUTION_ID_DOMAIN, runId, nodeId]), "utf8").digest("hex");
  return `tool.${digest}`;
}
