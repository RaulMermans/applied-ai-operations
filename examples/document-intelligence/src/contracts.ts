import { DOCUMENT_INTELLIGENCE_LIMITS as L, QUESTION_ID_PATTERN } from "./limits.js";

export interface DocumentQuestionInput {
  readonly id: string;
  readonly question: string;
}

export interface DocumentIntelligenceRequestInput {
  readonly schemaVersion?: number;
  readonly documentRef: string;
  readonly questions: readonly DocumentQuestionInput[];
}

export interface DocumentIntelligenceRequest {
  readonly schemaVersion: 1;
  readonly documentRef: string;
  readonly questions: readonly DocumentQuestion[];
}

export interface DocumentQuestion {
  readonly id: string;
  readonly question: string;
}

export interface DocumentEvidenceSpan {
  readonly evidenceId: string;
  readonly documentId: string;
  readonly pageNumber: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

export interface AdmittedEvidencePacket {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly documentFingerprint: string;
  readonly spans: readonly DocumentEvidenceSpan[];
  readonly admission: {
    readonly availableSpans: number;
    readonly admittedSpans: number;
    readonly availableCharacters: number;
    readonly admittedCharacters: number;
    readonly partial: boolean;
  };
}

export interface DraftFinding {
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
}

export interface DraftAnswer {
  readonly questionId: string;
  readonly status: "answered" | "insufficient_evidence";
  readonly findings: readonly DraftFinding[];
  readonly limitation?: string;
}

export interface DocumentIntelligenceDraft {
  readonly answers: readonly DraftAnswer[];
  readonly overallLimitations: readonly string[];
}

export interface GroundedFinding {
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
  readonly citationIds: readonly string[];
}

export interface GroundedAnswer {
  readonly questionId: string;
  readonly status: "answered" | "insufficient_evidence";
  readonly findings: readonly GroundedFinding[];
  readonly limitation?: string;
}

export interface GroundedDraft {
  readonly answers: readonly GroundedAnswer[];
  readonly overallLimitations: readonly string[];
  readonly citedEvidenceIds: readonly string[];
}

export interface CitedEvidenceEntry {
  readonly citationId: string; // "E1", "E2", ...
  readonly evidenceId: string;
  readonly pageNumber: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly excerpt: string;
}

export interface DocumentMetadataSummary {
  readonly documentId: string;
  readonly documentFingerprint: string;
  readonly filename?: string;
  readonly mimeType: string;
  readonly pagesTotal: number;
  readonly pagesExtracted: number;
}

export interface DocumentIntelligenceResult {
  readonly schemaVersion: 1;
  readonly document: DocumentMetadataSummary;
  readonly questions: readonly DocumentQuestion[];
  readonly answers: readonly GroundedAnswer[];
  readonly evidenceIndex: readonly CitedEvidenceEntry[];
  readonly coverage: {
    readonly questionsTotal: number;
    readonly questionsAnswered: number;
    readonly questionsInsufficient: number;
    readonly spansAvailable: number;
    readonly spansAdmitted: number;
    readonly spansCited: number;
  };
  readonly extraction: {
    readonly partial: boolean;
    readonly reasons: readonly string[];
  };
  readonly limitations: readonly string[];
  readonly markdown: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Validates and canonicalizes a DocumentIntelligenceRequest deterministically.
 */
export function validateDocumentIntelligenceRequest(input: unknown): ValidationResult<DocumentIntelligenceRequest> {
  if (!isRecord(input)) {
    return { ok: false, code: "INVALID_REQUEST", message: "Request must be an object" };
  }

  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== undefined) {
    return { ok: false, code: "INVALID_SCHEMA_VERSION", message: "schemaVersion must be 1" };
  }

  const documentRefRaw = input.documentRef;
  if (typeof documentRefRaw !== "string" || documentRefRaw.trim().length === 0) {
    return { ok: false, code: "INVALID_DOCUMENT_REF", message: "documentRef must be a non-empty string" };
  }
  const documentRef = documentRefRaw.trim();
  if (documentRef.length > L.maxDocumentRefLength) {
    return { ok: false, code: "DOCUMENT_REF_TOO_LONG", message: `documentRef exceeds ${L.maxDocumentRefLength} characters` };
  }

  const questionsRaw = input.questions;
  if (!Array.isArray(questionsRaw)) {
    return { ok: false, code: "INVALID_QUESTIONS", message: "questions must be an array" };
  }
  if (questionsRaw.length < L.minQuestions || questionsRaw.length > L.maxQuestions) {
    return {
      ok: false,
      code: "INVALID_QUESTION_COUNT",
      message: `questions array must contain between ${L.minQuestions} and ${L.maxQuestions} items, received ${questionsRaw.length}`,
    };
  }

  const questionIds = new Set<string>();
  const questions: DocumentQuestion[] = [];

  for (const q of questionsRaw) {
    if (!isRecord(q)) {
      return { ok: false, code: "INVALID_QUESTION", message: "Each question must be an object" };
    }
    const idRaw = q.id;
    if (typeof idRaw !== "string" || !QUESTION_ID_PATTERN.test(idRaw)) {
      return { ok: false, code: "INVALID_QUESTION_ID", message: `Question id '${String(idRaw)}' does not match slug pattern` };
    }
    if (questionIds.has(idRaw)) {
      return { ok: false, code: "DUPLICATE_QUESTION_ID", message: `Duplicate question id '${idRaw}'` };
    }
    questionIds.add(idRaw);

    const questionTextRaw = q.question;
    if (typeof questionTextRaw !== "string" || questionTextRaw.trim().length === 0) {
      return { ok: false, code: "INVALID_QUESTION_TEXT", message: `Question text for '${idRaw}' must be non-empty` };
    }
    const normalizedText = questionTextRaw.replace(/\s+/g, " ").trim();
    if (normalizedText.length > L.maxQuestionLength) {
      return {
        ok: false,
        code: "QUESTION_TOO_LONG",
        message: `Question '${idRaw}' exceeds max length of ${L.maxQuestionLength} characters`,
      };
    }

    questions.push({ id: idRaw, question: normalizedText });
  }

  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      documentRef,
      questions: Object.freeze(questions),
    }),
  };
}
