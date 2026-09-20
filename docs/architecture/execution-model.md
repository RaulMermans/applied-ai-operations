# Execution model

## Workflow-first execution

AAO's target path is: event or request → deterministic intake → workflow selection → AAO workflow specification → validation and compilation → runtime execution → governance and authorization → human approval where required → external execution → verification → evaluation → trace, audit, and artifacts.

Nodes may be deterministic, model, bounded agent, tool, approval, or evaluator nodes. Workflows set the execution boundary; agents remain optional and bounded inside them.

## Responsibility split

Deterministic software owns schema and graph validation, stable routing, permissions, authorization, side-effect gates, approval requirements, state transitions, retry ceilings, budget enforcement, timeouts, idempotency rules, policy and security constraints, final external action authority, and deterministic evaluation rules.

Models may interpret, semantically classify, plan, decompose, synthesize, research, summarize, critique, make uncertain judgments, and reason through exceptions. A model may propose an action; it cannot grant itself permission to perform it.

## Architecture patterns

| Pattern | Use | Constraint |
| --- | --- | --- |
| Routing | Workflow selection, deterministic conditions, capability selection | Reduces inappropriate workflow, tool, and model use. |
| Durable Workflow | Interruptions, approvals, important side effects | Requires recovery boundaries and avoids lost progress or replay errors. |
| Human-in-the-Loop | External or destructive actions and uncertain high-risk decisions | Keeps authorization accountable. |
| Evaluator-Optimizer | Explicit criteria where another attempt can improve output | Use selectively. |
| Bounded Agent Loop | Genuine open-ended work such as research | Bounded by workflow controls. |
| Parallelization | Safely independent work | Never default concurrency. |
| Reflexion | Meaningful evaluator feedback and justified retry cost | At most two revision iterations unless a workflow proves another limit. |
| Multi-Agent | Measurable benefit from decomposition, isolation, or parallel exploration | Not a default architecture. |

## Intended tool shape

No production tool contract is implemented in Sprint 0. A future canonical AAO tool is expected to describe an id, namespace, version, description, input and output schemas, permission class, risk level, allowed actors or agents, approval requirement, timeout and retry policies, idempotency metadata, redaction policy, and provider binding. It will serve AI and workflow use rather than mirror a vendor REST endpoint.
