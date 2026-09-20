# Applied AI Operations

Mission: build the smallest reliable architecture for governed business workflows.

- Workflow before agent; agents are optional and bounded within workflows.
- Deterministic AAO software owns validation, policy, permissions, approvals, state transitions, and side-effect authority; models may propose, never self-authorize.
- AAO owns its contracts. Framework and provider types stay behind adapters.
- Stay local-first: do not introduce deployment assumptions or infrastructure without evidence.
- The source-of-truth hierarchy is executable contracts, ADRs, `ARCHITECTURE.md`, canonical domain docs, then README summaries; reconcile conflicts explicitly.
- Keep one canonical implementation and contract per concept. Do not let company-specific requirements mutate core semantics.
- Preserve mock/live distinctions, test the smallest relevant surface, and never weaken tests or claim validation that did not occur.
- Do not claim a feature complete solely because its final text looks correct.
