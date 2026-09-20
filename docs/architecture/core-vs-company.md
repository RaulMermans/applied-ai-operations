# Core versus company

## AAO Core

AAO Core owns the Workflow DSL, workflow compiler, runtime, node registry, run lifecycle, state and checkpoint contracts, model abstraction, agent runtime contract, tool registry, MCP connector abstraction, governance, permissions, approvals, observability, audit, evaluation runtime, company configuration loader, and canonical capability interfaces.

## Company Layer

The Company Layer owns terminology, workflow instances, agents, prompts, policies, tool bindings, integration bindings, knowledge sources, model policies, evaluation scenarios, KPIs, branding, and company-specific rules.

## Portability invariant

Normal onboarding of another company must not require a fork of AAO Core. Adding a provider adapter or genuinely new capability when necessary is distinct from changing the runtime for one company.

The Company Layer configures what AAO does for an organisation; it must not silently change AAO semantics. Common operational capability contracts belong in Core, while provider-specific behavior belongs behind adapters. See [the integration model](integration-model.md).
