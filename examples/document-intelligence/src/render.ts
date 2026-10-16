import type {
  AdmittedEvidencePacket,
  CitedEvidenceEntry,
  DocumentIntelligenceRequest,
  DocumentIntelligenceResult,
  DocumentMetadataSummary,
  GroundedAnswer,
  GroundedDraft,
  GroundedFinding,
} from "./contracts.js";
import { DOCUMENT_INTELLIGENCE_LIMITS as L } from "./limits.js";

/**
 * Escapes plain text to be rendered safely inside Markdown and HTML contexts.
 * Neutralizes HTML tags/entities and Markdown link/heading injection attacks.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+!|~]/g, (char) => `\\${char}`);
}

/** Alias matching company-research proof convention for single inline markdown line escaping. */
export const escapeMarkdownInline = escapeMarkdown;

/**
 * Escapes an excerpt rendered inside a blockquote.
 */
export function formatExcerpt(text: string): string {
  let truncated = text;
  if (truncated.length > L.maxExcerptLength) {
    truncated = truncated.slice(0, L.maxExcerptLength) + "…";
  }
  return escapeMarkdown(truncated);
}

export interface RenderResultInput {
  readonly request: DocumentIntelligenceRequest;
  readonly document: DocumentMetadataSummary;
  readonly groundedDraft: GroundedDraft;
  readonly admittedEvidence: AdmittedEvidencePacket;
  readonly totalSpansAvailable: number;
  readonly extractionPartial: boolean;
  readonly extractionReasons: readonly string[];
}

/**
 * Deterministically renders markdown from DocumentIntelligenceResult fields.
 */
export function renderDocumentIntelligenceMarkdown(
  document: DocumentMetadataSummary,
  questions: readonly { id: string; question: string }[],
  answers: readonly GroundedAnswer[],
  evidenceIndex: readonly CitedEvidenceEntry[],
  limitations: readonly string[]
): string {
  const docTitle = document.filename ? escapeMarkdown(document.filename) : document.documentId;
  const mdLines: string[] = [];

  mdLines.push(`# Document Intelligence — ${docTitle}`);
  mdLines.push("");
  mdLines.push(`**Document ID:** \`${document.documentId}\`  `);
  mdLines.push(`**Fingerprint:** \`${document.documentFingerprint}\`  `);
  mdLines.push(`**Pages Extracted:** ${document.pagesExtracted} of ${document.pagesTotal}`);
  mdLines.push("");

  const questionMap = new Map<string, string>();
  questions.forEach((q) => questionMap.set(q.id, q.question));

  for (const ans of answers) {
    const qText = questionMap.get(ans.questionId) ?? ans.questionId;
    mdLines.push(`## Question: ${escapeMarkdown(qText)}`);
    mdLines.push("");

    if (ans.status === "insufficient_evidence") {
      mdLines.push(`*Insufficient evidence:* ${escapeMarkdown(ans.limitation ?? "No relevant evidence found.")}`);
      mdLines.push("");
    } else {
      for (const f of ans.findings) {
        const citations = f.citationIds.map((cid) => `[${cid}]`).join("");
        mdLines.push(`- ${escapeMarkdown(f.statement)} ${citations}`);
      }
      mdLines.push("");
    }
  }

  if (evidenceIndex.length > 0) {
    mdLines.push("## Evidence Index");
    mdLines.push("");
    for (const entry of evidenceIndex) {
      mdLines.push(`### [${entry.citationId}] Page ${entry.pageNumber}, chars ${entry.startOffset}–${entry.endOffset}`);
      mdLines.push(`> ${entry.excerpt}`);
      mdLines.push("");
    }
  }

  if (limitations.length > 0) {
    mdLines.push("## Limitations");
    mdLines.push("");
    for (const lim of limitations) {
      mdLines.push(`- ${escapeMarkdown(lim)}`);
    }
    mdLines.push("");
  }

  return mdLines.join("\n");
}

/**
 * Builds the canonical DocumentIntelligenceResult v1 and deterministic Markdown representation.
 */
export function buildDocumentIntelligenceResult(input: RenderResultInput): DocumentIntelligenceResult {
  const {
    request,
    document,
    groundedDraft,
    admittedEvidence,
    totalSpansAvailable,
    extractionPartial,
    extractionReasons,
  } = input;

  // 1. Build span lookup
  const spanMap = new Map<string, (typeof admittedEvidence.spans)[number]>();
  for (const span of admittedEvidence.spans) {
    spanMap.set(span.evidenceId, span);
  }

  // 2. Assign citation IDs (E1, E2, ...) in deterministic order of appearance across findings
  const citedEvidenceOrder: string[] = [];
  const evidenceToCitationId = new Map<string, string>();

  for (const ans of groundedDraft.answers) {
    for (const f of ans.findings) {
      for (const ref of f.evidenceRefs) {
        if (!evidenceToCitationId.has(ref)) {
          const citationId = `E${citedEvidenceOrder.length + 1}`;
          evidenceToCitationId.set(ref, citationId);
          citedEvidenceOrder.push(ref);
        }
      }
    }
  }

  // 3. Annotate findings with their citation IDs
  const answersWithCitations: GroundedAnswer[] = groundedDraft.answers.map((ans) => {
    const findingsWithCitations: GroundedFinding[] = ans.findings.map((f) => ({
      statement: f.statement,
      evidenceRefs: f.evidenceRefs,
      citationIds: Object.freeze(f.evidenceRefs.map((ref) => evidenceToCitationId.get(ref)!)),
    }));
    return {
      questionId: ans.questionId,
      status: ans.status,
      findings: Object.freeze(findingsWithCitations),
      ...(ans.limitation !== undefined ? { limitation: ans.limitation } : {}),
    };
  });

  // 4. Build Evidence Index
  const evidenceIndex: CitedEvidenceEntry[] = citedEvidenceOrder.map((evidenceId) => {
    const span = spanMap.get(evidenceId)!;
    const citationId = evidenceToCitationId.get(evidenceId)!;
    return {
      citationId,
      evidenceId,
      pageNumber: span.pageNumber,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      excerpt: formatExcerpt(span.text),
    };
  });

  // 5. Compute coverage counts
  const questionsTotal = request.questions.length;
  const questionsAnswered = answersWithCitations.filter((a) => a.status === "answered").length;
  const questionsInsufficient = answersWithCitations.filter((a) => a.status === "insufficient_evidence").length;

  const limitations = [...groundedDraft.overallLimitations];
  if (extractionPartial) {
    limitations.push(`Document extraction was partial: ${extractionReasons.join(", ")}.`);
  }
  if (admittedEvidence.admission.partial) {
    limitations.push(
      `Evidence context admission was capped: ${admittedEvidence.admission.admittedSpans} of ${admittedEvidence.admission.availableSpans} spans admitted.`
    );
  }

  // 6. Render deterministic Markdown
  const markdown = renderDocumentIntelligenceMarkdown(
    document,
    request.questions,
    answersWithCitations,
    evidenceIndex,
    limitations
  );

  return Object.freeze({
    schemaVersion: 1,
    document,
    questions: request.questions,
    answers: Object.freeze(answersWithCitations),
    evidenceIndex: Object.freeze(evidenceIndex),
    coverage: {
      questionsTotal,
      questionsAnswered,
      questionsInsufficient,
      spansAvailable: totalSpansAvailable,
      spansAdmitted: admittedEvidence.admission.admittedSpans,
      spansCited: evidenceIndex.length,
    },
    extraction: {
      partial: extractionPartial,
      reasons: Object.freeze(extractionReasons),
    },
    limitations: Object.freeze(limitations),
    markdown,
  });
}
