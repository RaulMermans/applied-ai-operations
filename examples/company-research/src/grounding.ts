import type { CompanyResearchRequest, GroundedReport, ResearchSourcePacket } from "./contracts.js";
import { extraKeys, isRecord } from "./contracts.js";
import { COMPANY_RESEARCH_LIMITS as L } from "./limits.js";

/**
 * Grounding issue codes, in the order they are checked. The first issue's
 * code is what the `validate_grounding` node reports, so it is stable.
 */
export const GROUNDING_ISSUE_CODES = [
  "GROUNDING_MALFORMED_DRAFT",
  "GROUNDING_BOUNDS_EXCEEDED",
  "GROUNDING_UNKNOWN_QUESTION",
  "GROUNDING_DUPLICATE_ANSWER",
  "GROUNDING_MISSING_ANSWER",
  "GROUNDING_ANSWERED_WITHOUT_FINDINGS",
  "GROUNDING_MISSING_CITATION",
  "GROUNDING_UNKNOWN_SOURCE_REF",
  "GROUNDING_DUPLICATE_SOURCE_REF",
  "GROUNDING_INSUFFICIENT_WITH_FINDINGS",
  "GROUNDING_MISSING_LIMITATION",
  "GROUNDING_URL_IN_TEXT",
] as const;
export type GroundingIssueCode = (typeof GROUNDING_ISSUE_CODES)[number];

export interface GroundingIssue {
  code: GroundingIssueCode;
  path: string;
}

export type GroundingValidation = { ok: true; report: GroundedReport } | { ok: false; issues: GroundingIssue[] };

/** A URL in model-written text. Source URLs come only from the deterministic source index. */
const URL_IN_TEXT = /\b(?:https?|ftp|file|javascript|data):|\bwww\./i;

/**
 * Deterministic citation-integrity validation of the synthesis model's
 * draft against the request and the admitted source packet. It checks:
 *
 * - the strict draft shape and every bound (no extra fields, so the model
 *   cannot supply a URL, source title, or source index);
 * - every requested question is answered exactly once, and no other;
 * - an `answered` answer has findings, and every finding cites 1–5
 *   distinct source ids that exist in the source packet;
 * - an `insufficient_evidence` answer has no findings and a limitation;
 * - model text contains no URL.
 *
 * What it does NOT prove: that a cited source semantically supports, or
 * entails, the statement that cites it. Reference integrity means "the
 * citation exists and points to admitted evidence", not "the claim is
 * true". Semantic support needs a separate judgment (a model judge, a
 * human reviewer, or a specialized grounding Eval).
 *
 * Pure and deterministic: same inputs, deep-equal output. On success the
 * report is a detached copy with answers in request question order.
 */
export function validateCompanyResearchDraft(input: { request: CompanyResearchRequest; sourcePacket: ResearchSourcePacket; draft: unknown }): GroundingValidation {
  const { request, sourcePacket, draft } = input;
  const issues: GroundingIssue[] = [];
  const issue = (code: GroundingIssueCode, path: string) => issues.push({ code, path });
  const sourceIds = new Set(sourcePacket.sources.map((source) => source.sourceId));
  const questionIds = new Set(request.questions.map((question) => question.id));

  if (!isRecord(draft) || extraKeys(draft, ["answers", "overallLimitations"]).length > 0 || !Array.isArray(draft.answers) || !Array.isArray(draft.overallLimitations)) {
    return { ok: false, issues: [{ code: "GROUNDING_MALFORMED_DRAFT", path: "draft" }] };
  }
  const text = (value: unknown, path: string, max: number): string | undefined => {
    if (typeof value !== "string" || value.trim().length === 0) {
      issue("GROUNDING_MALFORMED_DRAFT", path);
      return undefined;
    }
    if (value.length > max) issue("GROUNDING_BOUNDS_EXCEEDED", path);
    if (URL_IN_TEXT.test(value)) issue("GROUNDING_URL_IN_TEXT", path);
    return value.trim();
  };

  if (draft.answers.length > L.maxQuestions) issue("GROUNDING_BOUNDS_EXCEEDED", "draft.answers");
  if (draft.overallLimitations.length > L.maxOverallLimitations) issue("GROUNDING_BOUNDS_EXCEEDED", "draft.overallLimitations");
  const overallLimitations = draft.overallLimitations.map((limitation: unknown, index: number) => text(limitation, `draft.overallLimitations.${index}`, L.maxLimitationLength));

  const answers = new Map<string, GroundedReport["answers"][number]>();
  draft.answers.forEach((raw: unknown, index: number) => {
    const path = `draft.answers.${index}`;
    if (!isRecord(raw) || extraKeys(raw, ["questionId", "status", "findings", "limitation"]).length > 0 || typeof raw.questionId !== "string" || (raw.status !== "answered" && raw.status !== "insufficient_evidence") || !Array.isArray(raw.findings)) {
      issue("GROUNDING_MALFORMED_DRAFT", path);
      return;
    }
    const { questionId, status } = raw;
    if (!questionIds.has(questionId)) issue("GROUNDING_UNKNOWN_QUESTION", `${path}.questionId`);
    else if (answers.has(questionId)) issue("GROUNDING_DUPLICATE_ANSWER", `${path}.questionId`);
    if (raw.findings.length > L.maxFindingsPerAnswer) issue("GROUNDING_BOUNDS_EXCEEDED", `${path}.findings`);
    if (status === "answered" && raw.findings.length === 0) issue("GROUNDING_ANSWERED_WITHOUT_FINDINGS", `${path}.findings`);
    if (status === "insufficient_evidence" && raw.findings.length > 0) issue("GROUNDING_INSUFFICIENT_WITH_FINDINGS", `${path}.findings`);
    if (status === "insufficient_evidence" && raw.limitation === undefined) issue("GROUNDING_MISSING_LIMITATION", `${path}.limitation`);
    const limitation = raw.limitation === undefined ? undefined : text(raw.limitation, `${path}.limitation`, L.maxLimitationLength);

    const findings: GroundedReport["answers"][number]["findings"] = [];
    raw.findings.forEach((finding: unknown, findingIndex: number) => {
      const findingPath = `${path}.findings.${findingIndex}`;
      if (!isRecord(finding) || extraKeys(finding, ["statement", "sourceRefs"]).length > 0 || !Array.isArray(finding.sourceRefs)) {
        issue("GROUNDING_MALFORMED_DRAFT", findingPath);
        return;
      }
      const statement = text(finding.statement, `${findingPath}.statement`, L.maxStatementLength);
      const refs = finding.sourceRefs as unknown[];
      if (refs.length === 0) issue("GROUNDING_MISSING_CITATION", `${findingPath}.sourceRefs`);
      if (refs.length > L.maxSourceRefsPerFinding) issue("GROUNDING_BOUNDS_EXCEEDED", `${findingPath}.sourceRefs`);
      refs.forEach((ref, refIndex) => {
        if (typeof ref !== "string" || !sourceIds.has(ref)) issue("GROUNDING_UNKNOWN_SOURCE_REF", `${findingPath}.sourceRefs.${refIndex}`);
      });
      if (new Set(refs).size !== refs.length) issue("GROUNDING_DUPLICATE_SOURCE_REF", `${findingPath}.sourceRefs`);
      if (statement !== undefined) findings.push({ statement, sourceRefs: refs.filter((ref): ref is string => typeof ref === "string") });
    });
    if (questionIds.has(questionId) && !answers.has(questionId)) answers.set(questionId, { questionId, status, findings, ...(limitation !== undefined ? { limitation } : {}) });
  });
  for (const question of request.questions) if (!answers.has(question.id) && !issues.some((entry) => entry.code === "GROUNDING_MALFORMED_DRAFT")) issue("GROUNDING_MISSING_ANSWER", `draft.answers[${question.id}]`);

  if (issues.length > 0) {
    const rank = (code: GroundingIssueCode) => GROUNDING_ISSUE_CODES.indexOf(code);
    return { ok: false, issues: issues.map((entry, order) => ({ entry, order })).sort((a, b) => rank(a.entry.code) - rank(b.entry.code) || a.order - b.order).map(({ entry }) => entry) };
  }
  return {
    ok: true,
    report: {
      answers: request.questions.map((question) => answers.get(question.id)!),
      overallLimitations: overallLimitations as string[],
    },
  };
}
