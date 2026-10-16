import { COMPANY_RESEARCH_LIMITS as L, SLUG_PATTERN } from "./limits.js";

// The proof's own contracts: strict, versioned, JSON-safe. Validation is
// hand-written deterministic code over `unknown` (no schema library), so
// the proof depends only on public AAO packages.

// --- Request -------------------------------------------------------------------

/** CompanyResearchRequest v1: what to research. The Workflow researches only these questions. */
export interface CompanyResearchRequest {
  schemaVersion: 1;
  company: { name: string; domain?: string };
  questions: { id: string; question: string }[];
}

/** What a caller passes: `schemaVersion` may be omitted (it defaults to 1). */
export type CompanyResearchRequestInput = Omit<CompanyResearchRequest, "schemaVersion"> & { schemaVersion?: 1 };

// --- Plan ----------------------------------------------------------------------

/** ResearchPlan: the bounded search queries the planning model proposes. No prose, no reasoning. */
export interface ResearchPlan {
  queries: { id: string; query: string; questionIds: string[] }[];
}

// --- Source packet -----------------------------------------------------------------

export interface ResearchSource {
  sourceId: string;
  title: string;
  url: string;
  text: string;
  /** Cut by the public-web Tool or by context admission. */
  truncated: boolean;
}

/**
 * ResearchSourcePacket v1: the admitted evidence, built deterministically
 * from projected source records. It is the only evidence the synthesis
 * model sees, and the only source index the grounding validator accepts.
 */
export interface ResearchSourcePacket {
  schemaVersion: 1;
  sources: ResearchSource[];
  admission: { offered: number; admitted: number; truncated: number; dropped: number };
}

/** Deterministic evidence-collection facts, for truthful limitations. */
export interface EvidenceSummary {
  partial: boolean;
  searchQueries: number;
  searchQueriesFailed: number;
  searchHits: number;
  candidateSources: number;
  candidatesNotFetched: number;
  sourcesRequested: number;
  sourcesFetched: number;
  sourcesFailed: number;
  sourcesTruncated: number;
  sourcesDropped: number;
  sourcesAdmitted: number;
}

// --- Draft and validated report ------------------------------------------------------

export type AnswerStatus = "answered" | "insufficient_evidence";

/** CompanyResearchDraft: the synthesis model's structured output. Source refs only; never URLs, titles, or indexes. */
export interface CompanyResearchDraft {
  answers: { questionId: string; status: AnswerStatus; findings: { statement: string; sourceRefs: string[] }[]; limitation?: string }[];
  overallLimitations: string[];
}

/** A draft that passed deterministic grounding validation, ordered by the request's questions. */
export type GroundedReport = CompanyResearchDraft;

// --- Final result ---------------------------------------------------------------------

export interface CompanyResearchSourceEntry {
  /** Human-facing citation label (`S1`, `S2`, …), assigned in source-packet order. */
  label: string;
  sourceId: string;
  title: string;
  url: string;
}

/** CompanyResearchResult v1: the final structured output. It carries no page bodies. */
export interface CompanyResearchResult {
  schemaVersion: 1;
  company: { name: string; domain?: string };
  questions: { id: string; question: string }[];
  answers: { questionId: string; status: AnswerStatus; findings: { statement: string; sourceRefs: string[]; citations: string[] }[]; limitation?: string }[];
  /** Only the cited sources, labelled `S1…Sn` in source-packet (search ranking) order. */
  sourceIndex: CompanyResearchSourceEntry[];
  /** Every admitted source the synthesis model was shown, cited or not. */
  sourcesConsulted: { sourceId: string; title: string; url: string }[];
  coverage: { questionsTotal: number; questionsAnswered: number; questionsInsufficient: number; sourcesConsulted: number; sourcesCited: number };
  evidence: EvidenceSummary;
  /** `evidence`: deterministic facts about collection. `synthesis`: limitations the model stated. */
  limitations: { evidence: string[]; synthesis: string[] };
  markdown: string;
}

// --- Validation helpers -----------------------------------------------------------------

export type Validation<T> = { ok: true; value: T } | { ok: false; issues: string[] };

const SLUG = new RegExp(SLUG_PATTERN);
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Own keys outside `allowed`, sorted. Strict contracts reject them. */
export const extraKeys = (value: Record<string, unknown>, allowed: readonly string[]): string[] => Object.keys(value).filter((key) => !allowed.includes(key)).sort();

/** Collapses whitespace runs to one space and trims. */
export const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

function boundedText(value: unknown, path: string, max: number, issues: string[]): string | undefined {
  if (typeof value !== "string") {
    issues.push(`${path}: must be a string`);
    return undefined;
  }
  const text = collapse(value);
  if (text.length === 0 || text.length > max) {
    issues.push(`${path}: must be 1–${max} characters`);
    return undefined;
  }
  return text;
}

/**
 * Deterministic intake validation for CompanyResearchRequest v1: strict
 * keys, trimmed and whitespace-collapsed text, a lowercase domain (no
 * scheme, path, or port), 1–8 questions with unique slug ids. The request
 * is returned canonical; nothing is inferred from the company name.
 */
export function validateCompanyResearchRequest(input: unknown): Validation<CompanyResearchRequest> {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ["request: must be an object"] };
  for (const key of extraKeys(input, ["schemaVersion", "company", "questions"])) issues.push(`request.${key}: unknown field`);
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) issues.push("request.schemaVersion: must be 1");

  let company: CompanyResearchRequest["company"] | undefined;
  if (!isRecord(input.company)) issues.push("request.company: must be an object");
  else {
    for (const key of extraKeys(input.company, ["name", "domain"])) issues.push(`request.company.${key}: unknown field`);
    const name = boundedText(input.company.name, "request.company.name", L.maxCompanyNameLength, issues);
    let domain: string | undefined;
    if (input.company.domain !== undefined) {
      const candidate = typeof input.company.domain === "string" ? input.company.domain.trim().toLowerCase() : "";
      if (DOMAIN.test(candidate)) domain = candidate;
      else issues.push("request.company.domain: must be a domain name such as acme.example (no scheme, port, or path)");
    }
    if (name !== undefined) company = { name, ...(domain !== undefined ? { domain } : {}) };
  }

  const questions: CompanyResearchRequest["questions"] = [];
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > L.maxQuestions) issues.push(`request.questions: must be an array of 1–${L.maxQuestions} questions`);
  else {
    const seen = new Set<string>();
    input.questions.forEach((raw: unknown, index: number) => {
      const path = `request.questions.${index}`;
      if (!isRecord(raw)) {
        issues.push(`${path}: must be an object`);
        return;
      }
      for (const key of extraKeys(raw, ["id", "question"])) issues.push(`${path}.${key}: unknown field`);
      const id = typeof raw.id === "string" && SLUG.test(raw.id) ? raw.id : undefined;
      if (id === undefined) issues.push(`${path}.id: must match ${SLUG_PATTERN}`);
      else if (seen.has(id)) issues.push(`${path}.id: duplicate question id "${id}"`);
      else seen.add(id);
      const question = boundedText(raw.question, `${path}.question`, L.maxQuestionLength, issues);
      if (id !== undefined && question !== undefined) questions.push({ id, question });
    });
  }

  if (issues.length > 0 || company === undefined) return { ok: false, issues };
  return { ok: true, value: { schemaVersion: 1, company, questions } };
}

/**
 * Deterministic validation of the planning model's ResearchPlan against
 * the request. Only whitespace is normalized; nothing is repaired:
 * 1–8 queries with unique slug ids, each 1–200 characters, unique after
 * case and whitespace normalization, each naming only requested question
 * ids, and every requested question covered by at least one query.
 */
export function validateResearchPlan(plan: unknown, request: CompanyResearchRequest): Validation<ResearchPlan> {
  const issues: string[] = [];
  if (!isRecord(plan)) return { ok: false, issues: ["plan: must be an object"] };
  for (const key of extraKeys(plan, ["queries"])) issues.push(`plan.${key}: unknown field`);
  if (!Array.isArray(plan.queries) || plan.queries.length < 1 || plan.queries.length > L.maxPlanQueries) return { ok: false, issues: [...issues, `plan.queries: must be an array of 1–${L.maxPlanQueries} queries`] };

  const known = new Set(request.questions.map((question) => question.id));
  const covered = new Set<string>();
  const ids = new Set<string>();
  const texts = new Set<string>();
  const queries: ResearchPlan["queries"] = [];
  plan.queries.forEach((raw: unknown, index: number) => {
    const path = `plan.queries.${index}`;
    if (!isRecord(raw)) {
      issues.push(`${path}: must be an object`);
      return;
    }
    for (const key of extraKeys(raw, ["id", "query", "questionIds"])) issues.push(`${path}.${key}: unknown field`);
    const id = typeof raw.id === "string" && SLUG.test(raw.id) ? raw.id : undefined;
    if (id === undefined) issues.push(`${path}.id: must match ${SLUG_PATTERN}`);
    else if (ids.has(id)) issues.push(`${path}.id: duplicate query id`);
    else ids.add(id);
    const query = boundedText(raw.query, `${path}.query`, L.maxQueryLength, issues);
    if (query !== undefined) {
      if (texts.has(query.toLowerCase())) issues.push(`${path}.query: duplicate query`);
      texts.add(query.toLowerCase());
    }
    const questionIds = Array.isArray(raw.questionIds) ? raw.questionIds : undefined;
    if (questionIds === undefined || questionIds.length < 1 || questionIds.length > L.maxQuestions) issues.push(`${path}.questionIds: must list 1–${L.maxQuestions} question ids`);
    else if (new Set(questionIds).size !== questionIds.length) issues.push(`${path}.questionIds: must be unique`);
    else {
      for (const questionId of questionIds) {
        if (typeof questionId !== "string" || !known.has(questionId)) issues.push(`${path}.questionIds: unknown question id`);
        else covered.add(questionId);
      }
    }
    if (id !== undefined && query !== undefined && questionIds !== undefined) queries.push({ id, query, questionIds: [...questionIds] as string[] });
  });
  for (const question of request.questions) if (!covered.has(question.id)) issues.push(`plan: question "${question.id}" is not covered by any query`);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { queries } };
}
