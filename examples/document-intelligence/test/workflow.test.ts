import { vi, describe, expect, it } from "vitest";
import {
  ACME_DOCUMENT_REF,
} from "../fixtures/index.js";
import {
  DOCUMENT_INTELLIGENCE_NODE_ORDER,
  STATE_KEYS,
  documentIntelligenceWorkflow,
  type DocumentIntelligenceResult,
} from "../src/index.js";
import { nodesCompleted, ofType, runProof, toolsStarted, values } from "./support.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const resultOf = (outcome: Awaited<ReturnType<typeof runProof>>["outcome"]): DocumentIntelligenceResult => {
  if (outcome.status !== "completed") {
    throw new Error(`expected completion, got ${JSON.stringify(outcome.failure)}`);
  }
  return outcome.result;
};

describe("Document Intelligence Workflow: happy path", () => {
  it("is a straight 9-node chain: no branch, loop, autonomous agent, approval, or external DSL", () => {
    expect(documentIntelligenceWorkflow.nodes.map((node) => node.id)).toEqual([...DOCUMENT_INTELLIGENCE_NODE_ORDER]);
    expect(documentIntelligenceWorkflow.edges).toEqual(
      DOCUMENT_INTELLIGENCE_NODE_ORDER.slice(1).map((target, index) => ({
        sourceNodeId: DOCUMENT_INTELLIGENCE_NODE_ORDER[index]!,
        targetNodeId: target,
      }))
    );
    expect(new Set(documentIntelligenceWorkflow.nodes.map((node) => node.kind))).toEqual(
      new Set(["deterministic", "model", "tool", "final_output"])
    );
    expect(documentIntelligenceWorkflow.nodes.filter((node) => node.kind === "model").map((node) => node.id)).toEqual([
      "synthesize",
    ]);
    expect(documentIntelligenceWorkflow.nodes.filter((node) => node.kind === "tool").map((node) => node.id)).toEqual([
      "extract_document",
    ]);
  });

  it("completes: every node in order, valid trace, and DocumentIntelligenceResult v1", async () => {
    const run = await runProof();
    expect(run.outcome.status).toBe("completed");
    expect(run.traceValid).toBe(true);
    expect(nodesCompleted(run.trace)).toEqual([...DOCUMENT_INTELLIGENCE_NODE_ORDER]);
    const result = resultOf(run.outcome);
    expect(result.schemaVersion).toBe(1);
    expect(result.document.documentId).toMatch(/^doc\.[a-f0-9]{16}$/);
    expect(result.document.pagesExtracted).toBe(3);
    expect(result.answers.map((a) => [a.questionId, a.status])).toEqual([
      ["payment_terms", "answered"],
      ["governing_law", "answered"],
      ["breach_notification", "answered"],
      ["unanswered_refunds", "insufficient_evidence"],
    ]);
  });

  it("exactly one model call (synthesize) and no Tools offered to it", async () => {
    const run = await runProof();
    expect(ofType(run.trace, "model.call.started")).toHaveLength(1);
    expect(run.model.requests.map((r) => r.output.kind === "structured" && r.output.name)).toEqual([
      "document_intelligence_draft",
    ]);
    for (const req of run.model.requests) {
      expect(req.output.kind).toBe("structured");
      expect(req.messages).toHaveLength(2);
      expect(req.messages[0]?.role).toBe("system");
      expect(req.messages[1]?.role).toBe("user");
    }
  });

  it("Tools run through Tool Runtime: document.extract_text once with read_only permission", async () => {
    const run = await runProof();
    expect(toolsStarted(run.trace)).toEqual(["document.extract_text"]);
    expect(ofType(run.trace, "tool.call.blocked")).toEqual([]);
    for (const event of ofType(run.trace, "tool.call.started")) {
      expect(event.payload.permissionClasses).toEqual(["read_only"]);
    }
  });

  it("provider budget: exactly one read call for the opaque document reference", async () => {
    const run = await runProof();
    expect(run.provider.calls).toHaveLength(1);
    expect(run.provider.calls[0]?.ref).toBe(ACME_DOCUMENT_REF);
  });

  it("evidence spans are deterministically computed with exact UTF-16 offsets", async () => {
    const run = await runProof();
    const state = values(run.outcome);
    const spans = state[STATE_KEYS.evidenceSpans] as Array<{
      evidenceId: string;
      pageNumber: number;
      startOffset: number;
      endOffset: number;
      text: string;
    }>;
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.evidenceId).toMatch(/^ev\.[a-f0-9]{16}$/);
      expect(span.pageNumber).toBeGreaterThanOrEqual(1);
      expect(span.endOffset).toBeGreaterThan(span.startOffset);
      expect(span.text.length).toBe(span.endOffset - span.startOffset);
    }
  });

  it("evidence index assigns stable E1..En citation labels in order of appearance", async () => {
    const run = await runProof();
    const result = resultOf(run.outcome);
    expect(result.evidenceIndex.map((e) => e.citationId)).toEqual(["E1", "E2", "E3"]);
    for (const entry of result.evidenceIndex) {
      expect(entry.citationId).toMatch(/^E\d+$/);
      expect(entry.evidenceId).toMatch(/^ev\.[a-f0-9]{16}$/);
      expect(entry.excerpt.length).toBeGreaterThan(0);
    }
  });

  it("rendered markdown is deterministic across runs and includes evidence index blockquotes", async () => {
    const run1 = await runProof({ runId: "run.w1" });
    const run2 = await runProof({ runId: "run.w2" });
    const r1 = resultOf(run1.outcome);
    const r2 = resultOf(run2.outcome);
    expect(r1.markdown).toBe(r2.markdown);
    expect(r1.markdown).toContain("# Document Intelligence — acme-contract-2026.pdf");
    expect(r1.markdown).toContain("### [E1] Page 1");
    expect(r1.markdown).toContain("### [E2] Page 2");
    expect(r1.markdown).toContain("### [E3] Page 3");
  });

  it("raw PDF bytes never enter Run state or Trace", async () => {
    const run = await runProof();
    const traceJson = JSON.stringify(run.trace);
    expect(traceJson).not.toContain("%PDF-1.4");
    expect(traceJson).not.toContain("Uint8Array");
    const stateJson = JSON.stringify(values(run.outcome));
    expect(stateJson).not.toContain("%PDF-1.4");
    expect(stateJson).not.toContain("Uint8Array");
  });
});
