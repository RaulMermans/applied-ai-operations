import { createHash } from "node:crypto";
import { identifierSchema } from "@aao/contracts";

/** Domain-separation tag, so an Agent execution digest can never equal another subsystem's digest of the same Run + Node. */
const AGENT_EXECUTION_ID_DOMAIN = "aao.agent-execution.v1";

/**
 * Derives the workflow-owned `agentExecutionId` for one Agent node execution
 * from Run + Node identity: `agent.<sha256 hex>` (70 characters), whatever
 * the lengths of `runId` and `nodeId` (each up to the canonical 256). The
 * hash input is the JSON array `[domain, runId, nodeId]`, which is
 * unambiguous: no two distinct (runId, nodeId) pairs serialize to the same
 * text, unlike plain concatenation (`a.b` + `c` vs `a` + `b.c`).
 *
 * Deterministic and pure — no randomness, clock, or counter — so the same
 * Run + Node always yields the same id. Runtime V1 executes an Agent node at
 * most once per Run; future retry/resume semantics will add an explicit
 * attempt dimension to this derivation rather than an ad hoc suffix.
 *
 * Direct `executeAgent` callers still supply their own `agentExecutionId`;
 * this applies only where the `agent` node creates one.
 */
export function deriveAgentExecutionId(runId: string, nodeId: string): string {
  // Both already passed Runtime input validation; anything else is a caller bug, not a runtime failure.
  if (!identifierSchema.safeParse(runId).success || !identifierSchema.safeParse(nodeId).success) {
    throw new Error("deriveAgentExecutionId requires canonical runId and nodeId identifiers.");
  }
  const digest = createHash("sha256").update(JSON.stringify([AGENT_EXECUTION_ID_DOMAIN, runId, nodeId]), "utf8").digest("hex");
  return `agent.${digest}`;
}
