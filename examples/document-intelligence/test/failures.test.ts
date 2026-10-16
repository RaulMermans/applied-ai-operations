import { vi, describe, expect, it } from "vitest";
import {
  ACME_DOCUMENT_REF,
  SAMPLE_QUESTIONS,
  buildSimplePdf,
} from "../fixtures/index.js";
import { STATE_KEYS } from "../src/index.js";
import { nodesCompleted, runProof, toolsStarted, values } from "./support.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

type Run = Awaited<ReturnType<typeof runProof>>;
const failureOf = (run: Run) => (run.outcome.status === "failed" ? run.outcome.failure : undefined);

const noResult = (run: Run) => {
  const state = values(run.outcome);
  expect(state[STATE_KEYS.docResult]).toBeUndefined();
  expect(nodesCompleted(run.trace)).not.toContain("render");
};

describe("Document Intelligence: intake failures stop before any tool or model call", () => {
  it("an invalid request fails at intake: no tool, no provider, no model call", async () => {
    const run = await runProof({
      request: { documentRef: "", questions: [] } as never,
    });
    expect(failureOf(run)).toEqual({
      code: "NODE_EXECUTION_FAILED",
      nodeId: "intake",
      executorFailure: { namespace: "deterministic", code: "INVALID_DOCUMENT_REF" },
    });
    expect(run.model.requests).toHaveLength(0);
    expect(run.provider.calls).toHaveLength(0);
    expect(toolsStarted(run.trace)).toHaveLength(0);
  });

  it.each([
    ["empty documentRef", { documentRef: "   ", questions: SAMPLE_QUESTIONS }, "INVALID_DOCUMENT_REF"],
    ["oversized documentRef", { documentRef: "doc://" + "a".repeat(300), questions: SAMPLE_QUESTIONS }, "DOCUMENT_REF_TOO_LONG"],
    ["zero questions", { documentRef: ACME_DOCUMENT_REF, questions: [] }, "INVALID_QUESTION_COUNT"],
    ["too many questions", { documentRef: ACME_DOCUMENT_REF, questions: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, question: "Q?" })) }, "INVALID_QUESTION_COUNT"],
    ["duplicate question IDs", { documentRef: ACME_DOCUMENT_REF, questions: [{ id: "dup", question: "Q1?" }, { id: "dup", question: "Q2?" }] }, "DUPLICATE_QUESTION_ID"],
    ["invalid question slug", { documentRef: ACME_DOCUMENT_REF, questions: [{ id: "Invalid Slug!", question: "Q?" }] }, "INVALID_QUESTION_ID"],
    ["empty question text", { documentRef: ACME_DOCUMENT_REF, questions: [{ id: "q1", question: "   " }] }, "INVALID_QUESTION_TEXT"],
    ["oversized question text", { documentRef: ACME_DOCUMENT_REF, questions: [{ id: "q1", question: "x".repeat(301) }] }, "QUESTION_TOO_LONG"],
  ])("rejects %s at intake node", async (_label, request, expectedCode) => {
    const run = await runProof({ request: request as never });
    expect(failureOf(run)?.nodeId).toBe("intake");
    expect(failureOf(run)?.executorFailure).toEqual({
      namespace: "deterministic",
      code: expectedCode,
    });
    expect(run.provider.calls).toHaveLength(0);
    expect(run.model.requests).toHaveLength(0);
    noResult(run);
  });
});

describe("Document Intelligence: document extraction and provider failures", () => {
  it("document not found fails extract_document node without model call", async () => {
    const run = await runProof({
      providerOptions: { failRefs: [ACME_DOCUMENT_REF] },
    });
    expect(failureOf(run)?.nodeId).toBe("extract_document");
    expect(failureOf(run)?.executorFailure?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(run.model.requests).toHaveLength(0);
    noResult(run);
  });

  it("provider outage error is redacted and never leaks secret credentials into trace", async () => {
    const run = await runProof({
      providerOptions: { providerOutage: true },
    });
    expect(failureOf(run)?.nodeId).toBe("extract_document");
    const traceJson = JSON.stringify(run.trace);
    expect(traceJson).not.toContain("SECRET_DO_NOT_PERSIST");
    expect(run.model.requests).toHaveLength(0);
    noResult(run);
  });

  it("oversized document (>10 MiB) fails bounded ingestion", async () => {
    const run = await runProof({
      providerOptions: { oversizedRefs: [ACME_DOCUMENT_REF] },
    });
    expect(failureOf(run)?.nodeId).toBe("extract_document");
    expect(run.model.requests).toHaveLength(0);
    noResult(run);
  });

  it("corrupted PDF bytes fail parse safely without crashing worker", async () => {
    const run = await runProof({
      providerOptions: { corruptedPdfRefs: [ACME_DOCUMENT_REF] },
    });
    expect(failureOf(run)?.nodeId).toBe("extract_document");
    expect(run.model.requests).toHaveLength(0);
    noResult(run);
  });

  it("PDF with zero extractable text fails validation", async () => {
    // Generate a valid PDF with an empty page
    const emptyPdf = buildSimplePdf([""]);
    const emptyRef = "doc://legal/empty.pdf";
    const run = await runProof({
      providerOptions: {
        customDocuments: {
          [emptyRef]: {
            filename: "empty.pdf",
            mimeType: "application/pdf",
            bytes: emptyPdf,
          },
        },
      },
      request: { documentRef: emptyRef, questions: SAMPLE_QUESTIONS },
    });
    expect(run.outcome.status).toBe("failed");
    noResult(run);
  });

  it("document source unavailable is retryable under reliability policy", async () => {
    const run = await runProof({
      providerOptions: { unavailableRefs: [ACME_DOCUMENT_REF] },
      reliability: {
        extract_document: { maxAttempts: 2 },
      },
    });
    expect(failureOf(run)?.nodeId).toBe("extract_document");
    // Verified 2 attempts made
    expect(run.provider.calls.length).toBe(2);
  });
});

describe("Document Intelligence: model synthesis and grounding validation failures", () => {
  it("model provider outage stops workflow safely", async () => {
    const run = await runProof({
      modelOptions: { throwError: true },
    });
    expect(failureOf(run)?.nodeId).toBe("synthesize");
    noResult(run);
  });

  it("model emitting unknown evidence ID fails validate_grounding node", async () => {
    const run = await runProof({
      modelOptions: { unknownEvidenceRef: true },
    });
    expect(failureOf(run)?.nodeId).toBe("validate_grounding");
    expect(failureOf(run)?.executorFailure?.code).toBe("GROUNDING_UNKNOWN_EVIDENCE_REF");
    noResult(run);
  });

  it("model emitting duplicate evidence ID fails validate_grounding node", async () => {
    const run = await runProof({
      modelOptions: { duplicateEvidenceRef: true },
    });
    expect(failureOf(run)?.nodeId).toBe("validate_grounding");
    expect(failureOf(run)?.executorFailure?.code).toBe("GROUNDING_DUPLICATE_EVIDENCE_REF");
    noResult(run);
  });

  it("model omitting a question answer fails validate_grounding node", async () => {
    const run = await runProof({
      modelOptions: { omitQuestionId: "payment_terms" },
    });
    expect(failureOf(run)?.nodeId).toBe("validate_grounding");
    expect(failureOf(run)?.executorFailure?.code).toBe("GROUNDING_MISSING_ANSWER");
    noResult(run);
  });

  it("model attempting to author URLs in statement fails validate_grounding node", async () => {
    const run = await runProof({
      modelOptions: { includeUrlInStatement: true },
    });
    expect(failureOf(run)?.nodeId).toBe("validate_grounding");
    expect(failureOf(run)?.executorFailure?.code).toBe("GROUNDING_URL_IN_TEXT");
    noResult(run);
  });
});
