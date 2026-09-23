# ADR-008: Workflow DSL and compiler

Status: accepted

## Context

Sprint 2 froze `@aao/contracts` as the canonical, framework-neutral shape of a `Workflow`, `NodeDefinition`, and `EdgeDefinition` — schema-valid, but with no graph-level semantic validation and no way to author one from a source file. Before any runtime can safely execute a workflow, AAO needs a deterministic boundary that turns untrusted, human-authored configuration into a workflow the runtime can trust: parsed, schema-validated, semantically validated, and compiled into a framework-neutral plan. No such boundary existed yet, and no production Workflow runtime, Node Registry, or LangGraph integration exists to consume one.

## Decision

- Workflow remains AAO's primary execution abstraction; this sprint adds authoring and validation in front of it, not a replacement for it.
- V1 authoring supports YAML and JSON only. Both compile into the same canonical `Workflow` representation; there is no custom workflow programming language.
- The authoring shape intentionally mirrors the canonical `Workflow` contract as closely as possible, rather than introducing DSL sugar before real workflows justify it.
- `@aao/contracts` remains the semantic source of truth for Workflow/Node/Edge shape. `@aao/workflow-dsl` (`packages/workflow-dsl`) depends on it and never redefines or duplicates its schemas.
- `@aao/workflow-dsl` owns three responsibilities in one package: parsing (YAML/JSON → raw value → canonical schema), graph-level semantic validation (the responsibility explicitly deferred by ADR-007), and compilation into a `CompiledWorkflowPlan`.
- The compiler's output (`CompiledWorkflowPlan`) is framework-neutral, JSON-safe, and deterministic — no Map/Set/class instances/functions, and compiling the same workflow twice produces equivalent output.
- Public functions return a discriminated `{ ok: true, ... } | { ok: false, diagnostics }` result for expected input problems (malformed source, schema failure, semantic graph errors) rather than throwing. Only unexpected internal errors may throw.
- Cycles are rejected in Workflow Compiler V1 (`CYCLE_NOT_SUPPORTED`). This is a compiler limitation, not a permanent prohibition on all future bounded-loop semantics — a later sprint may introduce deliberate, bounded loop support if real workflows justify it. Agent-internal reasoning loops and runtime retry/replanning are separate concerns unaffected by this decision.
- Conditional expressions on edges remain opaque, inert JSON in Sprint 3. No condition-expression language or evaluator is introduced; the compiler validates only the *structure* of branching (see below), never condition semantics.
- Routing structure is constrained but deliberately small: a node with a single outgoing edge is always a simple route; a node with multiple outgoing edges may have at most one unconditional edge, which acts as the default/fallback route. Multiple unconditional edges are `AMBIGUOUS_ROUTING`; multiple conditional edges with no unconditional fallback are `CONDITIONAL_ROUTE_WITHOUT_DEFAULT`.
- Workflow termination must be explicit: every node must route somewhere except `final_output` nodes, which must have no outgoing edges. A non-`final_output` node with zero outgoing edges is `NON_FINAL_TERMINAL_NODE`.
- Node-specific config validation (interpreting `toolRef`, `agentRef`, `modelPolicyRef`, `approvalPolicy`, or any other node `config` content) is deferred to the future Node Registry. Sprint 3 validates workflow *structure*, not executable node configuration.
- Cross-registry existence checks (whether a referenced Tool, Capability, Agent, Skill, or Policy actually exists) are deferred; there is no production registry yet, and this sprint does not build a fake one to satisfy validation.
- LangGraph is not used in `@aao/workflow-dsl`. The compiler's output is an AAO artifact that a future runtime may translate into a LangGraph graph (or any other execution substrate) behind an adapter boundary; the dependency never flows the other way.

## Consequences

- `packages/workflow-dsl` builds and typechecks independently, with its own test suite covering parsing, schema-validation delegation, every semantic invariant, compiler determinism/no-mutation/serialization, and a dependency/vendor-import boundary check, matching the verification pattern `@aao/contracts` established under ADR-007.
- `apps/control-plane` and `apps/worker` remain unconnected to workflow compilation; there is still no Node Registry or runtime to invoke it operationally, so no `POST /workflows` or `POST /runs` route is introduced.
- No workflow execution, persistence, or company deployment layer is introduced by this sprint. A compiled plan is not an executed plan — that boundary is explicit in code and in `docs/architecture/workflow-dsl.md`.
- Three example workflows (`examples/workflows/minimal.yaml`, `conditional-routing.yaml`, `governed-operational-request.yaml`) demonstrate the DSL's structural range without depending on any vendor-specific integration or company.
- Sprint 4 (Node Registry & Runtime V1) can now assume every workflow it receives as a `CompiledWorkflowPlan` is already structurally and semantically valid — schema-shape, reachability, termination, and routing-ambiguity concerns do not need to be re-litigated at the runtime boundary.
