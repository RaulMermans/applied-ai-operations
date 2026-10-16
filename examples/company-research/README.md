# Company Research proof (`@aao/example-company-research`)

An end-to-end AAO proof application. Given a company and up to 8 research questions, it:

1. plans bounded web searches with one model call;
2. searches and fetches public-web pages through governed `read_only` Integration Fabric Tools;
3. deduplicates and projects the evidence with Toolbox Tools;
4. synthesizes a structured draft with a second model call;
5. checks every citation with deterministic code;
6. renders a Markdown report with code, not the model.

It is a Workflow plus Tools, not an autonomous research Agent. See [the proof architecture](../../docs/proofs/company-research.md) and [ADR-027](../../docs/decisions/ADR-027-company-research-proof.md).

## Run the fixture demo

```sh
pnpm proof:company-research
```

The demo is deterministic. It uses a fictional company (Acme Analytics), a fixture public-web provider, and a scripted model. It needs no credentials and makes no network access.

## Use it with your own model and provider

```ts
import { createCompanyResearchProof } from "@aao/example-company-research";

const research = createCompanyResearchProof({
  modelAdapters: [myModelAdapter],    // defineModelAdapter(...) or e.g. defineVercelAiModelAdapter({ model })
  modelBindings: [{ id: "research-model", priority: 10, capabilities: ["model.text_generation", "model.structured_output"], adapterRef: { id: "…", version: "1.0.0" } }],
  researchProvider: myPublicWebProvider, // implements PublicWebProvider from @aao/integration-public-web
  governance,                          // the principal needs read_only
  principalForRun: ({ runId }) => sessionPrincipal(runId),
});

const outcome = await research.run({
  runId: "research-001",
  request: {
    company: { name: "Acme Analytics", domain: "acme.example" },
    questions: [{ id: "offering", question: "What does Acme Analytics sell?" }],
  },
});
if (outcome.status === "completed") console.log(outcome.result.markdown);
```

- **Model adapter.** Any `ModelAdapter` with structured output. The Workflow names only the Model Policies `company_research.planning` and `company_research.synthesis`, never a vendor.
- **Public-web provider.** Host code: a search API client, a crawler, or anything else that implements `search` and `fetch`. Your provider owns the network access, safe resolution (SSRF protection, redirects), and its own credentials. No live provider ships with AAO.

## Limitations

- Citations are checked for integrity (each one exists and points to admitted evidence), **not** for semantic support of the claim.
- The DSL has no conditional routing. With zero evidence the synthesis call still happens, and validation then allows only `insufficient_evidence` answers.
- The planner's queries are checked for shape and coverage, not relevance.
- There is no persistence, memory, Artifact store, Approval, or side effect. The result is a structured final output.
- `fixtures/` and `demo/` are test support, never part of the proof's runtime API (`src/`).
