# Company Research proof

Sprint 22 ([ADR-027](../decisions/ADR-027-company-research-proof.md)) shows that AAO Core composes into a useful, source-grounded business Workflow. The proof uses models for planning and synthesis, governed Tools for external research, Toolbox Tools for deterministic processing, and deterministic validation to block unsupported citation behavior.

Code: [`examples/company-research`](../../examples/company-research/README.md) (`@aao/example-company-research`, private). It uses only public surfaces: `@aao/framework`, `@aao/toolbox`, and `@aao/integration-public-web`.

## Architecture

```text
Request
  ↓  intake               deterministic  validate + canonicalize CompanyResearchRequest v1; build planning ModelRequest
Plan
  ↓  plan                 model          ResearchPlan (structured, strict schema, no Tools)
  ↓  validate_plan        deterministic  coverage, known ids, unique queries — invalid plan ⇒ Run fails, 0 provider calls
  ↓  prepare_search       deterministic  glue: plan → public_web.search input
Search
  ↓  search               tool           public_web.search@1.0.0 (read_only) — ≤ 8 provider calls
  ↓  prepare_dedupe       deterministic  glue: hits → records.dedupe input (keys ["url"], keep first)
Dedupe
  ↓  dedupe               tool           records.dedupe@1.0.0 (Toolbox)
  ↓  prepare_fetch        deterministic  glue: first-seen URLs → fetch input (≤ 20 URLs, char budgets)
Fetch
  ↓  fetch                tool           public_web.fetch_pages@1.0.0 (read_only) — ≤ 20 provider calls
  ↓  prepare_project      deterministic  glue: pages → records.project input
Project
  ↓  project              tool           records.project@1.0.0 (Toolbox): sourceId, url, title, text, truncated
Source Packet
  ↓  build_source_packet  deterministic  re-check identity, context admission, evidence summary, synthesis ModelRequest
Synthesis
  ↓  synthesize           model          CompanyResearchDraft (structured, strict schema, no Tools)
Grounding Validation
  ↓  validate_grounding   deterministic  citation integrity — any violation ⇒ Run fails, no report
Render
  ↓  render               deterministic  CompanyResearchResult v1 + Markdown
Result
     final                final_output
```

The graph is a straight chain. There is no branch, loop, Agent, Approval, evaluator, memory, or side effect. A successful Run makes exactly 2 model calls and 4 Tool calls.

## Contracts

| Contract | Bounds |
| --- | --- |
| `CompanyResearchRequest` v1 | company name ≤ 120 chars; optional domain (a DNS name); 1–8 questions with unique slug ids, ≤ 300 chars each; strict keys |
| `ResearchPlan` | 1–8 queries, unique slug ids, ≤ 200 chars, unique after case and whitespace normalization; only known question ids; every question covered |
| `ResearchSourcePacket` v1 | ≤ 20 sources, ≤ 12,000 chars each, ≤ 60,000 chars in total; admission counts are explicit |
| `CompanyResearchDraft` | one answer per question; ≤ 5 findings of ≤ 500 chars; 1–5 distinct `sourceRefs` per finding; `insufficient_evidence` ⇒ no findings and a limitation; ≤ 5 overall limitations; no URL in text |
| `CompanyResearchResult` v1 | company, questions, answers (with canonical `sourceRefs` and `S1…` `citations`), cited `sourceIndex`, `sourcesConsulted`, coverage, evidence summary, limitations (`evidence` from code, `synthesis` from the model), Markdown; no page bodies |

## Guarantees and non-guarantees

- **Untrusted content stays data.** System messages are constants. Retrieved text appears only inside the user message's JSON `sources` array.
- **Citation integrity.** Every cited id exists in the admitted packet, and source identity is AAO's SHA-256 over the canonical URL. **This is not entailment.** A valid citation proves that the source exists and was given to the model, not that it supports the claim.
- **Truthful evidence.** Failed queries, failed fetches, truncation, and dropped sources appear in `evidence` and in deterministic limitation sentences. With zero evidence, only an all-`insufficient_evidence` report can complete.
- **Governance.** The principal needs `read_only` for all four Tools, with no special bypass. Without it, the Tool Runtime denies the search and the provider is never called.
- **Portability.** The Workflow names only Model Policies and Tool refs. It runs unchanged under the native scripted model and the Vercel AI SDK adapter, and under two equivalent fixture providers, with deep-equal results.

## Verification

Tests: `examples/company-research/test` (Workflow, failures, grounding and rendering, security and privacy, portability, boundaries, and a 32-case Eval set over 8 existing graders), plus `packages/integration-public-web/test`. Compiled smoke: `node examples/company-research/smoke/sprint22.mjs` prints `SPRINT_22_COMPANY_RESEARCH_PROOF_SMOKE_OK`. Demo: `pnpm proof:company-research`.

## Toward a Capability Pack (Sprint 26)

Packaging this proof later would need:

- the Workflow;
- its integration requirement (a `PublicWebProvider`);
- its Toolbox refs (`records.dedupe@1.0.0`, `records.project@1.0.0`);
- its Model Policies (`company_research.planning`, `company_research.synthesis`, both needing `model.structured_output`);
- its Governance requirement (`read_only`);
- its Evals.
