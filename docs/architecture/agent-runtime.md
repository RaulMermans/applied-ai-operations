# Agent Runtime

`@aao/agent-runtime` (`packages/agent-runtime`) is AAO's bounded Agent Runtime (Sprint 7, [ADR-012](../decisions/ADR-012-bounded-agent-runtime.md)). **The model may propose continuation; AAO decides whether continuation is allowed.** A Sprint 7 Agent is a bounded reasoning component, not an autonomous worker: it has no tools, no external actions, no MCP, no delegation, no long-term memory, no durable recovery, no automatic retries, and no Reflexion.

```text
Model Node  = one model invocation
Agent Node  = bounded controller over multiple model invocations
```

## Direct path

```text
AgentExecutionRequest     schemaVersion, caller-owned agentExecutionId, agentRef {id, version}, non-blank task
        ↓
Agent Registry            version-exact lookup of a RegisteredAgent (canonical AgentSpec + instructions + limits)
        ↓
Agent binding             fail-closed support gate: no tools, no skills, modelPolicyRef required and registered,
        ↓                 read_only/write_draft only, no unsupported policy constraints
Agent Controller          for iteration = 1..maxIterations (deterministic, iterative, bounded)
        ↓
Model Runtime             executeModelRequest — exactly one call per iteration, structured output
        ↓
AgentDecision             { action: CONTINUE | COMPLETE, output } — Ajv in Model Runtime, strict Zod at the Agent boundary
        ↓
Controller
   ├── CONTINUE           budget left → carry output forward; final iteration → MAX_AGENT_ITERATIONS_EXCEEDED
   └── COMPLETE           → success
        ↓
AgentResult               finalOutput, iterationsUsed, history, usage totals (when reliably available)
```

Entry point: `executeAgent({ request, agents, policies, models })` → `{ ok: true, result } | { ok: false, failure }`. It needs no Workflow Runtime (useful for unit tests, evaluation, and benchmarks). The Agent Node calls this same function — there is one Agent execution path.

## Workflow path

```text
Workflow agent Node       config: { agentRef, taskStateKey, resultStateKey } (top-level keys only)
      ↓
Generic AAO Runtime       caller registers createAgentNodeExecutor({ agents, policies, models }) explicitly;
      ↓                   preflight runs validateConfig (config schema + full support gate), no model call
Agent Runtime             executeAgent({ agentExecutionId: deriveAgentExecutionId(runId, nodeId), agentRef, task: state[taskStateKey] })
      ↓
Model Runtime             1..maxIterations invocations, all while the Node is RUNNING
      ↓
Agent Result
      ↓
Runtime-managed patch     success: { [resultStateKey]: AgentResult } → one revision increment
                          failure: no patch; NODE_EXECUTION_FAILED + executorFailure { agent, <AgentFailureCode> }
```

Workflow-owned Agent execution ids are deterministically derived from Run + Node identity into a bounded canonical identifier: `agent.<sha256 hex>` over the unambiguous JSON array `[domain, runId, nodeId]` (70 characters regardless of how long the ≤256-character Run/Node ids are, so a workflow that passes preflight can never fail on an over-long derived id, and the `.i<n>` invocation suffix always fits). No randomness, clock, or counter. Direct `executeAgent` callers still supply their own `agentExecutionId`.

The Agent executor declares no retry safety, so the Runtime never retries an Agent Node (ADR-018): an Agent may orchestrate several model calls, and safe classification cannot yet be guaranteed. One Agent execution attempt per Agent Node per Run therefore still holds.

The Agent Node is **atomic** to the parent Runtime: `READY → RUNNING → SUCCEEDED | FAILED`. Agent iterations are not workflow steps, do not increment `RunState.revision`, never mutate workflow state, and never create a safe workflow snapshot mid-Agent. Without an explicitly registered agent executor, an agent node fails preflight with `NODE_EXECUTOR_NOT_FOUND`.

## Registered Agent and limits

| Field | Meaning |
| --- | --- |
| `spec` | Canonical `AgentSpec` from `@aao/contracts`, reused intact. |
| `instructions` | Trusted, code-registered, non-blank instructions (≤ 32,000 chars). Not workflow-authored. |
| `limits.maxIterations` | `1..16` (`MAX_AGENT_ITERATIONS_CEILING`). No unlimited mode. Also the hard ceiling on model calls. |
| `limits.maxOutputTokensPerIteration` | `1..32768`; sent as `maxOutputTokens` on every iteration's `ModelRequest`. |

Limits, instructions, and model policy come only from the registration. Nothing in a task, workflow config, or model output can change them.

## Prompt construction

Deterministic, with no template language:

- iteration 1: `system` = fixed controller protocol + `Agent instructions:` + instructions; `user` = task.
- iteration n > 1: the same two messages, then `assistant` = previous public working output, then `user` = `Iteration n of M. Refine the current output above and return the required structured decision.`

Only the latest working output is carried forward, so the conversation stays bounded. The protocol asks for public output only and explicitly not for reasoning or chain-of-thought. Per-iteration `invocationId` is `<agentExecutionId>.i<n>`.

## Failures

| Code | When | Model called? |
| --- | --- | --- |
| `INVALID_AGENT_REQUEST` | request not JSON-safe or schema-invalid (e.g. missing/blank/non-string task) | no |
| `AGENT_NOT_FOUND` | no Agent registered at that exact `id` + `version` | no |
| `UNSUPPORTED_AGENT_CONFIGURATION` | tools, skills, missing `modelPolicyRef`, unsupported permission class, or policy constraints | no |
| `AGENT_MODEL_POLICY_NOT_FOUND` | `modelPolicyRef` not registered | no |
| `AGENT_MODEL_EXECUTION_FAILED` | Model Runtime failed (`modelFailureCode` preserved, e.g. `MODEL_ROUTE_NOT_FOUND`, `MODEL_INVOCATION_FAILED`) | ≤ current iteration |
| `INVALID_AGENT_DECISION` | output violates the decision schema (incl. `MODEL_OUTPUT_SCHEMA_MISMATCH`) or has a blank output | yes |
| `MAX_AGENT_ITERATIONS_EXCEEDED` | `CONTINUE` on the final permitted iteration | exactly `maxIterations` |

A failure carries safe metadata only: `code`, a Runtime-built `message`, `agentExecutionId`, `agentRef`, `iteration`, `modelFailureCode`, `issues`, and the `history` of completed iterations — direct-caller/eval evidence that never enters workflow state. No provider message, stack, URL, or header ever appears. There is no retry, no alternate model, no restart, and no fallback.

## Agent working state vs everything else

`AgentExecutionState` (`agentExecutionId`, `agentRef`, `task`, `iteration`, `currentWorkingOutput?`, `history`) exists only for one in-memory invocation. It is not workflow `RunState`, not long-term/episodic/semantic memory, not a checkpoint, and not Trace.

## Iteration evidence

`AgentIterationRecord` = `{ iteration, action, output, invocationId, modelBindingId, usage? }`. It is execution evidence and a future trajectory/GPA runtime-evaluation input — **not** canonical Trace infrastructure and **not** memory. It keeps iteration count, decision sequence, model binding, working output, and usage where available; the termination reason is the final `COMPLETE` on success or the failure `code` + `iteration`. Nothing is scored in Sprint 7. Since Sprint 15, the Agent Node also reports this trajectory through the optional trace port as `agent.started`, `agent.iteration.completed` (iteration, `CONTINUE`/`COMPLETE`, invocation, binding, usage), `agent.completed`, and `agent.failed`. Each iteration's `model.call.*` events nest under the Agent span. The working output, task, instructions, and any reasoning are never traced. See [trace runtime](trace-runtime.md). `AgentResultSchema` re-checks that the evidence is internally consistent (iterations numbered 1..n, only the last is `COMPLETE`, `finalOutput` equals it).

## Determinism

- **Controller determinism**, guaranteed: the same binding, task, limits, and deterministic model results always produce the same model requests, iteration sequence, termination point, history, and result.
- **Model generation**, not guaranteed for real providers. Tests use scripted adapters and `ai/test` models.

## Authority

Agent output can never grant additional permissions, tools, iterations, model access, or external authority. Task text is not controller authority: a task asking to ignore the iteration limit, switch models, or enable tools has no effect, because those are deterministic configuration. Tool use arrives later only through `Agent → tool request → Tool Registry → authorization → policy → approval if required → execution`, never through AI SDK tool calls (which Model Runtime V1 already refuses).

## Agent permissions and Tools (direction only)

Sprint 8 added a Tool Runtime ([tool runtime](tool-runtime.md)), but Agents still cannot request Tools: `AgentDecision` stays `CONTINUE | COMPLETE`, and Agents with `toolRefs` remain unsupported. Sprint 9 fixed the authorization semantics Agent Tool use will inherit ([authorization](authorization.md)): `AgentSpec.permissionClasses`, taken from the registered spec via `agentAuthorityFromSpec`, is a ceiling on the initiating principal's grants (`required ⊆ grants ∩ ceiling`). It can reduce authority, never extend it, and it is enforced inside `executeTool`. Agent Tool use itself is still not implemented; it arrives later, only through `executeTool`.

## Explicit non-goals (Sprint 7)

Tools, Skills Runtime, MCP, side effects, delegation or multi-agent patterns, dynamic workflow modification, long-term memory, persistence/checkpointing/resume, mid-Agent snapshots, Reflexion/evaluator loops, retries, fallback, and model escalation.
