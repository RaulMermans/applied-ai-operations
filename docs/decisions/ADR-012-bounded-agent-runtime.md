# ADR-012: Bounded Agent Runtime

Status: accepted

## Context

Sprint 6 (ADR-011) gave AAO a provider-neutral Model Runtime and a `model` node that performs exactly one model invocation. The canonical `AgentSpec` (ADR-007) has existed since Sprint 2 as a bounded spec with no execution semantics, and an `agent` node could only fail preflight with `NODE_EXECUTOR_NOT_FOUND`. AAO needs its first real Agent: a component that reasons across several model invocations while AAO — not the model — controls continuation, limits, state, failures, and termination. Sprint 6 also surfaced a gap: the generic Runtime reduced every executor failure to `NODE_EXECUTION_FAILED` and lost machine-readable causality (e.g. `MODEL_ROUTE_NOT_FOUND`).

## Decision

### Agent Runtime as a distinct Core subsystem

- The Agent Runtime is a new package, `@aao/agent-runtime`, a distinct AAO Core subsystem. The Agent is subordinate to Workflow. `@aao/runtime` keeps knowing only `NodeExecutor` — never `AgentSpec`, `ModelRequest`, iteration loops, or prompts.
- Production dependencies: `@aao/contracts`, `@aao/runtime`, `@aao/model-runtime`, `zod`. The Agent Runtime reaches models **only** through `executeModelRequest` from the Model Runtime entry point. It never imports `ai`, the `@aao/model-runtime/vercel-ai` adapter, a provider SDK, LangGraph, MCP, Fastify, substrate packages, or apps (enforced by a dependency-boundary test; `ai` is a test-only dev dependency for `ai/test` models).

### Definition vs binding

- Canonical `AgentSpec` is reused intact, not duplicated or modified. A runtime-owned `RegisteredAgent` binding adds what `AgentSpec` intentionally lacks: trusted, code-registered `instructions` and explicit `limits` (`maxIterations`, `maxOutputTokensPerIteration`).
- An explicit, isolated `AgentRegistry` (no global singleton, no filesystem discovery, no dynamic import) keys Agents by canonical identity `id` + entity `version`. Lookup is version-exact (no "latest"); duplicates are rejected; bindings are validated and defensively cloned.

### Fail-closed support gate

Before any model call — in Agent Node preflight and in `executeAgent` alike (one shared `resolveExecutableAgent`) — an Agent is rejected as `UNSUPPORTED_AGENT_CONFIGURATION` if it has non-empty `toolRefs` (no Tool Registry/authorization path exists), non-empty `skillRefs` (no Skill Runtime exists), no `modelPolicyRef`, a permission class other than `read_only`/`write_draft` (`external_side_effect`, `destructive`, and `sensitive_data` need governance, approval, and data-handling controls that do not exist), or a model policy with constraints Model Runtime V1 cannot enforce. An unregistered policy is `AGENT_MODEL_POLICY_NOT_FOUND`. Permission metadata never grants authority.

### Bounded, deterministic controller

- Every Agent has `1 ≤ maxIterations ≤ 16` (the V1 hard ceiling) and `1 ≤ maxOutputTokensPerIteration ≤ 32768`. There is no unlimited mode: no `0`, `Infinity`, or sentinel meaning unbounded.
- One iteration is at most one Model Runtime invocation, so model calls can never exceed `maxIterations`. No retry is hidden inside the Agent Runtime (the AI SDK adapter already sets `maxRetries: 0`).
- Each iteration requests a structured `AgentDecision` — `{ action: "CONTINUE" | "COMPLETE", output: string }` — via Model Runtime structured output (Ajv-validated there), then re-validated at the Agent boundary with a strict Zod schema. Unknown fields (e.g. `maxIterations`, `modelPolicyRef`, `toolRefs`) are rejected, never interpreted. No hidden chain-of-thought, private reasoning, or rationale is requested; the evidence is explicit decisions and public working outputs.
- The controller, not the model, owns continuation. `COMPLETE` succeeds. `CONTINUE` advances only if budget remains; `CONTINUE` on the final permitted iteration fails with `MAX_AGENT_ITERATIONS_EXCEEDED` — never an extra call, never a silent reinterpretation as `COMPLETE`, never the draft returned as success. The loop is an iterative `for` bounded by `maxIterations`; there is no recursion or `while (true)`.
- Prompts are built deterministically from a fixed controller protocol + registered instructions + task + the latest public working output only. There is no template language, and workflow source cannot inject prompt logic.
- Model selection comes only from `AgentSpec.modelPolicyRef` through Model Runtime's deterministic routing, identically on every iteration: no escalation, no cheap-first/expensive-later, no fallback, no evaluator model.
- A Model Runtime failure ends the Agent — no retry, no alternate model, no restart, no backtracking. Agent iteration is not failure retry.
- Controller determinism is guaranteed (same binding, task, limits, and deterministic model results → same requests, termination point, history, and result). Model generation determinism is not claimed for real providers.

### Contracts and failures

- `AgentExecutionRequest` (`schemaVersion`, caller-owned `agentExecutionId`, `agentRef`, non-blank text `task`), `AgentResult` (`agentExecutionId`, `agentRef`, `finalOutput`, `iterationsUsed`, `history`, optional `usage` totals), and `AgentFailure` are JSON-safe and schema-validated. Usage totals include a field only when every iteration reported it; missing counts are never invented.
- Failure taxonomy: `INVALID_AGENT_REQUEST`, `AGENT_NOT_FOUND`, `UNSUPPORTED_AGENT_CONFIGURATION`, `AGENT_MODEL_POLICY_NOT_FOUND`, `AGENT_MODEL_EXECUTION_FAILED`, `INVALID_AGENT_DECISION`, `MAX_AGENT_ITERATIONS_EXCEEDED`. Expected failures are values. The safe Model Runtime code is preserved as `modelFailureCode`. A structured result violating the decision schema (`MODEL_OUTPUT_SCHEMA_MISMATCH`) is classified as `INVALID_AGENT_DECISION`; every other model failure is `AGENT_MODEL_EXECUTION_FAILED`.

### Iteration evidence

`AgentIterationRecord` (`iteration`, `action`, `output`, `invocationId`, `modelBindingId`, `usage?`) is bounded execution evidence stored in the result (and, for failures after iterations began, in the failure). It is **not** canonical Trace infrastructure and **not** memory. It deliberately keeps what future trajectory/GPA runtime evaluation needs — iteration count, decision sequence, model binding, working output, usage, and termination (success = final `COMPLETE`; failure = `code` + `iteration`) — without scoring anything now.

### Workflow bridge

- `createAgentNodeExecutor({ agents, policies, models })` is an `agent` `NodeExecutor` callers register explicitly; the generic Runtime registers nothing agent-related. Config: `{ agentRef, taskStateKey, resultStateKey }` (top-level keys only, keys must differ), validated in preflight through the existing `validateConfig` hook together with the full support gate; preflight never invokes a model or mutates state, and a failure means zero nodes execute.
- It reads the task from `RunState.values[taskStateKey]`, derives `agentExecutionId` deterministically from Run + Node identity into a bounded canonical identifier (`deriveAgentExecutionId`: `agent.<sha256 hex>` over the unambiguous JSON `[domain, runId, nodeId]`; 70 characters however long the 256-character-max ids are, leaving room for `.i<n>` invocation suffixes; never random, no clock or counter), and calls the same canonical `executeAgent` — there is one Agent execution path.
- Runtime V1 assumes one Agent execution attempt per Agent Node per Run. Future retry/resume semantics will add an explicit *attempt* dimension to the derivation — never ad hoc suffixes such as `.retry1` or timestamps. Direct `executeAgent` callers still supply their own `agentExecutionId`.
- The Agent Node is atomic to the parent Runtime: all iterations happen while the node is `RUNNING`; they count as one workflow step, produce no intermediate state change, and never produce a mid-Agent workflow snapshot. Success proposes exactly one state patch `{ [resultStateKey]: AgentResult }` (one revision increment). Failure proposes none.

### Safe Node executor failure protocol

`NodeExecutionResult` becomes a discriminated union: `{ ok: true, statePatch?, output? } | { ok: false, failure: { namespace, code } }`. The Runtime validates the failure strictly (bounded patterns, no extra fields), keeps its generic `NODE_EXECUTION_FAILED`, and adds subordinate `executorFailure: { namespace, code }` — without interpreting either value. Thrown executors remain supported defensively and still yield a generic, redacted `NODE_EXECUTION_FAILED` with no `executorFailure`; exception strings are never parsed. The `model` node migrates to this protocol (`namespace: "model"`), and the `agent` node uses it (`namespace: "agent"`).

### Explicitly out of scope

Tools and tool calling, Skills Runtime, MCP, external side effects, delegation/subagents/handoffs/multi-agent systems, dynamic workflow modification, long-term/episodic/semantic memory, persistence, checkpointing, resume, mid-Agent snapshots, Reflexion/evaluator-optimizer loops, automatic retry, and fallback.

**Invariant:** Agent output can never grant additional permissions, tools, iterations, model access, or external authority. All such authority comes from deterministic configuration today and from future governance systems.

## Consequences

- New package `packages/agent-runtime`. `@aao/runtime` changes only by the executor-result union and `RuntimeFailure.executorFailure`; every executor now returns an explicit `ok` discriminant (a breaking change to the in-repo `NodeExecutor` contract, applied to all executors and tests in the same change). `ModelNodeExecutionError` is removed as superseded.
- A Runtime without a registered `agent` executor still returns `NODE_EXECUTOR_NOT_FOUND` for an agent node.
- The next phase (Tool Registry & safe tool execution boundary) extends Agents by adding an authorized tool-request path through deterministic governance, not by enabling AI SDK tool calls.
