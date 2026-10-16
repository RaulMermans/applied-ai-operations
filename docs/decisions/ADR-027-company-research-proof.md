# ADR-027: Company Research Proof and the first Integration Fabric capability

Status: accepted (Sprint 22)

## Context

Sprints 0–21 built AAO Core: contracts, the compiler and Runtime, the Model and Tool Runtimes, Governance, Authorization, reliability, Trace, Evaluation, the Framework surface, the adapter contract, and the Toolbox. Sprint 22 has to show that these compose into a useful application without adding another architecture layer.

The proof application is company research. Given a company and a bounded set of questions, AAO plans the research, collects public-web evidence, processes it, synthesizes a structured report, and checks every citation.

## Decision

### Workflow plus Tools, not an autonomous research Agent

The research stages are known ahead of time: plan, search, deduplicate, fetch, project, synthesize, validate, render. Tool access must stay governed, collection must stay bounded, and the output has a strict schema whose citations can be checked by code. An open-ended Agent loop would add cost and nondeterminism and buy nothing. So Company Research is one linear Workflow (`company_research.proof@1.0.0`) of 16 nodes: 2 `model`, 4 `tool`, 9 `deterministic`, and 1 `final_output`.

- **Two bounded model calls.** One plans and one synthesizes. Neither model has Tools, and Model Runtime V1 fails closed on a tool-call response. There is no critic, reflection, self-repair, or retry of the models.
- **Deterministic code owns everything else.** Intake, plan validation, glue, the source packet, grounding validation, and rendering are trusted deterministic executors.

### Public-web access is Integration Fabric, not Toolbox

`@aao/integration-public-web` is the first, deliberately narrow Integration Fabric capability:

- Toolbox = provider-neutral reusable computation (no external access).
- Integration Fabric = access to external systems, exposed as normal governed AAO Tools.
- Capability Pack = a reusable business operation (Sprint 26).
- Company Research = an example application that consumes both.

The package defines two normal Tools, `public_web.search@1.0.0` and `public_web.fetch_pages@1.0.0`, with `defineTool` around a host-injected `PublicWebProvider` port (`search(request, context)`, `fetch(request, context)`). That port is a narrow domain port. It is not an `AdapterManifest`, and no adapter kind is added. The package depends only on `@aao/framework`. It names no search vendor or SDK and performs no network access itself.

- Both Tools are `read_only` and declared retry-safe, under the existing Tool Runtime rule that `safe` is allowed only for `read_only`. No Approval is needed, and there is no side effect.
- Every call goes through the canonical Tool Registry, support gate, Authorization, schema validation, Trace, and Runtime reliability. The integration implements none of these, and it has no retry loop. When every provider call fails, it returns the retryable handler code `PUBLIC_WEB_PROVIDER_UNAVAILABLE`, and Runtime policy decides.
- AAO owns bounds, schemas, normalization, failure codes, and source identity. `sourceId` is `src.` plus 16 hex characters of SHA-256 over the canonical URL. Provider data is untrusted. Only `url`, `title`, `snippet`, and `text` are read, so provider metadata cannot grant permission, name a principal, change retry behavior, approve anything, or redirect a source's identity.
- The provider receives the Tool Runtime's own `AbortSignal`, and there is no second cancellation path. Concrete providers own safe network resolution (SSRF protection, redirects, robots rules, credentials).
- Mandatory CI uses deterministic fixture providers: no network, API keys, or credentials. No commercial provider ships in Sprint 22, and none is faked.

### Explicit deterministic glue, no mapping language

Data moves between Tools as Tool output → an explicit deterministic executor → the next Tool's input. There is no template, JSONPath, JSONata, JMESPath, expression, or generic mapper. Common mapping primitives may be considered after several proof Workflows provide evidence.

Toolbox Tools (`records.dedupe`, `records.project`) are selected by exact ref and run as normal Tools, never by calling a handler directly.

### Untrusted content and model boundaries

Retrieved public-web content is untrusted evidence, never instruction. The synthesis request's system message is a constant written by trusted code. All evidence goes into the user message as one JSON document (`company_research.synthesis_input`), never into a system message, Tool metadata, or Workflow configuration. The prompt-injection fixture proves that the injected text stays in that data field, grants no Tool access, changes no principal, and cannot bypass the output schema.

### Citations: integrity, not entailment

- The model writes only statements and `sourceRefs`. It never creates a URL, a source title, or a source index. The strict output schema (`additionalProperties: false` everywhere) rejects such fields, and the deterministic validator rejects URLs inside model text.
- `validateCompanyResearchDraft` checks that every requested question is answered exactly once, that `answered` findings cite 1–5 distinct source ids that exist in the admitted source packet, that `insufficient_evidence` answers carry no findings and do carry a limitation, and that all bounds hold. A failure stops the Run before rendering.
- This is reference integrity: the citation exists and points to admitted evidence. It does not prove that the source semantically supports the claim. Semantic support needs a model judge, human review, or a specialized grounding Eval, and AAO makes no such claim.
- The source index and the `S1…Sn` labels are built by code from the source packet, in first-seen ranking order over cited sources. The Markdown is rendered by code with escaping, and is byte-identical for the same result.

### Evidence bounds and truthfulness

- At most 8 queries (8 search calls), 3 hits per query, 20 selected sources (20 fetch calls), 12,000 characters per source, and 60,000 characters in total. These bounds apply both to Run state and to the model request.
- Context admission is deterministic: source order, then the source limit, then the per-source cap, then the total cap. Truncation, dropped sources, failed queries, and failed fetches surface in `CompanyResearchResult.evidence` and as deterministic limitation sentences.
- The DSL has no conditional routing, so zero evidence still reaches the synthesis call. The validator then makes any cited answer impossible: the only report that can complete is one where every answer is `insufficient_evidence`.

### Out of scope, recorded

There is no Artifact store, no memory writes, no Approval, no side effect, and no Audit wiring (a read-only proof needs Trace and Eval evidence only; Audit wiring in `createAAO` remains debt). There is also no Capability Pack, document intelligence, browser, crawler, RAG, or generic research framework. No new Eval engine or grader exists: 32 cases use the 8 existing deterministic graders.

The proof lives in `examples/company-research` (`@aao/example-company-research`, private). It imports only `@aao/framework`, `@aao/toolbox`, and `@aao/integration-public-web`, and no Core package may depend on it.

## Consequences

- AAO now has an end-to-end proof that composes model planning, governed external Tools, Toolbox utilities, structured synthesis, deterministic citation validation, and the existing Trace and Evaluation infrastructure.
- The same Workflow runs unchanged under a native scripted model and the Vercel AI SDK adapter, and under two equivalent fixture providers, with deep-equal results.
- A future Capability Pack would package the Workflow, its integration requirements (a `PublicWebProvider`), its Toolbox refs, its two Model Policies (`model.structured_output`), its Governance requirement (`read_only`), and its Evals.
- Known limitations: every model call is a synthesis attempt even with zero evidence (no conditional routing); grounding is not entailment; no live provider ships; and the planner's queries are checked for shape and coverage, not relevance.
