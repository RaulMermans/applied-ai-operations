import { describe, expect, it } from "vitest";
import {
  ACME_DOCUMENT_REF,
  SAMPLE_QUESTIONS,
} from "../fixtures/index.js";
import {
  GROUNDING_ISSUE_CODES,
  validateDocumentIntelligenceDraft,
  validateDocumentIntelligenceRequest,
  type AdmittedEvidencePacket,
  type DocumentIntelligenceRequest,
} from "../src/index.js";

const validatedReq = validateDocumentIntelligenceRequest({
  documentRef: ACME_DOCUMENT_REF,
  questions: SAMPLE_QUESTIONS,
}) as { ok: true; value: DocumentIntelligenceRequest };

const request = validatedReq.value;

const mockSpans = [
  {
    evidenceId: "ev.1111111111111111",
    documentId: "doc.1111111111111111",
    pageNumber: 1,
    startOffset: 0,
    endOffset: 100,
    text: "Sample payment text fee $120,000",
  },
  {
    evidenceId: "ev.2222222222222222",
    documentId: "doc.1111111111111111",
    pageNumber: 2,
    startOffset: 0,
    endOffset: 100,
    text: "Sample Delaware governing law",
  },
  {
    evidenceId: "ev.3333333333333333",
    documentId: "doc.1111111111111111",
    pageNumber: 3,
    startOffset: 0,
    endOffset: 100,
    text: "Sample 72 hours breach notification",
  },
];

const admittedEvidence: AdmittedEvidencePacket = {
  schemaVersion: 1,
  documentId: "doc.1111111111111111",
  documentFingerprint: "1111111111111111222222222222222233333333333333334444444444444444",
  spans: Object.freeze(mockSpans),
  admission: {
    availableSpans: 3,
    admittedSpans: 3,
    availableCharacters: 300,
    admittedCharacters: 300,
    partial: false,
  },
};

interface MutableFinding {
  statement?: string;
  evidenceRefs?: string[];
  [key: string]: unknown;
}

interface MutableAnswer {
  questionId: string;
  status: string;
  findings: MutableFinding[];
  limitation?: string;
  [key: string]: unknown;
}

interface MutableDraft {
  answers: MutableAnswer[];
  overallLimitations: string[];
  [key: string]: unknown;
}

const validDraft = {
  answers: [
    {
      questionId: "payment_terms",
      status: "answered",
      findings: [{ statement: "Annual fee is $120,000.", evidenceRefs: ["ev.1111111111111111"] }],
    },
    {
      questionId: "governing_law",
      status: "answered",
      findings: [{ statement: "Delaware law governs.", evidenceRefs: ["ev.2222222222222222"] }],
    },
    {
      questionId: "breach_notification",
      status: "answered",
      findings: [{ statement: "Notice within 72 hours.", evidenceRefs: ["ev.3333333333333333"] }],
    },
    {
      questionId: "unanswered_refunds",
      status: "insufficient_evidence",
      findings: [],
      limitation: "Document contains no mention of refund terms.",
    },
  ],
  overallLimitations: ["Based strictly on admitted spans."],
};

const clone = (): MutableDraft => JSON.parse(JSON.stringify(validDraft)) as MutableDraft;

const codes = (draft: unknown) => {
  const result = validateDocumentIntelligenceDraft({ request, admittedEvidence, draft });
  return result.ok ? [] : result.issues.map((i) => i.code);
};

describe("deterministic grounding validation (citation integrity)", () => {
  it("valid refs pass and output answers are ordered by request questions", () => {
    const draft = clone();
    draft.answers = [...draft.answers].reverse();
    const result = validateDocumentIntelligenceDraft({ request, admittedEvidence, draft });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.groundedDraft.answers.map((a) => a.questionId)).toEqual([
        "payment_terms",
        "governing_law",
        "breach_notification",
        "unanswered_refunds",
      ]);
    }
  });

  it.each<[string, (draft: MutableDraft) => void, string]>([
    [
      "unknown evidence ref",
      (d) => {
        d.answers[0]!.findings[0]!.evidenceRefs = ["ev.9999999999999999"];
      },
      "GROUNDING_UNKNOWN_EVIDENCE_REF",
    ],
    [
      "malformed evidence ref pattern",
      (d) => {
        d.answers[0]!.findings[0]!.evidenceRefs = ["invalid-ref-format"];
      },
      "GROUNDING_MALFORMED_DRAFT",
    ],
    [
      "citation label used as ref",
      (d) => {
        d.answers[0]!.findings[0]!.evidenceRefs = ["E1"];
      },
      "GROUNDING_MALFORMED_DRAFT",
    ],
    [
      "empty evidence refs on answered finding",
      (d) => {
        d.answers[0]!.findings[0]!.evidenceRefs = [];
      },
      "GROUNDING_BOUNDS_EXCEEDED",
    ],
    [
      "duplicate evidence ref in one finding",
      (d) => {
        d.answers[0]!.findings[0]!.evidenceRefs = ["ev.1111111111111111", "ev.1111111111111111"];
      },
      "GROUNDING_DUPLICATE_EVIDENCE_REF",
    ],
    [
      "an invented question",
      (d) => {
        d.answers.push({
          questionId: "ceo",
          status: "answered",
          findings: [{ statement: "CEO is Jane", evidenceRefs: ["ev.1111111111111111"] }],
        });
      },
      "GROUNDING_UNKNOWN_QUESTION",
    ],
    [
      "a missing question",
      (d) => {
        d.answers.splice(1, 1);
      },
      "GROUNDING_MISSING_ANSWER",
    ],
    [
      "a duplicate answer",
      (d) => {
        d.answers.push(JSON.parse(JSON.stringify(d.answers[0])));
      },
      "GROUNDING_DUPLICATE_ANSWER",
    ],
    [
      "answered without findings",
      (d) => {
        d.answers[0]!.findings = [];
      },
      "GROUNDING_ANSWERED_WITHOUT_FINDINGS",
    ],
    [
      "insufficient with findings",
      (d) => {
        Object.assign(d.answers[3]!, {
          findings: [{ statement: "x", evidenceRefs: ["ev.1111111111111111"] }],
        });
      },
      "GROUNDING_INSUFFICIENT_WITH_FINDINGS",
    ],
    [
      "insufficient without limitation",
      (d) => {
        delete d.answers[3]!.limitation;
      },
      "GROUNDING_MISSING_LIMITATION",
    ],
    [
      "URL in finding statement",
      (d) => {
        d.answers[0]!.findings[0]!.statement = "See details at https://acme.example/terms";
      },
      "GROUNDING_URL_IN_TEXT",
    ],
    [
      "javascript: URL in limitation",
      (d) => {
        d.overallLimitations = ["javascript:alert(1)"];
      },
      "GROUNDING_URL_IN_TEXT",
    ],
    [
      "authoring extra pageNumber field on finding",
      (d) => {
        Object.assign(d.answers[0]!.findings[0]!, { pageNumber: 1 });
      },
      "GROUNDING_MALFORMED_DRAFT",
    ],
    [
      "authoring extra offsets field on finding",
      (d) => {
        Object.assign(d.answers[0]!.findings[0]!, { startOffset: 0, endOffset: 50 });
      },
      "GROUNDING_MALFORMED_DRAFT",
    ],
    [
      "oversized finding statement",
      (d) => {
        d.answers[0]!.findings[0]!.statement = "x".repeat(501);
      },
      "GROUNDING_BOUNDS_EXCEEDED",
    ],
    [
      "too many findings per answer",
      (d) => {
        d.answers[0]!.findings = Array.from({ length: 6 }, () => ({
          statement: "x",
          evidenceRefs: ["ev.1111111111111111"],
        }));
      },
      "GROUNDING_BOUNDS_EXCEEDED",
    ],
    [
      "too many evidence refs per finding",
      (d) => {
        d.answers[0]!.findings[0]!.evidenceRefs = [
          "ev.1111111111111111",
          "ev.2222222222222222",
          "ev.3333333333333333",
          "ev.4444444444444444",
          "ev.5555555555555555",
          "ev.6666666666666666",
        ];
      },
      "GROUNDING_BOUNDS_EXCEEDED",
    ],
    [
      "too many overall limitations",
      (d) => {
        d.overallLimitations = Array.from({ length: 6 }, (_, i) => `Limit ${i}`);
      },
      "GROUNDING_BOUNDS_EXCEEDED",
    ],
  ])("%s -> %s", (_label, mutate, expectedCode) => {
    const draft = clone();
    mutate(draft);
    expect(codes(draft)).toContain(expectedCode);
  });

  it("all GROUNDING_ISSUE_CODES are defined constants", () => {
    expect(GROUNDING_ISSUE_CODES.length).toBeGreaterThan(5);
    expect(new Set(GROUNDING_ISSUE_CODES).size).toBe(GROUNDING_ISSUE_CODES.length);
  });
});
