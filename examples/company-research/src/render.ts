import type { CompanyResearchRequest, CompanyResearchResult, EvidenceSummary, GroundedReport, ResearchSourcePacket } from "./contracts.js";
import { COMPANY_RESEARCH_LIMITS as L } from "./limits.js";

/**
 * Escapes untrusted text (company name, question, model statement, source
 * title) for one Markdown line: every line break becomes a space, so text
 * can never start a heading, list, or link definition, and Markdown and
 * HTML punctuation is neutralized, so it can never form a link, image,
 * emphasis, code span, table cell, or raw HTML.
 */
export function escapeMarkdownInline(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+!|~]/g, (char) => `\\${char}`);
}

/** Deterministic, factual limitation sentences derived from collection metadata, never from model output. */
export function evidenceLimitations(evidence: EvidenceSummary): string[] {
  const lines: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (evidence.sourcesAdmitted === 0) lines.push("No usable public-web evidence was retrieved, so no question could be answered from sources.");
  if (evidence.searchQueriesFailed > 0) lines.push(`${evidence.searchQueriesFailed} of ${evidence.searchQueries} search queries failed; evidence those queries would have found is missing.`);
  if (evidence.candidatesNotFetched > 0) lines.push(`${plural(evidence.candidatesNotFetched, "candidate source was", "candidate sources were")} not fetched because of the ${L.maxSources}-source limit.`);
  if (evidence.sourcesFailed > 0) lines.push(`${evidence.sourcesFailed} of ${evidence.sourcesRequested} selected sources could not be fetched.`);
  if (evidence.sourcesTruncated > 0) lines.push(`${plural(evidence.sourcesTruncated, "source was", "sources were")} truncated to fit the evidence budget.`);
  if (evidence.sourcesDropped > 0) lines.push(`${plural(evidence.sourcesDropped, "source was", "sources were")} excluded by the evidence budget.`);
  return lines;
}

/**
 * Builds CompanyResearchResult v1 from validated data only: the canonical
 * request, the grounded report, the admitted source packet, and the
 * evidence summary. Citation labels `S1…Sn` are assigned to the cited
 * sources in source-packet order (first-seen search ranking), so they are
 * stable for the same evidence. The Markdown is rendered here, by code;
 * the model never formats citations. No wall clock, randomness, or locale.
 */
export function buildCompanyResearchResult(input: { request: CompanyResearchRequest; report: GroundedReport; sourcePacket: ResearchSourcePacket; evidence: EvidenceSummary }): CompanyResearchResult {
  const { request, report, sourcePacket, evidence } = input;
  const cited = new Set(report.answers.flatMap((answer) => answer.findings.flatMap((finding) => finding.sourceRefs)));
  const sourceIndex = sourcePacket.sources.filter((source) => cited.has(source.sourceId)).map((source, index) => ({ label: `S${index + 1}`, sourceId: source.sourceId, title: source.title, url: source.url }));
  const labelOf = new Map(sourceIndex.map((entry) => [entry.sourceId, entry.label]));
  const answers = report.answers.map((answer) => ({
    questionId: answer.questionId,
    status: answer.status,
    findings: answer.findings.map((finding) => ({ statement: finding.statement, sourceRefs: [...finding.sourceRefs], citations: finding.sourceRefs.map((ref) => labelOf.get(ref)!) })),
    ...(answer.limitation !== undefined ? { limitation: answer.limitation } : {}),
  }));
  const questionsAnswered = answers.filter((answer) => answer.status === "answered").length;
  const result: Omit<CompanyResearchResult, "markdown"> = {
    schemaVersion: 1,
    company: { ...request.company },
    questions: request.questions.map((question) => ({ ...question })),
    answers,
    sourceIndex,
    sourcesConsulted: sourcePacket.sources.map((source) => ({ sourceId: source.sourceId, title: source.title, url: source.url })),
    coverage: { questionsTotal: request.questions.length, questionsAnswered, questionsInsufficient: answers.length - questionsAnswered, sourcesConsulted: sourcePacket.sources.length, sourcesCited: sourceIndex.length },
    evidence: { ...evidence },
    limitations: { evidence: evidenceLimitations(evidence), synthesis: [...report.overallLimitations] },
  };
  return { ...result, markdown: renderCompanyResearchMarkdown(result) };
}

/** Deterministic Markdown: same result, byte-identical output. */
export function renderCompanyResearchMarkdown(result: Omit<CompanyResearchResult, "markdown">): string {
  const lines: string[] = [`# Company Research — ${escapeMarkdownInline(result.company.name)}`, ""];
  if (result.company.domain !== undefined) lines.push(`Domain: ${escapeMarkdownInline(result.company.domain)}`, "");
  lines.push(`Questions answered: ${result.coverage.questionsAnswered} of ${result.coverage.questionsTotal}. Sources consulted: ${result.coverage.sourcesConsulted}; cited: ${result.coverage.sourcesCited}.`, "");
  result.questions.forEach((question, index) => {
    const answer = result.answers.find((entry) => entry.questionId === question.id)!;
    lines.push(`## Q${index + 1}. ${escapeMarkdownInline(question.question)}`, "");
    if (answer.status === "insufficient_evidence") {
      lines.push(`Insufficient evidence: ${escapeMarkdownInline(answer.limitation ?? "")}`, "");
      return;
    }
    for (const finding of answer.findings) lines.push(`- ${escapeMarkdownInline(finding.statement)} ${finding.citations.map((label) => `[${label}]`).join("")}`);
    lines.push("");
    if (answer.limitation !== undefined) lines.push(`Limitation: ${escapeMarkdownInline(answer.limitation)}`, "");
  });
  const limitations = [...result.limitations.evidence, ...result.limitations.synthesis];
  if (limitations.length > 0) {
    lines.push("## Limitations", "");
    for (const limitation of limitations) lines.push(`- ${escapeMarkdownInline(limitation)}`);
    lines.push("");
  }
  lines.push("## Sources", "");
  if (result.sourceIndex.length === 0) lines.push("No sources were cited.");
  for (const source of result.sourceIndex) lines.push(`- [${source.label}] ${escapeMarkdownInline(source.title)} — <${source.url}>`);
  lines.push("", "Citations show which retrieved source each finding refers to. They were checked to exist, not to prove the finding true.", "");
  return lines.join("\n");
}
