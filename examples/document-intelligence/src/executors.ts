import type {
  DeterministicExecutor,
  DeterministicExecutorContext,
  DeterministicExecutorResult,
  JsonObject,
  JsonValue,
} from "@aao/framework";
import {
  DOCUMENT_FINGERPRINT_PATTERN,
  DOCUMENT_ID_PATTERN,
  computeDocumentId,
  type ExtractDocumentOutput,
  type ExtractedDocumentPage,
} from "@aao/integration-documents";
import {
  isRecord,
  validateDocumentIntelligenceRequest,
  type AdmittedEvidencePacket,
  type DocumentEvidenceSpan,
  type DocumentIntelligenceRequest,
  type DocumentMetadataSummary,
  type GroundedDraft,
} from "./contracts.js";
import { validateDocumentIntelligenceDraft } from "./grounding.js";
import { DOCUMENT_INTELLIGENCE_LIMITS as L } from "./limits.js";
import { buildSynthesisRequest } from "./model-requests.js";
import { buildDocumentIntelligenceResult } from "./render.js";
import { segmentDocumentPages, validateEvidenceSpans } from "./segmentation.js";

export const EXECUTOR_VERSION = "1.0.0";

/** Canonical state keys in workflow order. */
export const STATE_KEYS = Object.freeze({
  request: "request",
  docRequest: "docRequest",
  extractInput: "extractInput",
  extractResult: "extractResult",
  validatedDocument: "validatedDocument",
  evidenceSpans: "evidenceSpans",
  admittedEvidence: "admittedEvidence",
  synthesisModelRequest: "synthesisModelRequest",
  synthesisResult: "synthesisResult",
  groundedDraft: "groundedDraft",
  docResult: "docResult",
});

const ok = (statePatch: Record<string, unknown>): DeterministicExecutorResult => ({
  ok: true,
  statePatch: statePatch as JsonObject,
});

const fail = (code: string): DeterministicExecutorResult => ({
  ok: false,
  code,
});

type Values = DeterministicExecutorContext["state"]["values"];

const outputOf = (values: Values, key: string): Record<string, unknown> | undefined => {
  const stored = values[key];
  return isRecord(stored) && isRecord(stored.output) ? stored.output : undefined;
};

function executor(
  id: string,
  execute: (values: Values, runId: string) => DeterministicExecutorResult | Promise<DeterministicExecutorResult>
): DeterministicExecutor {
  return Object.freeze({
    id,
    version: EXECUTOR_VERSION,
    execute: async (context: DeterministicExecutorContext) => execute(context.state.values, context.runId),
  });
}

/**
 * Node 1: intake
 * Deterministically validates the user's request and prepares input for the document extraction Tool.
 */
export const intake = executor("document_intelligence.intake", (values) => {
  const checked = validateDocumentIntelligenceRequest(values[STATE_KEYS.request]);
  if (!checked.ok) {
    return fail(checked.code);
  }

  return ok({
    [STATE_KEYS.docRequest]: checked.value as unknown as JsonValue,
    [STATE_KEYS.extractInput]: { documentRef: checked.value.documentRef },
  });
});

/**
 * Node 3: validate_document
 * Deterministically validates extracted document pages, ordering, character counts, and identity.
 */
export const validateDocument = executor("document_intelligence.validate_document", (values) => {
  const toolOutput = outputOf(values, STATE_KEYS.extractResult) as unknown as ExtractDocumentOutput | undefined;
  if (!toolOutput || !isRecord(toolOutput.data) || !isRecord(toolOutput.meta) || !Array.isArray(toolOutput.data.pages)) {
    return fail("DOCUMENT_EXTRACTION_OUTPUT_INVALID");
  }

  const { documentId, documentFingerprint, filename, mimeType, pages } = toolOutput.data;

  if (!DOCUMENT_FINGERPRINT_PATTERN.test(documentFingerprint)) {
    return fail("INVALID_DOCUMENT_FINGERPRINT");
  }

  const expectedDocId = computeDocumentId(documentFingerprint);
  if (documentId !== expectedDocId || !DOCUMENT_ID_PATTERN.test(documentId)) {
    return fail("DOCUMENT_ID_INCONSISTENT");
  }

  if (pages.length === 0) {
    return fail("DOCUMENT_NO_PAGES");
  }

  // Verify page numbering: 1..N, contiguous, ordered
  let totalChars = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    if (page.pageNumber !== i + 1) {
      return fail("NON_CONTIGUOUS_PAGE_NUMBERING");
    }
    if (page.charCount !== page.text.length) {
      return fail("PAGE_CHAR_COUNT_MISMATCH");
    }
    totalChars += page.charCount;
  }

  if (totalChars === 0) {
    return fail("DOCUMENT_EMPTY_TEXT");
  }

  if (toolOutput.meta.charactersExtracted !== totalChars) {
    return fail("META_CHARACTERS_COUNT_MISMATCH");
  }

  const metadata: DocumentMetadataSummary = {
    documentId,
    documentFingerprint,
    ...(filename ? { filename } : {}),
    mimeType,
    pagesTotal: toolOutput.meta.pagesTotal,
    pagesExtracted: toolOutput.meta.pagesExtracted,
  };

  return ok({
    [STATE_KEYS.validatedDocument]: {
      summary: metadata,
      pages,
      isPartial: toolOutput.status === "partial",
      partialReasons: toolOutput.meta.partialReasons,
    } as unknown as JsonValue,
  });
});

/**
 * Node 4: segment_document
 * Deterministically segments canonical pages into bounded evidence spans with exact offsets.
 */
export const segmentDocument = executor("document_intelligence.segment_document", (values) => {
  const validated = values[STATE_KEYS.validatedDocument] as {
    summary: DocumentMetadataSummary;
    pages: ExtractedDocumentPage[];
  } | undefined;

  if (!validated || !validated.summary || !Array.isArray(validated.pages)) {
    return fail("VALIDATED_DOCUMENT_STATE_MISSING");
  }

  const spans = segmentDocumentPages(
    validated.summary.documentId,
    validated.summary.documentFingerprint,
    validated.pages
  );

  const spanCheck = validateEvidenceSpans(
    validated.summary.documentId,
    validated.summary.documentFingerprint,
    validated.pages,
    spans
  );
  if (!spanCheck.ok) {
    return fail(spanCheck.code);
  }

  return ok({
    [STATE_KEYS.evidenceSpans]: spans as unknown as JsonValue,
  });
});

/**
 * Node 5: admit_evidence
 * Applies deterministic context admission budget over evidence spans and constructs the synthesis ModelRequest.
 */
export const admitEvidence = executor("document_intelligence.admit_evidence", (values, runId) => {
  const request = values[STATE_KEYS.docRequest] as unknown as DocumentIntelligenceRequest | undefined;
  const validated = values[STATE_KEYS.validatedDocument] as {
    summary: DocumentMetadataSummary;
  } | undefined;
  const spans = values[STATE_KEYS.evidenceSpans] as unknown as DocumentEvidenceSpan[] | undefined;

  if (!request || !validated || !Array.isArray(spans)) {
    return fail("ADMISSION_STATE_MISSING");
  }

  const availableSpans = spans.length;
  const availableCharacters = spans.reduce((sum, s) => sum + s.text.length, 0);

  const admittedSpans: DocumentEvidenceSpan[] = [];
  let remainingBudget = L.maxTotalEvidenceChars;

  for (const span of spans) {
    if (admittedSpans.length >= L.maxAdmittedSpans || remainingBudget < span.text.length) {
      break;
    }
    admittedSpans.push(span);
    remainingBudget -= span.text.length;
  }

  const admittedCharacters = admittedSpans.reduce((sum, s) => sum + s.text.length, 0);
  const isCapped = admittedSpans.length < availableSpans;

  const packet: AdmittedEvidencePacket = {
    schemaVersion: 1,
    documentId: validated.summary.documentId,
    documentFingerprint: validated.summary.documentFingerprint,
    spans: Object.freeze(admittedSpans),
    admission: {
      availableSpans,
      admittedSpans: admittedSpans.length,
      availableCharacters,
      admittedCharacters,
      partial: isCapped,
    },
  };

  const modelRequest = buildSynthesisRequest(runId, request, validated.summary, packet);

  return ok({
    [STATE_KEYS.admittedEvidence]: packet as unknown as JsonValue,
    [STATE_KEYS.synthesisModelRequest]: modelRequest,
  });
});

/**
 * Node 7: validate_grounding
 * Deterministically checks that every citation in the draft resolves to exact admitted evidence spans.
 */
export const validateGrounding = executor("document_intelligence.validate_grounding", (values) => {
  const request = values[STATE_KEYS.docRequest] as unknown as DocumentIntelligenceRequest | undefined;
  const admittedEvidence = values[STATE_KEYS.admittedEvidence] as unknown as AdmittedEvidencePacket | undefined;
  const draft = outputOf(values, STATE_KEYS.synthesisResult);

  if (!request || !admittedEvidence || !draft) {
    return fail("GROUNDING_STATE_MISSING");
  }

  const validation = validateDocumentIntelligenceDraft({
    request,
    admittedEvidence,
    draft,
  });

  if (!validation.ok) {
    return fail(validation.code);
  }

  return ok({
    [STATE_KEYS.groundedDraft]: validation.groundedDraft as unknown as JsonValue,
  });
});

/**
 * Node 8: render
 * Assembles cited evidence index, builds Markdown representation, and constructs DocumentIntelligenceResult v1.
 */
export const render = executor("document_intelligence.render", (values) => {
  const request = values[STATE_KEYS.docRequest] as unknown as DocumentIntelligenceRequest | undefined;
  const validated = values[STATE_KEYS.validatedDocument] as {
    summary: DocumentMetadataSummary;
    isPartial: boolean;
    partialReasons: string[];
  } | undefined;
  const admittedEvidence = values[STATE_KEYS.admittedEvidence] as unknown as AdmittedEvidencePacket | undefined;
  const spans = values[STATE_KEYS.evidenceSpans] as unknown as DocumentEvidenceSpan[] | undefined;
  const groundedDraft = values[STATE_KEYS.groundedDraft] as unknown as GroundedDraft | undefined;

  if (!request || !validated || !admittedEvidence || !spans || !groundedDraft) {
    return fail("RENDER_STATE_MISSING");
  }

  const result = buildDocumentIntelligenceResult({
    request,
    document: validated.summary,
    groundedDraft,
    admittedEvidence,
    totalSpansAvailable: spans.length,
    extractionPartial: validated.isPartial,
    extractionReasons: validated.partialReasons,
  });

  return ok({
    [STATE_KEYS.docResult]: result as unknown as JsonValue,
  });
});

/** All deterministic executors of the Document Intelligence workflow. */
export const DOCUMENT_INTELLIGENCE_EXECUTORS: readonly DeterministicExecutor[] = Object.freeze([
  intake,
  validateDocument,
  segmentDocument,
  admitEvidence,
  validateGrounding,
  render,
]);
