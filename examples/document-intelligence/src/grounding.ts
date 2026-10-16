import type {
  AdmittedEvidencePacket,
  DocumentIntelligenceRequest,
  GroundedAnswer,
  GroundedDraft,
  GroundedFinding,
} from "./contracts.js";
import { isRecord } from "./contracts.js";
import { DOCUMENT_INTELLIGENCE_LIMITS as L, EVIDENCE_ID_PATTERN } from "./limits.js";

/**
 * Grounding issue codes, in the order they are checked.
 * Deterministic: the first issue code is reported by the `validate_grounding` node.
 */
export const GROUNDING_ISSUE_CODES = [
  "GROUNDING_MALFORMED_DRAFT",
  "GROUNDING_BOUNDS_EXCEEDED",
  "GROUNDING_UNKNOWN_QUESTION",
  "GROUNDING_DUPLICATE_ANSWER",
  "GROUNDING_MISSING_ANSWER",
  "GROUNDING_ANSWERED_WITHOUT_FINDINGS",
  "GROUNDING_MISSING_CITATION",
  "GROUNDING_UNKNOWN_EVIDENCE_REF",
  "GROUNDING_DUPLICATE_EVIDENCE_REF",
  "GROUNDING_INSUFFICIENT_WITH_FINDINGS",
  "GROUNDING_MISSING_LIMITATION",
  "GROUNDING_URL_IN_TEXT",
  "GROUNDING_ANCHOR_IN_TEXT",
] as const;

export type GroundingIssueCode = (typeof GROUNDING_ISSUE_CODES)[number];

export interface GroundingIssue {
  readonly code: GroundingIssueCode;
  readonly path: string;
}

export type GroundingValidationResult =
  | { readonly ok: true; readonly groundedDraft: GroundedDraft }
  | { readonly ok: false; readonly code: GroundingIssueCode; readonly issues: readonly GroundingIssue[] };

export interface GroundingValidationInput {
  readonly request: DocumentIntelligenceRequest;
  readonly admittedEvidence: AdmittedEvidencePacket;
  readonly draft: unknown;
}

/** Check if text attempts to include raw URLs. Evidence comes only from precomputed span IDs. */
const URL_IN_TEXT = /\b(?:https?|ftp|file|javascript|data):|\bwww\./i;

/**
 * Deterministically validates the model's structured synthesis draft against the
 * admitted evidence spans and the original user request.
 *
 * Rules enforced:
 * 1. Strict draft shape and bounds (additional properties rejected).
 * 2. Exact question coverage: every requested question must be answered exactly once, no extra questions.
 * 3. Status 'answered' requires at least 1 finding, and each finding requires 1–5 evidenceRefs.
 * 4. Status 'insufficient_evidence' requires 0 findings and a non-empty limitation.
 * 5. Every cited evidenceRef must exist in the admitted evidence packet.
 * 6. No duplicate evidenceRefs within a single finding.
 * 7. Model must never author URLs or anchor metadata.
 * 8. Pure and deterministic: same inputs produce deep-equal results.
 *
 * Grounding reference integrity proves exact provenance to admitted spans; it does not
 * evaluate semantic entailment (which is evaluated separately via graders/judges).
 */
export function validateDocumentIntelligenceDraft(input: GroundingValidationInput): GroundingValidationResult {
  const { request, admittedEvidence, draft } = input;
  const issues: GroundingIssue[] = [];
  const issue = (code: GroundingIssueCode, path: string) => issues.push({ code, path });

  if (!isRecord(draft)) {
    issue("GROUNDING_MALFORMED_DRAFT", "draft");
    return { ok: false, code: "GROUNDING_MALFORMED_DRAFT", issues };
  }

  const allowedDraftKeys = new Set(["answers", "overallLimitations"]);
  for (const k of Object.keys(draft)) {
    if (!allowedDraftKeys.has(k)) {
      issue("GROUNDING_MALFORMED_DRAFT", `draft.${k}`);
    }
  }

  const answersRaw = draft.answers;
  if (!Array.isArray(answersRaw)) {
    issue("GROUNDING_MALFORMED_DRAFT", "draft.answers");
    return { ok: false, code: "GROUNDING_MALFORMED_DRAFT", issues };
  }

  const overallLimitationsRaw = draft.overallLimitations;
  if (!Array.isArray(overallLimitationsRaw)) {
    issue("GROUNDING_MALFORMED_DRAFT", "draft.overallLimitations");
    return { ok: false, code: "GROUNDING_MALFORMED_DRAFT", issues };
  }

  if (overallLimitationsRaw.length > L.maxOverallLimitations) {
    issue("GROUNDING_BOUNDS_EXCEEDED", "draft.overallLimitations");
  }

  const overallLimitations: string[] = [];
  for (let i = 0; i < overallLimitationsRaw.length; i++) {
    const lim = overallLimitationsRaw[i];
    const path = `draft.overallLimitations[${i}]`;
    if (typeof lim !== "string" || lim.trim().length === 0) {
      issue("GROUNDING_MALFORMED_DRAFT", path);
    } else if (lim.length > L.maxLimitationLength) {
      issue("GROUNDING_BOUNDS_EXCEEDED", path);
    } else if (URL_IN_TEXT.test(lim)) {
      issue("GROUNDING_URL_IN_TEXT", path);
    } else {
      overallLimitations.push(lim.trim());
    }
  }

  const requestedQuestionIds = new Set(request.questions.map((q) => q.id));
  const seenQuestionIds = new Set<string>();
  const admittedSpanIds = new Set(admittedEvidence.spans.map((s) => s.evidenceId));
  const citedEvidenceIdSet = new Set<string>();
  const groundedAnswers: GroundedAnswer[] = [];

  for (let aIdx = 0; aIdx < answersRaw.length; aIdx++) {
    const ans = answersRaw[aIdx];
    const aPath = `draft.answers[${aIdx}]`;

    if (!isRecord(ans)) {
      issue("GROUNDING_MALFORMED_DRAFT", aPath);
      continue;
    }

    const allowedAnsKeys = new Set(["questionId", "status", "findings", "limitation"]);
    for (const k of Object.keys(ans)) {
      if (!allowedAnsKeys.has(k)) {
        issue("GROUNDING_MALFORMED_DRAFT", `${aPath}.${k}`);
      }
    }

    const qid = ans.questionId;
    if (typeof qid !== "string") {
      issue("GROUNDING_MALFORMED_DRAFT", `${aPath}.questionId`);
      continue;
    }

    if (!requestedQuestionIds.has(qid)) {
      issue("GROUNDING_UNKNOWN_QUESTION", `${aPath}.questionId`);
    }

    if (seenQuestionIds.has(qid)) {
      issue("GROUNDING_DUPLICATE_ANSWER", `${aPath}.questionId`);
    }
    seenQuestionIds.add(qid);

    const status = ans.status;
    if (status !== "answered" && status !== "insufficient_evidence") {
      issue("GROUNDING_MALFORMED_DRAFT", `${aPath}.status`);
      continue;
    }

    const findingsRaw = ans.findings;
    if (!Array.isArray(findingsRaw)) {
      issue("GROUNDING_MALFORMED_DRAFT", `${aPath}.findings`);
      continue;
    }

    if (status === "insufficient_evidence") {
      if (findingsRaw.length > 0) {
        issue("GROUNDING_INSUFFICIENT_WITH_FINDINGS", `${aPath}.findings`);
      }
      if (typeof ans.limitation !== "string" || ans.limitation.trim().length === 0) {
        issue("GROUNDING_MISSING_LIMITATION", `${aPath}.limitation`);
      } else if (ans.limitation.length > L.maxLimitationLength) {
        issue("GROUNDING_BOUNDS_EXCEEDED", `${aPath}.limitation`);
      } else if (URL_IN_TEXT.test(ans.limitation)) {
        issue("GROUNDING_URL_IN_TEXT", `${aPath}.limitation`);
      }

      groundedAnswers.push({
        questionId: qid,
        status: "insufficient_evidence",
        findings: Object.freeze([]),
        ...(typeof ans.limitation === "string" ? { limitation: ans.limitation.trim() } : {}),
      });
      continue;
    }

    // status === "answered"
    if (findingsRaw.length === 0) {
      issue("GROUNDING_ANSWERED_WITHOUT_FINDINGS", `${aPath}.findings`);
      continue;
    }
    if (findingsRaw.length > L.maxFindingsPerAnswer) {
      issue("GROUNDING_BOUNDS_EXCEEDED", `${aPath}.findings`);
    }

    const groundedFindings: GroundedFinding[] = [];

    for (let fIdx = 0; fIdx < findingsRaw.length; fIdx++) {
      const f = findingsRaw[fIdx];
      const fPath = `${aPath}.findings[${fIdx}]`;

      if (!isRecord(f)) {
        issue("GROUNDING_MALFORMED_DRAFT", fPath);
        continue;
      }

      const allowedFindingKeys = new Set(["statement", "evidenceRefs"]);
      for (const k of Object.keys(f)) {
        if (!allowedFindingKeys.has(k)) {
          issue("GROUNDING_MALFORMED_DRAFT", `${fPath}.${k}`);
        }
      }

      const stmt = f.statement;
      if (typeof stmt !== "string" || stmt.trim().length === 0) {
        issue("GROUNDING_MALFORMED_DRAFT", `${fPath}.statement`);
      } else if (stmt.length > L.maxStatementLength) {
        issue("GROUNDING_BOUNDS_EXCEEDED", `${fPath}.statement`);
      } else if (URL_IN_TEXT.test(stmt)) {
        issue("GROUNDING_URL_IN_TEXT", `${fPath}.statement`);
      }

      const refsRaw = f.evidenceRefs;
      if (!Array.isArray(refsRaw)) {
        issue("GROUNDING_MALFORMED_DRAFT", `${fPath}.evidenceRefs`);
        continue;
      }

      if (refsRaw.length < L.minEvidenceRefsPerFinding || refsRaw.length > L.maxEvidenceRefsPerFinding) {
        issue("GROUNDING_BOUNDS_EXCEEDED", `${fPath}.evidenceRefs`);
      }

      const findingRefs: string[] = [];
      const seenFindingRefs = new Set<string>();

      for (let rIdx = 0; rIdx < refsRaw.length; rIdx++) {
        const ref = refsRaw[rIdx];
        const rPath = `${fPath}.evidenceRefs[${rIdx}]`;

        if (typeof ref !== "string" || !EVIDENCE_ID_PATTERN.test(ref)) {
          issue("GROUNDING_MALFORMED_DRAFT", rPath);
          continue;
        }

        if (seenFindingRefs.has(ref)) {
          issue("GROUNDING_DUPLICATE_EVIDENCE_REF", rPath);
        }
        seenFindingRefs.add(ref);

        if (!admittedSpanIds.has(ref)) {
          issue("GROUNDING_UNKNOWN_EVIDENCE_REF", rPath);
        }

        findingRefs.push(ref);
        citedEvidenceIdSet.add(ref);
      }

      if (typeof stmt === "string" && stmt.trim().length > 0) {
        groundedFindings.push({
          statement: stmt.trim(),
          evidenceRefs: Object.freeze(findingRefs),
          citationIds: Object.freeze([]), // will be populated at render
        });
      }
    }

    groundedAnswers.push({
      questionId: qid,
      status: "answered",
      findings: Object.freeze(groundedFindings),
      ...(typeof ans.limitation === "string" && ans.limitation.trim().length > 0 ? { limitation: ans.limitation.trim() } : {}),
    });
  }

  // Ensure every requested question was answered
  for (const q of request.questions) {
    if (!seenQuestionIds.has(q.id)) {
      issue("GROUNDING_MISSING_ANSWER", `draft.answers.${q.id}`);
    }
  }

  if (issues.length > 0) {
    return { ok: false, code: issues[0]!.code, issues: Object.freeze(issues) };
  }

  // Sort answers to match the exact order of questions in the user request
  const questionOrderMap = new Map<string, number>();
  request.questions.forEach((q, idx) => questionOrderMap.set(q.id, idx));
  groundedAnswers.sort((a, b) => (questionOrderMap.get(a.questionId) ?? 0) - (questionOrderMap.get(b.questionId) ?? 0));

  return {
    ok: true,
    groundedDraft: {
      answers: Object.freeze(groundedAnswers),
      overallLimitations: Object.freeze(overallLimitations),
      citedEvidenceIds: Object.freeze([...citedEvidenceIdSet]),
    },
  };
}
