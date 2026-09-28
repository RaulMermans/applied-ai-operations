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

Direct callers own `toolExecutionId`. The Tool Node derives it as `tool.<sha256 hex>` over the unambiguous JSON `[domain, runId, nodeId]` (69 characters). It is deterministic and bounded for maximum-length (256) Run and Node ids, and it uses no randomness or clock. Runtime V1 assumes one Tool attempt per Tool Node per Run. Future retry/resume adds an explicit attempt dimension.

## Determinism

- **Tool Runtime control determinism** is guaranteed: the same request, registry, and deterministic handler always give the same validation, invocation count, and result.
- **External-system response determinism** is not guaranteed and is not claimed. Future handlers backed by real systems may return different data.

## Current Tool Runtime non-goals

MCP protocol ownership (implemented separately in `@aao/mcp-connector`, ADR-015), Integration Fabric, capability resolution, OAuth and credentials, connectors, Agent Tool use (`AgentDecision` stays `CONTINUE | COMPLETE`), external side effects, destructive or sensitive-data execution, retries, fallback, timeouts, cancellation, idempotency, replay protection, rollback, compensation, verification, persistence, caching, and Tool memory.
