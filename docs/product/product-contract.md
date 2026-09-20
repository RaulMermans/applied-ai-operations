# Product contract

## Problem

Organisations already have models, CRM and ERP systems, internal APIs, email, document stores, databases, SaaS tools, and people carrying out operational procedures. These capabilities are fragmented. Typical AI integrations do not reliably supply workflow structure, tool governance, permissions, human approval, durable state and recovery, standard integrations, evaluation, observability, or auditability.

## Product definition

**Applied AI Operations (AAO)** is a reusable runtime and control layer for configuring, executing, governing, observing, and evaluating AI-powered operational workflows inside organisations.

It closes the gap between having models and software, and allowing AI to reliably perform governed operational work. A business request flows through a workflow, model reasoning where needed, company tools and data, policy, approval where required, execution, verification, evaluation, and audit.

## Users and value

Business operators and process owners configure and inspect governed workflows. Engineering and AI teams define reusable runtime capabilities, adapters, and policy boundaries. Reviewers approve sensitive or consequential work. AAO provides a consistent operational control layer rather than a collection of disconnected AI integrations.

## Product boundaries

AAO owns reusable workflow execution, governance, observability, evaluation, and capability interfaces. Company configuration supplies the organisation-specific workflows, terminology, policies, tools, knowledge, and success measures. See [core versus company](../architecture/core-vs-company.md).

AAO is a layer, not an operating system, personal assistant, chatbot, ChatGPT clone, agent marketplace, collection of autonomous agents, generic no-code workflow builder, generic RAG product, Zapier replacement, ERP, CRM, document management system, or generic SaaS product at this stage.

## V1 proof

V1 proves the contract through three workflows:

1. **Company Research** — a bounded agentic workflow for planning, evidence gathering, synthesis, grounding evaluation, and bounded revision.
2. **Document Intelligence** — a deterministic workflow with selective model nodes for parsing, extraction, classification, structured validation, and document reasoning.
3. **Operational Request** — governed operational execution: classify, retrieve context, plan, propose action, apply policy and approval, execute externally, verify, evaluate, and audit.

## Success criteria

An eventual reliable AAO workflow must prove valid input handling; correct routing, model and tool selection; valid tool arguments; permission and approval compliance; bounded retries; state integrity; side-effect safety; trace completeness; evaluation success; and a correct artifact or result. Final output alone is never sufficient evidence.

Sprint 0 defines this standard; it does not implement these guarantees.
