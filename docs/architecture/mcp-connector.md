# MCP connector

`@aao/mcp-connector` is the sole production MCP adapter. It supplies normal Tool handlers; it does not execute workflows, authorize actors, assign permissions, or mutate AAO state. See [ADR-015](../decisions/ADR-015-mcp-integration-boundary-and-tool-adapter-sessions.md).

## Session architecture

```text
Trusted Host Configuration { command, args? }
        ↓
MCP Session (one client/server relationship)
        ↓
SDK Client (official SDK 1.30.0)
        ↓
stdio subprocess transport
        ↓
MCP Server
```

`createMcpSession(config)` captures a defensive config copy and exposes only `state`, `connect`, `close`, `listTools`. A session is executable infrastructure, not serializable domain data. No Client, Transport, ChildProcess, session, connection state, or subprocess configuration enters a `ToolSpec`, Run, snapshot, request, or result. There is no global singleton or session store.

Lifecycle: `CREATED → CONNECTING → READY → CLOSED`. Failed initialization or missing Tools capability yields terminal `FAILED`; closing it yields `CLOSED`. Connect is explicit and accepted once. Calls/discovery require READY; a closed session cannot reconnect. Close is idempotent, attempts both Client and transport shutdown, and closes pending connection state safely. Unexpected server disconnect also closes READY. No retry, replay, reconnect, background discovery, or connection manager exists.

Only command/args are configurable. No Tool input or workflow/model/Agent channel can supply this config through the Runtime. SDK default bounded environment inheritance is used; AAO adds no env/credential API. Stderr is explicitly ignored, and SDK errors are not logged or exposed.

## Discovery and binding

```text
tools/list (Tools capability required)
    ↓
McpDiscoveredTool { name, description?, inputSchema, outputSchema? }
    ↓
Explicit trusted binding { session, remoteToolName, spec: ToolSpec }
    ↓
RegisteredTool { spec, handler }
    ↓
Tool Registry (host registers explicitly)
    ↓
executeTool
    ↓
permission support gate → Authorization → AAO input validation
    ↓
MCP handler → tools/call (at most once)
    ↓
structured output normalization → AAO output validation → ToolResult
```

Discovery returns defensive JSON-safe data; metadata is never registered automatically. Pagination follows `nextCursor`, rejects repeated cursors/duplicate names, and limits discovery to 32 pages and 1,000 aggregate tools. Names are bounded to 256 characters, descriptions/cursors to 4,096. Schemas must be JSON-safe object-root envelopes matching the installed SDK's discovery shape and compile with its validator provider. Each schema uses a fresh provider to isolate remote `$id` values. Unsupported syntax/dialects or malformed nested schemas fail closed without translating them; no arbitrary MCP schema compatibility is claimed. Discovery never returns annotations, server instructions, permission decisions, SDK objects, or executable code.

`createMcpToolBinding` validates the canonical local `ToolSpec`, requires literal `inputSchema.type === "object"`, checks that local schemas compile under the existing Tool Runtime policy, and freshly discovers the selected remote name. Unknown remote names fail during binding, before any business invocation. The adapter never derives local spec fields from remote metadata. `capabilityRef` remains a local declarative reference, without resolution or matching. No general Integration Fabric is implemented.

Register the returned normal Tool in a host-owned `createToolRegistry()`, and call `executeTool({ tools, request, authorizationContext })` or use the existing generic workflow `tool` node. The connector's internal invocation resolver is not exported; the package exports map prevents public subpath execution access. Registered handlers remain trusted executable host configuration, exactly as for local Tools.

## Trust boundary

| Input | Trust and owner | Can control |
| --- | --- | --- |
| MCP discovery metadata | External/untrusted evidence | Remote name/schema information only |
| AAO `ToolSpec` | Trusted host binding, canonical AAO contract | Local identity, schemas, permissions, capability reference |
| `AuthorizationContext` | Host-attested authority | Principal grants and optional registered Agent ceiling |
| Stdio command/args | Trusted infrastructure configuration | Server process selected at session construction only |
| Tool input / workflow state / model output | Untrusted data | Validated business arguments only |

Tool Runtime still refuses `external_side_effect`, `destructive`, `sensitive_data`, even with grants. Authorization is unchanged and occurs before input validation. Denied authorization, unsupported classes, and invalid AAO input each yield zero remote calls. A host must vet the selected server's actual behavior before assigning `read_only` or `write_draft`; discovery hints cannot establish those semantics.

The MCP handler receives only validated object input and makes a defensive JSON clone. No scalar, array or null coercion exists. No MCP workflow node or Agent Tool-use path is added. Runtime state patches remain owned by the generic Runtime.

## Results and failures

`structuredContent` must be present as JSON-safe object data. The connector rejects class instances, cycles, accessors, non-finite numbers and other lossy JSON. It never parses text content as structured business output. Only the structured object reaches `ToolHandlerResult`; AAO's output schema remains the final validation boundary.

| Code | Meaning |
| --- | --- |
| `MCP_SESSION_NOT_READY` | Invocation/discovery/connection attempted in an invalid lifecycle state |
| `MCP_CONNECTION_FAILED` | Invalid host config or redacted initialization/transport failure |
| `MCP_TOOLS_UNSUPPORTED` | No negotiated Tools capability |
| `MCP_DISCOVERY_FAILED` | Redacted SDK/protocol discovery failure |
| `MCP_INVALID_DISCOVERY` | Malformed normalized metadata, unsafe JSON, duplicate name |
| `MCP_DISCOVERY_LIMIT_EXCEEDED` | Page/tool limit or repeated cursor |
| `MCP_TOOL_NOT_AVAILABLE` | Selected name absent from validated discovery |
| `MCP_INVALID_BINDING` | Invalid local spec/object input or foreign session object |
| `MCP_CALL_FAILED` | Redacted SDK/transport/protocol exception |
| `MCP_TOOL_REPORTED_ERROR` | Remote Tool returned `isError` |
| `MCP_INVALID_RESULT` | Unusable structured result |
| `MCP_STRUCTURED_OUTPUT_REQUIRED` | No structured output; text is not inferred |

Setup/discovery throws a connector-owned error whose message contains only its code. Handler failures return `{ ok: false, code }` → existing `TOOL_EXECUTION_FAILED` + bounded `handlerFailureCode`; workflow callers see `NODE_EXECUTION_FAILED` with Tool causality. No raw server text, stderr, URL, exception cause or stack is propagated. A local output mismatch stays the existing `TOOL_OUTPUT_SCHEMA_MISMATCH`, without output details.

The SDK itself may reject malformed protocol responses, absent structured data under a remote output schema, or remote schema mismatches; these normalize to `MCP_CALL_FAILED`. SDK remote-output validators are discovery-page-scoped; they are supplementary protocol behavior, never the AAO validation boundary. AAO local/remote schema equivalence is not asserted. A server may reject locally valid arguments. Binding availability is a point-in-time check; there is no drift subscription, rebinding, or replay.

## Evidence and operation

Tests use a deterministic official SDK server subprocess with a fixture-only call-count ledger. Teardown closes processes and removes each temporary ledger/directory. Integration tests exercise session isolation, capabilities, pagination, explicit binding, authorized execution once, zero-call denial/support/input gates, remote failures, and generic workflow execution. Low-level mocks cover non-wire JSON and connection races that real JSON transport cannot represent.

```sh
pnpm test packages/mcp-connector/test
pnpm build
pnpm --filter @aao/mcp-connector smoke
```

The smoke imports built production packages, discovers and explicitly binds `crm.read_account` to `crm.account.read@1.0.0`, authorizes a service with `read_only`, validates the account result, proves exactly one call, and closes/removes its fixture. Success marker: `SPRINT_10_MCP_CONNECTOR_SMOKE_OK`.

Sprint 0A MCP code is retained as `KEEP_AS_HISTORICAL_EVIDENCE`; only this package is production authority. HTTP, OAuth/credentials, resources, prompts, sampling, elicitation, roots, tasks, MCP logging, Agent Tool use, MCP-specific approval delivery, side effects, retries, persistence and recovery are deferred. Generic approval waitpoints now live in `@aao/approval`, separate from MCP. The next roadmap phase is Reliability Runtime.

## Sprint 10 validation evidence

Validated with Node 20.20.0 / pnpm 10.26.0, starting from clean generated artifacts:

| Command | Result |
| --- | --- |
| `CI=true pnpm install --frozen-lockfile` | Passed; host cache/network used after sandbox cache/network failures |
| `pnpm test` | Passed: 85 files / 1,132 tests at that point; final `pnpm check` includes the two added transport-selection cases, 1,134 tests |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed |
| `pnpm build` | Passed |
| `pnpm check` | Passed: typecheck, lint, build, 85 files / 1,134 tests |
| `git diff --check` | Passed |
| `pnpm test packages/mcp-connector/test` | Passed: 3 files / 53 tests (22 real stdio integration, 22 low-level session/wire, 9 dependency checks) |
| `pnpm --filter @aao/mcp-connector smoke` | Passed: `SPRINT_10_MCP_CONNECTOR_SMOKE_OK` |

Real stdio evidence: `crm.read_account` → `crm.account.read@1.0.0`, local `capabilityRef: crm.accounts.read`, principal `user.alice` with `read_only` → ALLOW / exactly one call / `{ id: "a-1", name: "Local Test Account" }`. Missing grant, unsupported `external_side_effect` even with its grant, invalid AAO input, and attempted input/config transport selection each produce zero remote invocations. Runtime/Agent/Authorization/Tool Runtime contain no connector or SDK imports. Core contracts and execution semantics are unchanged. The fixture-only temporary ledgers and child processes are cleaned up.

## Adapter contract and host-owned retry safety (Sprint 20)

The connector is the `tool_provider` adapter `aao.mcp-connector@1.0.0` (`MCP_CONNECTOR_ADAPTER_MANIFEST`: `tool.discovery`, `tool.execution`, and `tool.retryable_failure` supported). MCP is a Tool provider, and never a workflow, agent, governance, authorization, approval, or durability provider ([ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md)).

- **Remote metadata stays untrusted.** Discovery keeps name, description, and schemas only. Annotations, `_meta`, and any safety or authority hints are dropped, and nothing reads them.
- **Retry safety is host configuration.** `createMcpToolBinding({ ..., retrySafety })` is the only way an MCP Tool becomes Runtime-retryable. It defaults to `unsafe`, and `safe` is accepted only when every permission class is `read_only`. It maps into the Tool Runtime's canonical `retrySafety`. It is never inferred from a name, description, annotation, or verb.
- **The connector still never retries.** A server-side internal error or request timeout (`McpError` `InternalError` / `RequestTimeout`) is returned as `{ ok: false, code: "MCP_CALL_FAILED", retryable: true }`. The Runtime retries only if the host declared the Tool safe, within its bounded policy. A tool-reported error (`isError`) and every other failure stay non-retryable.
- **Retry safety ≠ recovery safety.** Crash-recovery safety stays the Tool Runtime's canonical derivation. The connector does not forward `toolExecutionId`, so it refuses any `idempotency` assertion, and a `write_draft` MCP Tool is never recovery-safe.
- **Conformance.** The explicit `@aao/mcp-connector/conformance` export supplies a subject backed by the shipped stdio conformance server (`conformance/server.mjs`), whose discovery metadata is deliberately hostile. See the [compatibility matrix](../framework/adapter-compatibility.md).
