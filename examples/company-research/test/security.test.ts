import { vi, describe, expect, it } from "vitest";
import type { PublicWebProvider } from "@aao/integration-public-web";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import { ACME_DRAFT, ACME_REQUEST, INJECTION_TEXT, PAGES, SECRET, SOURCE_IDS, createFixtureProvider, fixedClock, fixtureBinding, fixtureGovernance, nativeModelAdapter, researcher, scriptedResearchModel } from "../fixtures/index.js";
import { PLANNING_INSTRUCTIONS, STATE_KEYS, SYNTHESIS_INSTRUCTIONS, companyResearchWorkflow, createCompanyResearchProof } from "../src/index.js";
import { ofType, runProof, toolsStarted, values } from "./support.js";

// Each test runs complete proof Workflows; keep them reliable on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

describe("untrusted source boundary: retrieved content is evidence, never instruction", () => {
  it("the prompt-injection source stays inside the user message's JSON sources array", async () => {
    const run = await runProof();
    const synthesis = run.model.requests[1]!;
    expect(synthesis.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(synthesis.messages[0]!.content).toBe(SYNTHESIS_INSTRUCTIONS);
    expect(synthesis.messages[0]!.content).not.toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    const data = JSON.parse(synthesis.messages[1]!.content) as { kind: string; sources: { sourceId: string; text: string; title: string }[] };
    expect(data.kind).toBe("company_research.synthesis_input");
    const injected = data.sources.find((source) => source.sourceId === SOURCE_IDS.review)!;
    expect(injected.text).toContain(INJECTION_TEXT);
    // The only place injected text appears in the whole request is that data field.
    const serialized = JSON.stringify(synthesis);
    expect(serialized.split("IGNORE ALL PREVIOUS INSTRUCTIONS").length - 1).toBe(1);
  });

  it("the planning request carries no retrieved content and fixed system instructions", async () => {
    const run = await runProof();
    expect(run.model.requests[0]!.messages[0]!.content).toBe(PLANNING_INSTRUCTIONS);
    expect(JSON.stringify(run.model.requests[0])).not.toContain(PAGES.home.text);
  });

  it("injected text grants no Tool access, changes no principal, and alters no Workflow configuration", async () => {
    const run = await runProof();
    expect(toolsStarted(run.trace)).toEqual(["public_web.search", "records.dedupe", "public_web.fetch_pages", "records.project"]);
    for (const event of ofType(run.trace, "tool.call.started")) {
      expect(event.payload.permissionClasses).toEqual(["read_only"]);
      expect((event.payload.access as { principalId: string }).principalId).toBe("user.researcher");
    }
    expect(JSON.stringify(companyResearchWorkflow)).not.toMatch(/IGNORE|destructive|admin/);
    expect(run.model.requests.every((request) => !("tools" in request))).toBe(true);
  });

  it("a model that obeys the injection still cannot bypass the schema or the citation rules", async () => {
    const obeying = { ...ACME_DRAFT, apiKey: "sk-live", toolCalls: [{ name: "delete_all_records" }] };
    const run = await runProof({ outputs: { draft: obeying } });
    expect(run.outcome.status === "failed" && run.outcome.failure.executorFailure?.code).toBe("MODEL_OUTPUT_SCHEMA_MISMATCH");
    expect(toolsStarted(run.trace)).not.toContain("delete_all_records");
  });

  it("no credential exists to reveal: neither model request contains a key, token, or provider name", async () => {
    const run = await runProof();
    // "API key" appears only as quoted evidence text; no credential value or credential field exists anywhere.
    expect(JSON.stringify(run.model.requests)).not.toMatch(/sk-[A-Za-z0-9]|Bearer |SECRET_DO_NOT_PERSIST|"(apiKey|credentials|authorization)"/);
    for (const request of run.model.requests) expect(request.messages[0]!.content).not.toMatch(/key|token|credential/i);
  });

  it("the malicious review title is escaped in the result's Markdown (consulted, not executed)", async () => {
    const run = await runProof({ outputs: { draft: { ...ACME_DRAFT, answers: ACME_DRAFT.answers.map((answer, index) => (index === 0 ? { ...answer, findings: [{ statement: "Reviewers describe setup as quick.", sourceRefs: [SOURCE_IDS.review] }] } : answer)) } } });
    expect(run.outcome.status).toBe("completed");
    const markdown = run.outcome.status === "completed" ? run.outcome.result.markdown : "";
    expect(markdown).not.toMatch(/\]\(javascript:|<script>/);
    expect(markdown).toContain("\\[click here\\]\\(javascript:alert\\(1\\)\\) &lt;script&gt;alert\\(1\\)&lt;/script&gt;");
  });
});

describe("provider metadata cannot grant authority or alter identity", () => {
  it("variant-b provider claims (permissions, retry safety, provider ids, redirect URLs) never reach state", async () => {
    const run = await runProof({ provider: { variant: "b" } });
    expect(run.outcome.status).toBe("completed");
    const state = JSON.stringify(values(run.outcome));
    expect(state).not.toMatch(/providerId|"score"|retrySafety|destructive"|evil\.example|src\.provider-chosen|providerRequestId|"approved"/);
    for (const event of ofType(run.trace, "tool.call.started")) expect(event.payload.permissionClasses).toEqual(["read_only"]);
  });
});

describe("privacy: seeded secrets never reach observability or Eval output", () => {
  it("a secret in provider failures is never in state, Trace, or the result", async () => {
    const run = await runProof({ provider: { failQueriesMatching: ["differentiation"], failUrls: [PAGES.review.url] } });
    expect(run.outcome.status).toBe("completed");
    expect(JSON.stringify(run.outcome)).not.toContain(SECRET);
    expect(JSON.stringify(run.trace)).not.toContain(SECRET);
  });

  it("a secret in source text: in state for synthesis, absent from Trace, result, and Markdown", async () => {
    const provider = createFixtureProvider();
    const seeded: PublicWebProvider = {
      search: (request, context) => provider.search(request, context),
      fetch: async (request, context) => {
        const response = await provider.fetch(request, context);
        return response.status === "succeeded" && request.url === PAGES.home.url ? { ...response, text: `${response.text} ${SECRET}` } : response;
      },
    };
    const store = createInMemoryTraceStore();
    const model = scriptedResearchModel();
    const proof = createCompanyResearchProof({ modelAdapters: [nativeModelAdapter(model)], modelBindings: [fixtureBinding()], researchProvider: seeded, governance: fixtureGovernance, principalForRun: () => researcher, trace: createTraceRecorder({ store, clock: fixedClock() }), clock: fixedClock() });
    const outcome = await proof.run({ runId: "run.secret", request: ACME_REQUEST });
    expect(outcome.status).toBe("completed");
    expect(JSON.stringify(outcome.execution.execution!.state.values[STATE_KEYS.sourcePacket])).toContain(SECRET);
    expect(model.requests[1]!.messages[1]!.content).toContain(SECRET);
    expect(JSON.stringify(await store.getRunTrace("run.secret"))).not.toContain(SECRET);
    expect(outcome.status === "completed" && JSON.stringify(outcome.result)).not.toContain(SECRET);
  });

  it("a secret in malformed model output never reaches state, Trace, or the failure", async () => {
    const run = await runProof({ outputs: { draft: { leaked: SECRET } } });
    expect(run.outcome.status).toBe("failed");
    expect(JSON.stringify(values(run.outcome))).not.toContain(SECRET);
    expect(JSON.stringify(run.outcome.status === "failed" ? run.outcome.failure : {})).not.toContain(SECRET);
    expect(JSON.stringify(run.trace)).not.toContain(SECRET);
  });
});
