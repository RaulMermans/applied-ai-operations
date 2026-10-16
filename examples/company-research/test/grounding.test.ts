import { describe, expect, it } from "vitest";
import { ACME_DRAFT, ACME_REQUEST, PAGES, SOURCE_IDS } from "../fixtures/index.js";
import { buildCompanyResearchResult, escapeMarkdownInline, validateCompanyResearchDraft, validateCompanyResearchRequest, validateResearchPlan, type CompanyResearchRequest, type EvidenceSummary, type ResearchSourcePacket } from "../src/index.js";

const request = (validateCompanyResearchRequest(ACME_REQUEST) as { ok: true; value: CompanyResearchRequest }).value;
const source = (key: keyof typeof PAGES) => ({ sourceId: SOURCE_IDS[key], title: PAGES[key].title, url: PAGES[key].url, text: PAGES[key].text, truncated: false });
const packet: ResearchSourcePacket = { schemaVersion: 1, sources: [source("home"), source("launch"), source("review"), source("customers")], admission: { offered: 4, admitted: 4, truncated: 0, dropped: 0 } };
const evidence: EvidenceSummary = { partial: false, searchQueries: 3, searchQueriesFailed: 0, searchHits: 8, candidateSources: 4, candidatesNotFetched: 0, sourcesRequested: 4, sourcesFetched: 4, sourcesFailed: 0, sourcesTruncated: 0, sourcesDropped: 0, sourcesAdmitted: 4 };
const clone = () => JSON.parse(JSON.stringify(ACME_DRAFT)) as typeof ACME_DRAFT & Record<string, unknown>;
const codes = (draft: unknown) => {
  const result = validateCompanyResearchDraft({ request, sourcePacket: packet, draft });
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

describe("deterministic grounding validation (citation integrity)", () => {
  it("valid refs pass, and the report is ordered by the request's questions", () => {
    const draft = clone();
    draft.answers.reverse();
    const result = validateCompanyResearchDraft({ request, sourcePacket: packet, draft });
    expect(result.ok).toBe(true);
    expect(result.ok && result.report.answers.map((answer) => answer.questionId)).toEqual(["offering", "customers", "differentiation"]);
  });

  it.each<[string, (draft: ReturnType<typeof clone>) => void, string]>([
    ["unknown ref", (d) => { d.answers[0]!.findings[0]!.sourceRefs = ["src.does-not-exist"]; }, "GROUNDING_UNKNOWN_SOURCE_REF"],
    ["a source title used as a ref", (d) => { d.answers[0]!.findings[0]!.sourceRefs = [PAGES.home.title]; }, "GROUNDING_UNKNOWN_SOURCE_REF"],
    ["a citation label used as a ref", (d) => { d.answers[0]!.findings[0]!.sourceRefs = ["S1"]; }, "GROUNDING_UNKNOWN_SOURCE_REF"],
    ["empty refs on an answered claim", (d) => { d.answers[0]!.findings[0]!.sourceRefs = []; }, "GROUNDING_MISSING_CITATION"],
    ["duplicate refs in one finding", (d) => { d.answers[0]!.findings[0]!.sourceRefs = [SOURCE_IDS.home, SOURCE_IDS.home]; }, "GROUNDING_DUPLICATE_SOURCE_REF"],
    ["an invented question", (d) => { d.answers.push({ questionId: "ceo", status: "answered", findings: [{ statement: "x", sourceRefs: [SOURCE_IDS.home] }] }); }, "GROUNDING_UNKNOWN_QUESTION"],
    ["a missing question", (d) => { d.answers.splice(1, 1); }, "GROUNDING_MISSING_ANSWER"],
    ["a duplicate answer", (d) => { d.answers.push(JSON.parse(JSON.stringify(d.answers[0]))); }, "GROUNDING_DUPLICATE_ANSWER"],
    ["answered without findings", (d) => { d.answers[0]!.findings = []; }, "GROUNDING_ANSWERED_WITHOUT_FINDINGS"],
    ["insufficient with findings", (d) => { Object.assign(d.answers[0]!, { status: "insufficient_evidence", limitation: "none" }); }, "GROUNDING_INSUFFICIENT_WITH_FINDINGS"],
    ["insufficient without limitation", (d) => { Object.assign(d.answers[0]!, { status: "insufficient_evidence", findings: [] }); }, "GROUNDING_MISSING_LIMITATION"],
    ["a URL in a statement", (d) => { d.answers[0]!.findings[0]!.statement = "Read more at www.acme.example"; }, "GROUNDING_URL_IN_TEXT"],
    ["a javascript: URL in a limitation", (d) => { d.overallLimitations = ["javascript:alert(1)"]; }, "GROUNDING_URL_IN_TEXT"],
    ["a url field on a finding", (d) => { Object.assign(d.answers[0]!.findings[0]!, { url: PAGES.home.url }); }, "GROUNDING_MALFORMED_DRAFT"],
    ["a sourceIndex field on the draft", (d) => { Object.assign(d, { sourceIndex: [] }); }, "GROUNDING_MALFORMED_DRAFT"],
    ["too many findings", (d) => { d.answers[0]!.findings = Array.from({ length: 6 }, () => ({ statement: "x", sourceRefs: [SOURCE_IDS.home] })); }, "GROUNDING_BOUNDS_EXCEEDED"],
    ["too many refs per finding", (d) => { d.answers[0]!.findings[0]!.sourceRefs = [SOURCE_IDS.home, SOURCE_IDS.launch, SOURCE_IDS.review, SOURCE_IDS.customers, "a", "b"]; }, "GROUNDING_BOUNDS_EXCEEDED"],
    ["an oversized statement", (d) => { d.answers[0]!.findings[0]!.statement = "x".repeat(501); }, "GROUNDING_BOUNDS_EXCEEDED"],
    ["too many overall limitations", (d) => { d.overallLimitations = Array.from({ length: 6 }, (_, i) => `l${i}`); }, "GROUNDING_BOUNDS_EXCEEDED"],
  ])("%s → %s", (_label, mutate, code) => {
    const draft = clone();
    mutate(draft);
    expect(codes(draft)).toContain(code);
  });

  it("issues are reported in a stable, deterministic order", () => {
    const draft = clone();
    draft.answers[0]!.findings[0]!.sourceRefs = ["src.does-not-exist"];
    draft.answers.pop();
    expect(codes(draft)).toEqual(["GROUNDING_MISSING_ANSWER", "GROUNDING_UNKNOWN_SOURCE_REF"]);
    expect(codes(JSON.parse(JSON.stringify(draft)))).toEqual(codes(draft));
  });

  it("a ref that exists in the packet but was never admitted (a fetch failure) is unknown", () => {
    const smaller = { ...packet, sources: packet.sources.filter((entry) => entry.sourceId !== SOURCE_IDS.customers) };
    const result = validateCompanyResearchDraft({ request, sourcePacket: smaller, draft: ACME_DRAFT });
    expect(!result.ok && result.issues[0]).toEqual({ code: "GROUNDING_UNKNOWN_SOURCE_REF", path: "draft.answers.1.findings.0.sourceRefs.0" });
  });

  it("non-objects and wrong shapes are malformed, never thrown", () => {
    for (const draft of [null, "x", [], { answers: "x", overallLimitations: [] }, { answers: [null], overallLimitations: [] }]) expect(codes(draft)[0]).toBe("GROUNDING_MALFORMED_DRAFT");
  });

  it("does not claim semantic entailment: a well-formed citation to an unrelated source passes integrity", () => {
    const draft = clone();
    draft.answers[1]!.findings[0]!.sourceRefs = [SOURCE_IDS.launch];
    expect(validateCompanyResearchDraft({ request, sourcePacket: packet, draft }).ok).toBe(true);
  });
});

describe("request and plan contracts", () => {
  it("the request is strict and versioned", () => {
    expect(validateCompanyResearchRequest({ ...ACME_REQUEST, schemaVersion: 2 }).ok).toBe(false);
    expect(validateCompanyResearchRequest({ ...ACME_REQUEST, schemaVersion: 1 }).ok).toBe(true);
    expect(validateCompanyResearchRequest({ ...ACME_REQUEST, company: { name: "Acme", apiKey: "x" } }).ok).toBe(false);
    expect(validateCompanyResearchRequest({ ...ACME_REQUEST, company: { name: "x".repeat(121) } }).ok).toBe(false);
    expect(validateCompanyResearchRequest({ ...ACME_REQUEST, questions: [{ id: "Bad Id", question: "Q?" }] }).ok).toBe(false);
  });

  it("the plan is validated without repair beyond whitespace", () => {
    const plan = { queries: [{ id: "q", query: "  Acme\n products ", questionIds: ["offering", "customers", "differentiation"] }] };
    expect(validateResearchPlan(plan, request)).toEqual({ ok: true, value: { queries: [{ id: "q", query: "Acme products", questionIds: ["offering", "customers", "differentiation"] }] } });
    expect(validateResearchPlan({ queries: [{ id: "q", query: "x", questionIds: ["offering", "offering", "customers", "differentiation"] }] }, request).ok).toBe(false);
    expect(validateResearchPlan({ queries: [{ id: "q", query: "x", questionIds: ["offering", "customers", "differentiation"] }, { id: "q", query: "y", questionIds: ["offering"] }] }, request).ok).toBe(false);
  });
});

describe("deterministic Markdown rendering", () => {
  const build = () => {
    const checked = validateCompanyResearchDraft({ request, sourcePacket: packet, draft: ACME_DRAFT });
    if (!checked.ok) throw new Error("draft invalid");
    return buildCompanyResearchResult({ request, report: checked.report, sourcePacket: packet, evidence });
  };

  it("same validated result → byte-identical Markdown", () => {
    expect(build().markdown).toBe(build().markdown);
  });

  it("renders headings, cited findings, and a source list with stable labels", () => {
    const markdown = build().markdown;
    expect(markdown).toContain("# Company Research — Acme Analytics\n");
    expect(markdown).toContain("## Q1. What does Acme Analytics sell?\n");
    expect(markdown).toContain("- Its customers appear to be mid-size online retailers with 50 to 500 employees in Europe and North America. [S3]");
    expect(markdown).toContain(`- [S1] Acme Analytics — Product analytics for mid-size online retailers — <${PAGES.home.url}>`);
    expect(markdown).not.toContain(SOURCE_IDS.home);
    expect(markdown).toContain("checked to exist, not to prove the finding true");
  });

  it("a malicious source title, company name, or question cannot break document structure", () => {
    const title = "Evil\n# Injected heading\n[S9]: javascript:alert(1)\n<img src=x onerror=alert(1)> **bold** | cell |";
    const hostile: ResearchSourcePacket = { ...packet, sources: packet.sources.map((entry) => (entry.sourceId === SOURCE_IDS.home ? { ...entry, title } : entry)) };
    const hostileRequest = { ...request, company: { name: "Acme\n## Fake section" }, questions: request.questions.map((question, index) => (index === 0 ? { ...question, question: "Sell?\n- [x](javascript:alert(1))" } : question)) };
    const checked = validateCompanyResearchDraft({ request: hostileRequest, sourcePacket: hostile, draft: ACME_DRAFT });
    if (!checked.ok) throw new Error("draft invalid");
    const markdown = buildCompanyResearchResult({ request: hostileRequest, report: checked.report, sourcePacket: hostile, evidence }).markdown;
    const lines = markdown.split("\n");
    expect(lines.filter((line) => line.startsWith("#"))).toEqual(["# Company Research — Acme \\#\\# Fake section", "## Q1. Sell? - \\[x\\]\\(javascript:alert\\(1\\)\\)", "## Q2. Who appears to be its target customer?", "## Q3. What differentiates its product?", "## Limitations", "## Sources"]);
    expect(markdown).not.toMatch(/<img|^\[S9\]:|\*\*bold\*\*/m);
    expect(markdown).toContain("&lt;img src=x onerror=alert\\(1\\)&gt;");
  });

  it("escapeMarkdownInline neutralizes Markdown and HTML punctuation and line breaks", () => {
    expect(escapeMarkdownInline("a\n\n# b *c* [d](e) <f> `g` | h & i")).toBe("a \\# b \\*c\\* \\[d\\]\\(e\\) &lt;f&gt; \\`g\\` \\| h &amp; i");
  });
});
