# Tool runtime

`@aao/tool-runtime` (`packages/tool-runtime`, Sprint 8) executes explicitly registered, schema-validated, locally trusted Tools through one deterministic boundary. It refuses permission classes AAO is not yet safe to execute, requires a host-attested Authorization Context for every execution (Sprint 9), and reports every expected failure as a machine-readable value. See [ADR-013](../decisions/ADR-013-tool-registry-and-safe-execution-boundary.md), [ADR-014](../decisions/ADR-014-authorization-and-permission-enforcement.md), and [authorization](authorization.md).

## Contracts

```text
ToolSpec (canonical, @aao/contracts)   declarative interface: id, version, inputSchema, outputSchema, permissionClasses, capabilityRef?
RegisteredTool                         { spec: ToolSpec, handler: ToolHandler }, the trusted executable binding
ToolRef                                { id, version }, exact
ToolExecutionRequest                   { schemaVersion: 1, toolExecutionId (caller-owned), toolRef, input: JsonValue }
ToolResult                             { schemaVersion: 1, toolExecutionId, toolRef, output: JsonValue }
ToolFailure                            { code, message, toolExecutionId?, toolRef?, handlerFailureCode?, unsupportedPermissionClasses?, authorizationReasonCode?, issues? }
ToolExecutionResult                    { ok: true, result: ToolResult, authorization: ALLOW decision } | { ok: false, failure: ToolFailure }
```

`ToolSpec` is not duplicated or extended. Executable code exists only in `RegisteredTool.handler`, which lives in Runtime configuration and never appears in a request, result, failure, or workflow state.

## Direct path

```text
ToolExecutionRequest     JSON-safety (canonical isJsonSafe) + ToolExecutionRequestSchema   → INVALID_TOOL_REQUEST
        ↓
Tool Registry            exact id + version                                                  → TOOL_NOT_FOUND
        ↓
Permission support gate  every class ∈ { read_only, write_draft }                            → TOOL_PERMISSION_UNSUPPORTED
        ↓
Authorization            host context required; authorize() over ToolSpec.permissionClasses   → TOOL_AUTHORIZATION_REQUIRED
        ↓                                                                                    → TOOL_AUTHORIZATION_DENIED (+ authorizationReasonCode)
Input schema validation  compiled ToolSpec.inputSchema                                       → TOOL_INPUT_SCHEMA_MISMATCH
        ↓
Trusted Tool Handler     at most once; throw/reject → generic failure                        → TOOL_EXECUTION_FAILED
        ↓                returned { ok: false, code } → failure + handlerFailureCode          → TOOL_EXECUTION_FAILED
Output validation        strict result shape, then JSON-safety                               → INVALID_TOOL_RESULT
        ↓                then compiled ToolSpec.outputSchema                                 → TOOL_OUTPUT_SCHEMA_MISMATCH
ToolExecutionResult      { ok: true, result: ToolResult }
```

Entry point: `executeTool({ request, tools, authorizationContext })`. It is the only Tool execution implementation and the only exported path that invokes a registered handler. The Tool Node, future governed Agent Tool use, and MCP-backed handlers all inherit it.

## Workflow path

```text
Workflow tool Node        config: { toolRef, inputStateKey, resultStateKey } (top-level keys only, must differ)
      ↓
Generic AAO Runtime       caller registers createToolNodeExecutor({ tools, resolveAuthorizationContext }) explicitly;
      ↓                   preflight: config schema, exact Tool registered, permission support (no state read, no handler call, no authorization)
Host resolver             resolveAuthorizationContext({ runId, nodeId, toolRef }) → AuthorizationContext (throw/undefined → TOOL_AUTHORIZATION_REQUIRED)
      ↓
Tool Runtime              executeTool({ toolExecutionId: deriveToolExecutionId(runId, nodeId), toolRef, input: state[inputStateKey] })
      ↓
Tool Handler              once
      ↓
ToolResult
      ↓
Runtime-managed patch     success: { [resultStateKey]: ToolResult } → one revision increment
                          failure: no patch; NODE_EXECUTION_FAILED + executorFailure { tool, <ToolFailureCode> }
```

An unsupported Tool (`external_side_effect`, `destructive`, `sensitive_data`, alone or mixed) fails `RUNTIME_PREFLIGHT_FAILED` before any workflow node executes. Without the registered executor, a `tool` node fails with `NODE_EXECUTOR_NOT_FOUND`: `@aao/runtime` knows nothing about Tools.

Failure causality stays layered and decoupled:

```text
Workflow Runtime   NODE_EXECUTION_FAILED
      ↓
executorFailure    { namespace: "tool", code: "TOOL_EXECUTION_FAILED" }
      ↓
direct ToolFailure handlerFailureCode: "NOT_FOUND"   (direct executeTool callers only)
```

The generic Runtime never learns handler semantics, and neither does the Agent Runtime.

## Future enterprise path (not implemented)

```text
AAO Capability            e.g. crm.accounts.search
      ↓
Integration Fabric Adapter
      ↓
AAO Tool Binding          RegisteredTool { spec, handler }
      ↓
Tool Runtime
```

Sprint 8 carries `ToolSpec.capabilityRef` but does not resolve it: there is no Capability Registry, general Adapter Registry, or capability routing. Sprint 10 supplies explicit MCP Tool bindings from the separate connector package. Tool Runtime executes registered Tool bindings. Integration Fabric will later create and bind those Tools to normalized enterprise capabilities, and MCP Tools arrive as explicit host-owned Tool bindings (`MCP → AAO Tool Binding → Tool Runtime`), never `Agent → MCP` directly.

## Registry

`createToolRegistry()` returns an isolated instance: no global singleton, no filesystem scanning, and no dynamic import. `register({ spec, handler })` checks JSON safety and `ToolSpecSchema`, requires `handler.execute`, rejects a duplicate `id@version`, and compiles both schemas. Any failure throws, because these are programming errors in trusted host code. The public surface is inspection only: `getSpec(ref)` is version-exact and returns a fresh spec clone, and `has(ref)` checks presence. Neither exposes the handler or a validator; executable bindings live in a module-private `WeakMap` that only `executeTool` resolves, and the registry object is frozen. The stored spec and compiled schemas come from a private clone, so no caller reference can mutate registry state. Registration captures the handler's `execute` function (bound to the original object) into a frozen registry-owned handler, and compiled schemas are frozen wrappers around a closure-private Ajv validator. The stored spec is deep-frozen. Reassigning `execute` on the original handler cannot change what later `executeTool` calls run or enforce. Registration order does not matter.

## JSON Schema policy

Ajv, compiled at registration, fail closed:

- dialect: Ajv default (draft-07); any other `$schema` fails
- `strict: true`: unknown keywords, ignored keyword combinations, and `strictTypes` violations (e.g. `properties` without `"type": "object"`) fail
- `format`: no format plugin is installed, so any `format` fails
- no remote `$ref`, no `$data`, no `$async`
- no mutation: `useDefaults`, `coerceTypes`, and `removeAdditional` stay off
- one fresh Ajv instance per schema, so there is no shared cache or `$id` namespace

Input-mismatch `issues` are Ajv messages with the instance path and never the offending value. Output mismatches report no issues, so handler data is never echoed into a failure.

## Permission support gate

`read_only` and `write_draft` are supported. `external_side_effect`, `destructive`, and `sensitive_data` are refused. **All** of a Tool's classes must be supported. Only `write_draft` metadata is supported; no draft writer exists.

**Registered ≠ supported ≠ authorized.** See [permission model](../security/permission-model.md). The gate says which Tool kinds this runtime version can execute and runs before authorization, so no grant can enable an unsupported class. Who may invoke a supported Tool is decided by `@aao/authorization` ([authorization](authorization.md)).

## Handler contract

```ts
interface ToolHandler { execute(context: ToolHandlerContext): Promise<ToolHandlerResult> }
ToolHandlerContext = { toolExecutionId, tool: ToolRef, input: JsonValue }   // validated clone; nothing else injected
ToolHandlerResult  = { ok: true, output: JsonValue } | { ok: false, code: /^[A-Z][A-Z0-9_]{0,63}$/ }
```

Handlers get no workflow state, `process.env`, credentials, database, MCP session, model client, Agent Runtime, or global service. Adapters construct handlers with explicit dependencies outside the Tool Runtime. The [MCP connector](mcp-connector.md) captures its private session in a handler closure; no MCP type enters this contract.

## Execution identity

Direct callers own `toolExecutionId`. The Tool Node derives it as `tool.<sha256 hex>` over the unambiguous JSON `[domain, runId, nodeId]` (69 characters). It is deterministic and bounded for maximum-length (256) Run and Node ids, and it uses no randomness or clock. The id names the logical Tool Node execution. It is identical on every Runtime attempt (Sprint 13), across process restarts, and on every durable recovery replay (Sprint 14). The attempt dimension lives in Runtime attempt accounting, not in the id.

## Determinism

- **Tool Runtime control determinism** is guaranteed: the same request, registry, and deterministic handler always give the same validation, invocation count, and result.
- **External-system response determinism** is not guaranteed and is not claimed. Future handlers backed by real systems may return different data.

## Current Tool Runtime non-goals

MCP protocol ownership (implemented separately in `@aao/mcp-connector`, ADR-015), Integration Fabric, capability resolution, OAuth and credentials, connectors, Agent Tool use (`AgentDecision` stays `CONTINUE | COMPLETE`), external side effects, destructive or sensitive-data execution, retry loops inside Tool Runtime, fallback, rollback, compensation, verification, persistence, caching, and Tool memory. Tool Runtime contributes only trusted idempotency/recovery metadata; replay protection lives in `@aao/durability` (Sprint 14).

## Sprint 13 reliability boundary

`executeTool` still invokes a handler at most once per call; Tool Runtime owns no retry loop, sleep, or timeout race. It contributes trusted metadata only. `RegisteredTool.retrySafety` defaults to `"unsafe"` and may be `"safe"` only when every permission class is `read_only`; `write_draft` Tools are never Runtime-retried. A handler may return `{ ok: false, code, retryable: true }` to declare an explicitly transient failure (`ToolFailure.handlerFailureRetryable`). The Tool Node classifies each failure code (`classifyToolFailure`) and forwards the Runtime's cooperative `AbortSignal` to the handler as `ToolHandlerContext.signal`. Authorization, support-gate, and validation failures are never retryable. Unsupported permission classes still fail preflight with zero handler calls under any retry policy. See [reliability runtime](reliability-runtime.md) and [ADR-018](../decisions/ADR-018-runtime-reliability-and-bounded-retries.md).

## Sprint 14 idempotency and recovery boundary

`RegisteredTool.idempotency` is a trusted declaration: `"none"` (default) or `"execution_id"`. `"execution_id"` asserts that repeated invocations with the same `toolExecutionId` resolve to one logical operation. AAO keeps the id stable and propagates it, but it cannot verify that an implementation or external provider honors it.

The Tool Node exposes `recoverySafety` from registration metadata only (`toolRecoverySafety`). A Tool is recovery-safe in two cases:

- It is all-`read_only` and declares `retrySafety: "safe"` or `idempotency: "execution_id"`.
- It is `read_only`/`write_draft` and declares `idempotency: "execution_id"`.

Everything else is unsafe, and every unsupported class is always unsafe. A durability host may therefore replay an ambiguous idempotent `write_draft` attempt once after a crash. A non-idempotent `write_draft` attempt fails closed with `DURABILITY_UNSAFE_REPLAY`.

Ordinary Runtime retries are unchanged: `write_draft` is never retried after a known failure, even when idempotent. The permission support gate is unchanged: `external_side_effect`, `destructive`, and `sensitive_data` stay unsupported. Tool Runtime contains no durability code. See [durable execution](durable-execution.md) and [ADR-019](../decisions/ADR-019-durable-execution-checkpoints-and-replay.md).

## Trace (Sprint 15)

`executeTool` accepts an optional `ToolExecutionObserver` that receives safe metadata only. It is told about each outcome and is never consulted:

- `blocked`: the handler was never invoked. This covers the support gate, authorization denial, and request or input validation.
- `started`: fired only once every pre-execution check has passed, with the ALLOW decision.
- `completed`: the result was accepted.
- `failed`: an invoked handler did not produce an accepted result.

The Tool Node maps these to `tool.call.blocked`, `tool.call.started`, `tool.call.completed`, and `tool.call.failed`. Each event carries the Tool ref, the stable `toolExecutionId`, the attempt, permission classes, and bounded codes. Tool input, output, authorization context, and handler errors are never traced. Without an observer, the execution path is unchanged. See [trace runtime](trace-runtime.md).

## Audit (Sprint 16)

`ToolNodeDependencies.audit` (or `executeTool({ audit })`) is an optional, emit-only Audit binding. `tool-audit.ts` records each Authorization decision as `tool.access.allowed` or `tool.access.denied`: access accountability for the attempt, correlated with Trace by `toolExecutionId` and attempt. Allowed means the invocation path may continue, not that the Tool succeeded. Tool input and output are never recorded. A failing Audit port changes nothing and causes no retry. The support gate is unchanged: `external_side_effect`, `destructive`, and `sensitive_data` remain unsupported even with Audit present. See [audit](audit.md).

## Evaluation (Sprint 17)

`@aao/evaluation` judges Tool behavior from the canonical Trace this package's observer feeds:

- `tool.call.started` means the handler was invoked.
- `tool.call.blocked` means the support gate, Authorization, or validation stopped the call, and handler calls = 0. It is never counted as an invocation.
- Physical invocations (handler starts) and logical executions (distinct `toolExecutionId`s) stay distinct.

Because Tool input is validated before the handler runs, a started call already implies schema-valid input. Semantic argument quality is not inferred from Trace, which never carries arguments. An EvalResult has no path to the support gate: `external_side_effect`, `destructive`, and `sensitive_data` remain unsupported whatever an evaluation concludes. See [evaluation runtime](evaluation-runtime.md).
