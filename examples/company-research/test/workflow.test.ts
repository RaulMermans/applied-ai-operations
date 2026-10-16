import { vi, describe, expect, it } from "vitest";
import { ACME_REQUEST, PAGES, SOURCE_IDS, createFixtureProof } from "../fixtures/index.js";
import { COMPANY_RESEARCH_NODE_ORDER, STATE_KEYS, companyResearchWorkflow, validateCompanyResearchDraft, type CompanyResearchResult, type ResearchSourcePacket } from "../src/index.js";
import { nodesCompleted, ofType, runProof, toolsStarted, values } from "./support.js";

// Each test runs complete proof Workflows; keep them reliable on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const resultOf = (outcome: Awaited<ReturnType<typeof runProof>>["outcome"]): CompanyResearchResult => {
  if (outcome.status !== "completed") throw new Error(`expected completion, got ${JSON.stringify(outcome.failure)}`);
  return outcome.result;
};

describe("Company Research Workflow: happy path", () => {
  it("is a straight chain of the documented nodes: no branch, loop, Agent, Approval, or evaluator", () => {
    expect(companyResearchWorkflow.nodes.map((node) => node.id)).toEqual([...COMPANY_RESEARCH_NODE_ORDER]);
    expect(companyResearchWorkflow.edges).toEqual(COMPANY_RESEARCH_NODE_ORDER.slice(1).map((target, index) => ({ sourceNodeId: COMPANY_RESEARCH_NODE_ORDER[index], targetNodeId: target })));
    expect(new Set(companyResearchWorkflow.nodes.map((node) => node.kind))).toEqual(new Set(["deterministic", "model", "tool", "final_output"]));
    expect(companyResearchWorkflow.nodes.filter((node) => node.kind === "model").map((node) => node.id)).toEqual(["plan", "synthesize"]);
  });

  it("completes: every node in order, a valid Trace, and a CompanyResearchResult v1", async () => {
    const run = await runProof();
    expect(run.outcome.status).toBe("completed");
    expect(run.traceValid).toBe(true);
    expect(nodesCompleted(run.trace)).toEqual([...COMPANY_RESEARCH_NODE_ORDER]);
    const result = resultOf(run.outcome);
    expect(result.schemaVersion).toBe(1);
    expect(result.answers.map((answer) => [answer.questionId, answer.status])).toEqual([["offering", "answered"], ["customers", "answered"], ["differentiation", "answered"]]);
  });

  it("exactly two model calls (plan, synthesis) and no Tools offered to either", async () => {
    const run = await runProof();
    expect(ofType(run.trace, "model.call.started")).toHaveLength(2);
    expect(run.model.requests.map((request) => request.output.kind === "structured" && request.output.name)).toEqual(["research_plan", "company_research_draft"]);
    for (const request of run.model.requests) expect(Object.keys(request).sort()).toEqual(["maxOutputTokens", "messages", "output"]);
  });

  it("Tools run through the Tool Runtime in order: search once, dedupe, fetch once, project; nothing else", async () => {
    const run = await runProof();
    expect(toolsStarted(run.trace)).toEqual(["public_web.search", "records.dedupe", "public_web.fetch_pages", "records.project"]);
    expect(ofType(run.trace, "tool.call.blocked")).toEqual([]);
    for (const event of ofType(run.trace, "tool.call.started")) expect(event.payload.permissionClasses).toEqual(["read_only"]);
  });

  it("provider budget: one search call per planned query, one fetch per deduplicated URL", async () => {
    const run = await runProof();
    expect(run.provider.calls.search).toEqual(["Acme Analytics products", "Acme Analytics target customers", "Acme Analytics differentiation"]);
    expect(run.provider.calls.fetch).toEqual([PAGES.home.url, PAGES.launch.url, PAGES.review.url, PAGES.customers.url]);
  });

  it("duplicate URLs across queries (and a fragment variant) are removed by records.dedupe and fetched once", async () => {
    const run = await runProof();
    const state = values(run.outcome);
    const search = (state[STATE_KEYS.searchResult] as { output: { data: { hits: { url: string }[] } } }).output.data.hits;
    expect(search.map((hit) => hit.url).filter((url) => url === PAGES.home.url)).toHaveLength(3);
    expect((state[STATE_KEYS.dedupeResult] as { output: { meta: { duplicatesRemoved: number } } }).output.meta.duplicatesRemoved).toBe(4);
    expect(run.provider.calls.fetch.filter((url) => url === PAGES.home.url)).toHaveLength(1);
    expect(new Set(run.provider.calls.fetch).size).toBe(run.provider.calls.fetch.length);
  });

  it("first-seen ranking order survives dedupe, fetch, projection, and the source packet", async () => {
    const run = await runProof();
    const state = values(run.outcome);
    const order = [SOURCE_IDS.home, SOURCE_IDS.launch, SOURCE_IDS.review, SOURCE_IDS.customers];
    expect((state[STATE_KEYS.dedupeResult] as { output: { data: { records: { sourceId: string }[] } } }).output.data.records.map((record) => record.sourceId)).toEqual(order);
    expect((state[STATE_KEYS.sourcePacket] as unknown as ResearchSourcePacket).sources.map((source) => source.sourceId)).toEqual(order);
  });

  it("no page outside the deduplicated search results is fetched", async () => {
    const run = await runProof();
    const state = values(run.outcome);
    const deduped = new Set((state[STATE_KEYS.dedupeResult] as { output: { data: { records: { url: string }[] } } }).output.data.records.map((record) => record.url));
    for (const url of run.provider.calls.fetch) expect(deduped.has(url)).toBe(true);
  });

  it("records.project reduces each source record to exactly the five downstream fields", async () => {
    const run = await runProof();
    const projected = (values(run.outcome)[STATE_KEYS.projectResult] as { output: { data: { records: Record<string, unknown>[] } } }).output.data.records;
    for (const record of projected) expect(Object.keys(record)).toEqual(["sourceId", "url", "title", "text", "truncated"]);
  });

  it("citations: labels S1…Sn follow source-packet order over cited sources only; consulted and cited are distinct", async () => {
    const result = resultOf((await runProof()).outcome);
    expect(result.sourceIndex).toEqual([
      { label: "S1", sourceId: SOURCE_IDS.home, title: PAGES.home.title, url: PAGES.home.url },
      { label: "S2", sourceId: SOURCE_IDS.launch, title: PAGES.launch.title, url: PAGES.launch.url },
      { label: "S3", sourceId: SOURCE_IDS.customers, title: PAGES.customers.title, url: PAGES.customers.url },
    ]);
    expect(result.sourcesConsulted.map((source) => source.sourceId)).toEqual([SOURCE_IDS.home, SOURCE_IDS.launch, SOURCE_IDS.review, SOURCE_IDS.customers]);
    expect(result.coverage).toEqual({ questionsTotal: 3, questionsAnswered: 3, questionsInsufficient: 0, sourcesConsulted: 4, sourcesCited: 3 });
    expect(result.answers.flatMap((answer) => answer.findings.map((finding) => finding.citations))).toEqual([["S1"], ["S1"], ["S3"], ["S2"]]);
  });

  it("the final result carries no page bodies, and evidence metadata is complete", async () => {
    const result = resultOf((await runProof()).outcome);
    expect(JSON.stringify(result)).not.toContain(PAGES.customers.text);
    expect(result.evidence).toEqual({ partial: false, searchQueries: 3, searchQueriesFailed: 0, searchHits: 8, candidateSources: 4, candidatesNotFetched: 0, sourcesRequested: 4, sourcesFetched: 4, sourcesFailed: 0, sourcesTruncated: 0, sourcesDropped: 0, sourcesAdmitted: 4 });
    expect(result.limitations).toEqual({ evidence: [], synthesis: ["Pricing levels were not found in the retrieved sources."] });
  });

  it("Run state holds only proof data under the documented keys; no memory, Approval, or Artifact keys", async () => {
    const state = values((await runProof()).outcome);
    expect(Object.keys(state).sort()).toEqual(Object.values(STATE_KEYS).sort());
  });
});

describe("determinism", () => {
  it("two Runs with the same request yield deep-equal results and byte-identical Markdown", async () => {
    const [a, b] = [await runProof(), await runProof()];
    expect(resultOf(a.outcome)).toEqual(resultOf(b.outcome));
    expect(resultOf(a.outcome).markdown).toBe(resultOf(b.outcome).markdown);
    expect(values(a.outcome)).toEqual(values(b.outcome));
  });

  it("the same request, packet, and draft produce deep-equal validation output", async () => {
    const state = values((await runProof()).outcome);
    const input = { request: state[STATE_KEYS.researchRequest], sourcePacket: state[STATE_KEYS.sourcePacket], draft: (state[STATE_KEYS.synthesisResult] as { output: unknown }).output } as unknown as Parameters<typeof validateCompanyResearchDraft>[0];
    expect(validateCompanyResearchDraft(input)).toEqual(validateCompanyResearchDraft(JSON.parse(JSON.stringify(input))));
  });

  it("the prepared plan fingerprint is stable across instances", () => {
    expect(createFixtureProof().proof.planFingerprint).toBe(createFixtureProof().proof.planFingerprint);
  });

  it("the request is canonicalized deterministically (trim, collapse, lowercase domain)", async () => {
    const run = await runProof({ request: { company: { name: "  Acme   Analytics ", domain: " ACME.Example " }, questions: ACME_REQUEST.questions.map((question) => ({ ...question, question: `  ${question.question}\n` })) } });
    expect(resultOf(run.outcome).company).toEqual({ name: "Acme Analytics", domain: "acme.example" });
    expect(resultOf(run.outcome).questions).toEqual(ACME_REQUEST.questions);
  });
});
