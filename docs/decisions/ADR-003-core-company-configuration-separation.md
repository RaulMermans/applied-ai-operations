# ADR-003: Core and company configuration separation

Status: accepted

## Context

AAO must support different organisations without turning each deployment into a fork of its runtime.

## Decision

AAO Core owns reusable runtime, governance, observability, evaluation, and capability interfaces. The Company Layer owns terminology, workflow instances, agents, prompts, policies, tool and integration bindings, knowledge sources, model policies, evaluation scenarios, KPIs, branding, and company-specific rules.

Normal onboarding of another company must not require forking AAO Core. A new provider adapter or genuinely new capability may be added when needed; changing core specifically for one company is not normal onboarding.

## Consequences

Company-specific requirements must remain configuration or adapters unless they prove a reusable product capability. Canonical interfaces protect workflows from provider-specific schemas.
