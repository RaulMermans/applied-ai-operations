# ADR-015: MCP Integration Boundary & Tool Adapter Sessions

Status: accepted

## Context

Sprint 9 established host-attested authorization inside the single Tool execution path. AAO needs external MCP Tools without allowing discovery, remote metadata, or protocol infrastructure to become execution authority. MCP is a connector protocol, not Runtime or an authorization system.

ADR-000 required a fresh production re-spike and historically anticipated split v2 packages. Inspection of the installed official SDK and executable real stdio evidence establish the required behavior in `@modelcontextprotocol/sdk` **1.30.0**. No upgrade is necessary; the production adapter pins that same version. This decision supersedes the v2 assumption, not the requirement for fresh evidence.

## Decision

- One production adapter/anti-corruption package: `@aao/mcp-connector` → `@aao/contracts`, `@aao/tool-runtime`, official MCP SDK, `zod`. The Tool Runtime, Authorization, generic Runtime, and Agent Runtime never depend on it or the SDK. SDK types remain inside the adapter; no canonical contract changes.
- One explicit stateful client/server relationship per host-created session. `CREATED → CONNECTING → READY → CLOSED`; initialization/capability failure is terminal `FAILED`, which can be closed. No implicit connect, retry, reconnect, replay, background manager, or persistence. `close()` is safe and idempotent; unexpected disconnect closes the session.
- **stdio first, Tools only**. Trusted host config contains `command` and optional `args`, defensively captured at construction. No environment injection API, credential custody, HTTP, or OAuth. SDK standard environment inheritance remains infrastructure behavior; subprocess stderr is ignored rather than inherited or logged.
- Tools support must be negotiated before READY. `tools/list` discovery normalizes only name, optional description, input schema and optional output schema into connector-owned JSON data. Bounded schema envelopes, wire JSON checks and compilation through fresh installed-SDK validator providers fail closed; annotations, instructions and execution metadata do not become AAO policy. At most 32 pages / 1,000 tools, with repeated cursors and duplicate names rejected. No auto-registration or list-changed background refresh.
- Binding is explicit and host-controlled: `{ session, remoteToolName, spec: ToolSpec }`. Binding checks canonical spec, object-root input, enforceable local schemas, and freshly discovered remote availability, then produces a normal `RegisteredTool`. The binding captures the remote selection and local spec; later caller mutations cannot change them. There is no public direct MCP invocation API.
- `ToolSpec` remains authoritative for AAO identity, version, description, input/output contracts, permissions and optional `capabilityRef`. MCP names/descriptions/annotations/schemas cannot grant authority. Capabilities remain distinct from Tools; the reference is carried without a Capability Registry, matching, routing, provider selection or company mapping.
- All governed execution uses `executeTool`: support gate → Authorization → AAO input validation → handler → AAO output validation. The existing evaluator and support restriction remain unchanged: only `read_only` / `write_draft`; grants cannot enable external side effects, destructive or sensitive-data classes. No approval engine or Agent Tool use is introduced.
- One handler execution issues **at most one** `client.callTool`. It gets an object-shaped defensive input clone after AAO validation. The session never selects transport or permissions from Tool input, workflow state, Agent decisions, or model output.
- Successful remote data must have usable JSON-safe object `structuredContent`. Arbitrary human text is never parsed as business data. Only the structured output enters `ToolHandlerResult`; content blocks, SDK objects, protocol payloads, stderr, exceptions and stack traces never enter AAO results. AAO still validates its local output schema.
- Safe bounded MCP codes flow through existing `TOOL_EXECUTION_FAILED` and workflow `NODE_EXECUTION_FAILED` causality. Throws are redacted without inspecting message/cause. The SDK can reject protocol results or remote-output mismatches before adapter normalization; these are `MCP_CALL_FAILED`.
- No remote/local JSON Schema equivalence is claimed. Discovery checks the installed SDK's object/schema envelope, JSON safety and compilability under its validator provider. Unsupported syntax/dialects fail closed; semantic equivalence is not established. A locally valid request may be rejected remotely, or a remote response may fail the local output contract. No dialect translation or automatic rebinding is added.

## Re-spike evidence

The installed SDK's `Client.connect(transport)` starts transport and performs initialize/capability negotiation plus initialized notification; `getServerCapabilities()` exposes negotiated Tools support. `listTools({ cursor })` returns tools and optional `nextCursor`; AAO consumes pages explicitly. `callTool` validates protocol results and, when cached by discovery, remote output schemas; that SDK cache is page-scoped and is not AAO's validation authority. AAO output validation remains unconditional regardless of pagination. `StdioClientTransport` starts a subprocess with `shell: false`; close ends stdin, then uses bounded termination escalation if necessary. Client and transport cleanup are both attempted after failures.

Evidence lives in `packages/mcp-connector/test`: real official-SDK stdio lifecycle/discovery, ALLOW → one invocation, DENY/unsupported/invalid input → zero invocations, remote/protocol failure redaction, generic workflow success/failure, malformed discovery, cursor bounds, session isolation, and compiled smoke. Child processes are closed in `finally`/test teardown; a fixture-only ledger proves counts and process shutdown. That ledger is not production session persistence.

## Research migration and consequences

`packages/substrate-spikes/src/mcp.ts` and its test are **KEEP_AS_HISTORICAL_EVIDENCE** for Sprint 0A, explicitly labeled as a toy permission spike. Their Client types and authorization helper are not production contracts or a second production path. No production package imports research code.

Resources, prompts, sampling, elicitation, roots, tasks, logging integration, HTTP/OAuth/credentials, Agent Tool use, approvals, side-effect support, retries, durability and recovery remain deferred. Phase D ends with the governed MCP boundary; the next phase is Governance, not speculative integration infrastructure. A trusted host must vet the actual server/tool behavior against the permissions it assigns: AAO policy cannot make an untrusted server honor read-only semantics.
