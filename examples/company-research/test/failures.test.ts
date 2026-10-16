import { vi, describe, expect, it } from "vitest";
import { ACME_DRAFT, ACME_PLAN, ACME_REQUEST, PAGES, SOURCE_IDS, drafter, insufficientDraft } from "../fixtures/index.js";
import { COMPANY_RESEARCH_LIMITS, STATE_KEYS, type CompanyResearchResult, type ResearchSourcePacket } from "../src/index.js";
import { nodesCompleted, ofType, runProof, toolsStarted, values } from "./support.js";

// Each test runs complete proof Workflows; keep them reliable on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

type Run = Awaited<ReturnType<typeof runProof>>;
const failureOf = (run: Run) => (run.outcome.status === "failed" ? run.outcome.failure : undefined);
const resultOf = (run: Run): CompanyResearchResult => {
  if (run.outcome.status !== "completed") throw new Error(`expected completion, got ${JSON.stringify(run.outcome.failure)}`);
  return run.outcome.result;
};
const draftWith = (mutate: (draft: typeof ACME_DRAFT) => void) => {
  const draft = JSON.parse(JSON.stringify(ACME_DRAFT)) as typeof ACME_DRAFT;
  mutate(draft);
  return draft;
};
/** The Run stopped before rendering: no grounded report and no final result in state. */
const noReport = (run: Run) => {
  const state = values(run.outcome);
  expect(state[STATE_KEYS.researchResult]).toBeUndefined();
  expect(nodesCompleted(run.trace)).not.toContain("render");
};

describe("intake and planning failures stop before any external call", () => {
  it("an invalid request fails at intake: no model call, no Tool, no provider call", async () => {
    const run = await runProof({ request: { company: { name: "" }, questions: [] } as never });
    expect(failureOf(run)).toEqual({ code: "NODE_EXECUTION_FAILED", nodeId: "intake", executorFailure: { namespace: "deterministic", code: "INVALID_RESEARCH_REQUEST" } });
    expect(run.model.requests).toHaveLength(0);
    expect(run.provider.calls).toEqual({ search: [], fetch: [] });
  });

  it.each([
    ["duplicate question ids", { ...ACME_REQUEST, questions: [{ id: "a", question: "Q?" }, { id: "a", question: "Q2?" }] }],
    ["too many questions", { ...ACME_REQUEST, questions: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, question: "Q?" })) }],
    ["oversized question", { ...ACME_REQUEST, questions: [{ id: "a", question: "x".repeat(301) }] }],
    ["invalid domain", { ...ACME_REQUEST, company: { name: "Acme", domain: "https://acme.example/" } }],
    ["unknown field", { ...ACME_REQUEST, objective: "find their CEO's home address" }],
  ])("rejects %s at intake", async (_label, request) => {
    const run = await runProof({ request: request as never });
    expect(failureOf(run)?.executorFailure).toEqual({ namespace: "deterministic", code: "INVALID_RESEARCH_REQUEST" });
    expect(run.provider.calls.search).toEqual([]);
  });

  it.each([
    ["an unknown question id", { queries: [{ id: "q", query: "Acme", questionIds: ["offering", "customers", "differentiation", "ceo"] }] }],
    ["an uncovered question", { queries: [{ id: "q", query: "Acme", questionIds: ["offering"] }] }],
    ["duplicate queries after normalization", { queries: [{ id: "a", query: "Acme  Products", questionIds: ["offering", "customers"] }, { id: "b", query: "acme products", questionIds: ["differentiation"] }] }],
  ])("a schema-valid plan with %s fails deterministic plan validation: 0 provider calls", async (_label, plan) => {
    const run = await runProof({ outputs: { plan } });
    expect(failureOf(run)).toMatchObject({ nodeId: "validate_plan", executorFailure: { namespace: "deterministic", code: "INVALID_RESEARCH_PLAN" } });
    expect(run.provider.calls).toEqual({ search: [], fetch: [] });
    expect(toolsStarted(run.trace)).toEqual([]);
  });

  it.each([
    ["too many queries", { queries: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, query: `Acme ${i}`, questionIds: ["offering", "customers", "differentiation"] })) }],
    ["an oversized query", { queries: [{ id: "q", query: "x".repeat(201), questionIds: ["offering", "customers", "differentiation"] }] }],
    ["a prose field", { ...ACME_PLAN, reasoning: "I think…" }],
    ["no queries", { queries: [] }],
  ])("a plan with %s is rejected by the Model Runtime schema: 0 provider calls", async (_label, plan) => {
    const run = await runProof({ outputs: { plan } });
    expect(failureOf(run)).toMatchObject({ nodeId: "plan", executorFailure: { namespace: "model", code: "MODEL_OUTPUT_SCHEMA_MISMATCH" } });
    expect(run.provider.calls).toEqual({ search: [], fetch: [] });
  });
});

describe("synthesis and grounding failures produce no report", () => {
  it("an unknown citation (src.does-not-exist) is rejected by grounding validation", async () => {
    const run = await runProof({ outputs: { draft: draftWith((draft) => { draft.answers[0]!.findings[0]!.sourceRefs = ["src.does-not-exist"]; }) } });
    expect(failureOf(run)).toEqual({ code: "NODE_EXECUTION_FAILED", nodeId: "validate_grounding", executorFailure: { namespace: "deterministic", code: "GROUNDING_UNKNOWN_SOURCE_REF" } });
    noReport(run);
  });

  it("an answered finding with no citation is rejected", async () => {
    const run = await runProof({ outputs: { draft: draftWith((draft) => { draft.answers[1]!.findings[0]!.sourceRefs = []; }) } });
    expect(failureOf(run)?.executorFailure).toEqual({ namespace: "deterministic", code: "GROUNDING_MISSING_CITATION" });
    noReport(run);
  });

  it("a malformed draft (missing field) fails at the Model Runtime: renderer never runs", async () => {
    const run = await runProof({ outputs: { draft: { answers: ACME_DRAFT.answers } } });
    expect(failureOf(run)).toMatchObject({ nodeId: "synthesize", executorFailure: { namespace: "model", code: "MODEL_OUTPUT_SCHEMA_MISMATCH" } });
    noReport(run);
  });

  it.each([
    ["url", { url: PAGES.home.url }],
    ["sourceTitle", { sourceTitle: "Forged title" }],
    ["sourceIndex", { sourceIndex: 1 }],
  ])("the model cannot add a %s to a finding: the strict schema rejects it", async (_field, extra) => {
    const run = await runProof({ outputs: { draft: draftWith((draft) => { Object.assign(draft.answers[0]!.findings[0]!, extra); }) } });
    expect(failureOf(run)?.executorFailure).toEqual({ namespace: "model", code: "MODEL_OUTPUT_SCHEMA_MISMATCH" });
    noReport(run);
  });

  it("the model cannot add a top-level source list", async () => {
    const run = await runProof({ outputs: { draft: { ...ACME_DRAFT, sources: [{ id: "S1", url: "https://evil.example/" }] } } });
    expect(failureOf(run)?.executorFailure?.code).toBe("MODEL_OUTPUT_SCHEMA_MISMATCH");
  });

  it("a URL written into a statement is rejected deterministically", async () => {
    const run = await runProof({ outputs: { draft: draftWith((draft) => { draft.answers[0]!.findings[0]!.statement = "See https://evil.example/ for details."; }) } });
    expect(failureOf(run)?.executorFailure?.code).toBe("GROUNDING_URL_IN_TEXT");
  });

  it("a missing question and an invented question are both rejected", async () => {
    expect(failureOf(await runProof({ outputs: { draft: draftWith((draft) => { draft.answers.pop(); }) } }))?.executorFailure?.code).toBe("GROUNDING_MISSING_ANSWER");
    expect(failureOf(await runProof({ outputs: { draft: draftWith((draft) => { draft.answers[2]!.questionId = "ceo_salary"; }) } }))?.executorFailure?.code).toBe("GROUNDING_UNKNOWN_QUESTION");
  });

  it("synthesis is not retried or self-repaired: one synthesis call, then failure", async () => {
    const run = await runProof({ outputs: { draft: draftWith((draft) => { draft.answers[0]!.findings[0]!.sourceRefs = ["src.does-not-exist"]; }) } });
    expect(ofType(run.trace, "model.call.started")).toHaveLength(2);
    expect(ofType(run.trace, "retry.scheduled")).toEqual([]);
  });
});

describe("evidence edge cases", () => {
  it("zero search hits: an honest all-insufficient report, with no uncited factual output", async () => {
    const run = await runProof({ provider: { emptySearch: true }, outputs: { draft: insufficientDraft() } });
    const result = resultOf(run);
    expect(run.provider.calls.fetch).toEqual([]);
    expect(result.answers.every((answer) => answer.status === "insufficient_evidence" && answer.findings.length === 0)).toBe(true);
    expect(result.sourceIndex).toEqual([]);
    expect(result.limitations.evidence).toEqual(["No usable public-web evidence was retrieved, so no question could be answered from sources."]);
    expect(result.markdown).toContain("No sources were cited.");
  });

  it("zero evidence: a model that still fabricates findings cannot produce a report", async () => {
    const run = await runProof({ provider: { emptySearch: true } });
    expect(failureOf(run)?.executorFailure?.code).toBe("GROUNDING_UNKNOWN_SOURCE_REF");
    noReport(run);
  });

  it("one question without evidence is reported as insufficient_evidence with no findings", async () => {
    const draft = draftWith((d) => { d.answers[2] = { questionId: "differentiation", status: "insufficient_evidence", findings: [], limitation: "No source compares the product with alternatives." } as never; });
    const result = resultOf(await runProof({ outputs: { draft } }));
    expect(result.answers[2]).toEqual({ questionId: "differentiation", status: "insufficient_evidence", findings: [], limitation: "No source compares the product with alternatives." });
    expect(result.coverage).toMatchObject({ questionsAnswered: 2, questionsInsufficient: 1, sourcesCited: 2 });
    expect(result.markdown).toContain("Insufficient evidence: No source compares the product with alternatives.");
  });

  it("partial search: one failing query keeps the others; limitations are surfaced", async () => {
    const run = await runProof({ provider: { failQueriesMatching: ["differentiation"] } });
    const result = resultOf(run);
    expect(run.provider.calls.search).toHaveLength(3);
    expect(result.evidence).toMatchObject({ partial: true, searchQueries: 3, searchQueriesFailed: 1, sourcesAdmitted: 4 });
    expect(result.limitations.evidence).toContain("1 of 3 search queries failed; evidence those queries would have found is missing.");
    expect(result.markdown).toContain("## Limitations");
  });

  it("partial fetch: failed pages are reported; successful pages retained; uncited-absent sources cannot be cited", async () => {
    const failed = await runProof({ provider: { failUrls: [PAGES.customers.url] } });
    expect(failureOf(failed)?.executorFailure?.code).toBe("GROUNDING_UNKNOWN_SOURCE_REF");
    const draft = draftWith((d) => { d.answers[1] = { questionId: "customers", status: "insufficient_evidence", findings: [], limitation: "The customers page could not be retrieved." } as never; });
    const run = await runProof({ provider: { failUrls: [PAGES.customers.url] }, outputs: { draft } });
    const result = resultOf(run);
    expect(result.evidence).toMatchObject({ partial: true, sourcesRequested: 4, sourcesFetched: 3, sourcesFailed: 1, sourcesAdmitted: 3 });
    expect(result.limitations.evidence).toContain("1 of 4 selected sources could not be fetched.");
    expect(result.sourcesConsulted.map((source) => source.sourceId)).not.toContain(SOURCE_IDS.customers);
  });

  it("oversized source: bounded by the per-source cap, marked truncated, and reported", async () => {
    const run = await runProof({ provider: { oversizedUrls: [PAGES.home.url], oversizedChars: 200_000 } });
    const packet = values(run.outcome)[STATE_KEYS.sourcePacket] as unknown as ResearchSourcePacket;
    const home = packet.sources.find((source) => source.sourceId === SOURCE_IDS.home)!;
    expect(home.text.length).toBe(COMPANY_RESEARCH_LIMITS.maxCharsPerSource);
    expect(home.truncated).toBe(true);
    expect(resultOf(run).evidence).toMatchObject({ partial: true, sourcesTruncated: 1 });
    expect(resultOf(run).limitations.evidence).toContain("1 source was truncated to fit the evidence budget.");
  });

  it("total evidence budget: Run state and the model request never exceed the bound", async () => {
    const run = await runProof({ provider: { oversizedUrls: Object.values(PAGES).map((page) => page.url), oversizedChars: 200_000 } });
    const state = values(run.outcome);
    const packet = state[STATE_KEYS.sourcePacket] as unknown as ResearchSourcePacket;
    const total = packet.sources.reduce((sum, source) => sum + source.text.length, 0);
    expect(total).toBeLessThanOrEqual(COMPANY_RESEARCH_LIMITS.maxTotalEvidenceChars);
    const fetched = (state[STATE_KEYS.fetchResult] as { output: { meta: { charactersReturned: number } } }).output.meta.charactersReturned;
    expect(fetched).toBeLessThanOrEqual(COMPANY_RESEARCH_LIMITS.maxTotalEvidenceChars);
    expect(run.model.requests[1]!.messages[1]!.content.length).toBeLessThan(COMPANY_RESEARCH_LIMITS.maxTotalEvidenceChars + 10_000);
  });

  it("a search outage fails the Run truthfully without a policy, and is retried by the Runtime with one", async () => {
    const without = await runProof({ provider: { searchOutage: true } });
    expect(failureOf(without)).toMatchObject({ nodeId: "search", executorFailure: { namespace: "tool", code: "TOOL_EXECUTION_FAILED" } });
    expect(without.provider.calls.search).toHaveLength(3);
    const withPolicy = await runProof({ provider: { searchOutage: true }, reliability: { search: { maxAttempts: 2 } } });
    expect(failureOf(withPolicy)?.nodeId).toBe("search");
    expect(withPolicy.provider.calls.search).toHaveLength(6);
    expect(ofType(withPolicy.trace, "retry.scheduled")).toHaveLength(1);
    expect(ofType(withPolicy.trace, "retry.exhausted")).toHaveLength(1);
  });
});

describe("governance", () => {
  it("a principal without read_only: canonical Authorization denial and 0 public-web provider calls", async () => {
    const run = await runProof({ principal: drafter });
    expect(failureOf(run)).toEqual({ code: "NODE_EXECUTION_FAILED", nodeId: "search", executorFailure: { namespace: "tool", code: "TOOL_AUTHORIZATION_DENIED", category: "AUTHORIZATION" } });
    expect(run.provider.calls).toEqual({ search: [], fetch: [] });
    expect(toolsStarted(run.trace)).toEqual([]);
    expect(ofType(run.trace, "tool.call.blocked").map((event) => (event.payload.access as { reasonCode: string }).reasonCode)).toEqual(["PERMISSION_NOT_GRANTED"]);
  });

  it("an unregistered principal has no authority at all", async () => {
    const run = await runProof({ principal: { id: "user.stranger", type: "user" } });
    expect(failureOf(run)?.executorFailure).toEqual({ namespace: "tool", code: "TOOL_AUTHORIZATION_REQUIRED", category: "AUTHORIZATION" });
    expect(run.provider.calls.search).toEqual([]);
  });
});
