# ADR-013: Tool Registry & Safe Tool Execution Boundary

Status: accepted (amended by [ADR-014](ADR-014-authorization-and-permission-enforcement.md): `executeTool` now requires an Authorization Context and authorizes after the support gate; `ToolRegistry.get` is replaced by the inspection-only `getSpec`/`has`)

## Context

Sprints 4–7 gave AAO a workflow Runtime, a Model Runtime, and a bounded Agent Runtime. The canonical `ToolSpec` (ADR-007) has existed since Sprint 2 with no execution semantics, and a `tool` node could only fail preflight with `NODE_EXECUTOR_NOT_FOUND`. AAO needs one deterministic boundary through which trusted Tool implementations run — schema-validated in both directions, refusing Tool kinds it is not yet safe to execute, and failing with machine-readable values — before authorization, MCP, integrations, or Agent Tool use can be built on it.

## Decision

### Tool Runtime as a distinct Core subsystem

- The Tool Runtime is a new package, `@aao/tool-runtime`, a distinct AAO Core subsystem. `@aao/runtime` stays Tool-agnostic: it knows only `NodeExecutor`.
- Production dependencies: `@aao/contracts`, `@aao/runtime`, `ajv` (the version Model Runtime already uses), `zod`, plus Node's built-in `node:crypto`. No MCP SDK, Composio, Nango, vendor SDK, database driver, Fastify, LangGraph, AI SDK, Model Runtime, or Agent Runtime import (enforced by a dependency-boundary test).

### Definition vs binding

- Canonical `ToolSpec` stays authoritative and is reused intact — no second Tool contract. `ToolSpec` is the declarative interface; `RegisteredTool = { spec: ToolSpec, handler: ToolHandler }` is the trusted executable binding. The handler lives only in Runtime configuration, never in `ToolSpec`, a request, a result, or workflow state.
- An explicit, constructible, isolated `ToolRegistry` (no global singleton, no filesystem scanning, no dynamic import, no workflow-controlled code loading) keys Tools by `id` + `version`. Lookup is exact (no "latest"); duplicates are rejected; specs are JSON-safety-checked, validated against `ToolSpecSchema`, and defensively cloned in and out.

### JSON Schema policy

- `inputSchema`/`outputSchema` are compiled with Ajv **at registration**; a schema Ajv cannot reliably enforce makes registration throw (fail closed) rather than surfacing at first invocation.
- Policy: Ajv's default dialect (draft-07; another `$schema` fails), `strict: true` (unknown keywords, ignored keyword combinations, `strictTypes` violations, and every `format` — no format plugin is installed — fail), no remote `$ref`, no `$data`, no `$async`, and no data mutation (`useDefaults`/`coerceTypes`/`removeAdditional` off). One fresh Ajv instance per schema. No proprietary schema language.

### One execution path

`executeTool({ request, tools })` is the only Tool execution implementation:

```text
ToolExecutionRequest (JSON-safety + schema) → Tool Registry (exact version) → permission support gate
→ inputSchema → trusted handler (at most once) → result shape → canonical JSON safety → outputSchema → ToolResult
```

- `ToolExecutionRequest` = `{ schemaVersion: 1, toolExecutionId, toolRef: { id, version }, input: JsonValue }`, caller-owned id, no environment/provider/credential fields. `ToolResult` = `{ schemaVersion: 1, toolExecutionId, toolRef, output }`. `ToolExecutionResult` = `{ ok: true, result } | { ok: false, failure }`. All JSON-safe; the canonical `isJsonSafe` from `@aao/runtime` is reused, not redefined.
- Failure taxonomy: `INVALID_TOOL_REQUEST`, `TOOL_NOT_FOUND`, `TOOL_PERMISSION_UNSUPPORTED`, `TOOL_INPUT_SCHEMA_MISMATCH`, `TOOL_EXECUTION_FAILED`, `TOOL_OUTPUT_SCHEMA_MISMATCH`, `INVALID_TOOL_RESULT`. Expected failures are values; only Tool Runtime invariant bugs throw.
- Handler contract: `execute({ toolExecutionId, tool, input }) → Promise<{ ok: true, output } | { ok: false, code }>`. The context is minimal (no workflow state, env, credentials, database, MCP session, model client, Agent Runtime, or global service); `input` is a validated clone. A returned `code` must match `^[A-Z][A-Z0-9_]{0,63}$` and is preserved as `handlerFailureCode` behind `TOOL_EXECUTION_FAILED`. Any other field (message, stack, headers, nested details) makes the result `INVALID_TOOL_RESULT`. A thrown or rejected handler yields a generic `TOOL_EXECUTION_FAILED` with nothing of the thrown value; exception strings are never parsed.
- No automatic retry, backoff, fallback Tool, alternate provider, or replay: one request invokes the handler at most once. No Promise-race "timeout": without cooperative cancellation it would report cancellation while the handler kept running. Timeouts/cancellation are deferred to Reliability/Integration work; Tool cancellation does not exist.
- No Tool memory: no cache, call history, or global mutable Tool state.

### Permission support gate (not authorization)

- Tool Runtime V1 executes a Tool only if **every** permission class in its `ToolSpec` is `read_only` or `write_draft`. `external_side_effect`, `destructive`, and `sensitive_data` — alone or mixed (e.g. `["read_only", "sensitive_data"]`) — fail closed with `TOOL_PERMISSION_UNSUPPORTED` before input validation and with zero handler calls, even though the host registered the Tool.
- This is an execution-support gate, deliberately not named authorization. **Registered ≠ authorized**: registration means trusted code implements the Tool; it never means an actor, Agent, or workflow may invoke it. Actor/permission/policy enforcement is Sprint 9.
- `write_draft` support is metadata support only; no filesystem or external draft writer exists.

### Workflow bridge

- `createToolNodeExecutor({ tools })` is a `tool` `NodeExecutor` callers register explicitly; without it a `tool` node still fails preflight with `NODE_EXECUTOR_NOT_FOUND`. Config `{ toolRef, inputStateKey, resultStateKey }`: strict, top-level state keys only, keys must differ; no JSONPath, expressions, templates, or code.
- Preflight (`validateConfig`) checks config, exact-version registration (hence compiled schemas), and permission support — so an unsupported Tool fails `RUNTIME_PREFLIGHT_FAILED` with zero workflow nodes executed. It never reads runtime state.
- Execution reads `RunState.values[inputStateKey]`, calls `executeTool` once, and proposes exactly one patch `{ [resultStateKey]: ToolResult }`, or returns `{ ok: false, failure: { namespace: "tool", code: <ToolFailureCode> } }` with no patch. The Runtime owns `NODE_EXECUTION_FAILED`; the handler code stays inside the direct Tool result and never reaches the generic Runtime.
- Workflow-owned Tool execution ids are derived deterministically: `deriveToolExecutionId(runId, nodeId)` = `tool.<sha256 hex>` over the unambiguous JSON `[domain, runId, nodeId]` — 69 characters for any valid ≤256-character ids, no randomness, clock, or counter. Runtime V1 assumes one Tool attempt per Tool Node per Run; future retry/resume will add an explicit attempt dimension. Direct `executeTool` callers own their ids.

### Agent permissions — direction only

`AgentSpec.permissionClasses` should eventually act as one deterministic ceiling on the Tool requests an Agent may make, in addition to Tool permission requirements and governance policy. Not implemented: Agents cannot request Tools. `AgentDecision` stays `CONTINUE | COMPLETE`; adding Tool use before authorization would bypass the governance sequence.

### Explicitly out of scope

MCP (host, client, sessions, discovery), Integration Fabric (capability resolution — `capabilityRef` is carried but not resolved — adapters, OAuth, credentials, connectors, webhooks), Agent Tool use, external side effects, destructive or sensitive-data execution, Tool persistence, retries, idempotency keys, replay protection, rollback, compensation, verification, timeouts, and cancellation.

## Consequences

- New package `packages/tool-runtime`; `@aao/runtime`, `@aao/model-runtime`, and `@aao/agent-runtime` are unchanged.
- Future MCP adapters and Integration Fabric bind external capabilities *into* `RegisteredTool`s executed by this Runtime (`MCP capability → AAO Tool Binding → Tool Runtime`), never `Agent → MCP` directly.
- Sprint 9 adds authorization (actor + Agent permission ceiling + Tool requirements + policy → deterministic decision) in front of `executeTool` before Agent Tool use or any external side effect is enabled.
- Tool Runtime control behavior is deterministic for the same request, registry, and deterministic handler. External systems behind future handlers need not be.
