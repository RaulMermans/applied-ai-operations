# ADR-000: Provisional substrate recommendation

Status: proposed for Sprint 0 review. This does not freeze AAO architecture.

## Context

AAO is a local-first, workflow-first operational layer. It needs reusable infrastructure but must keep its own product semantics and permit replacement.

## Recommendations

- **LangGraph.js — ADOPT_BEHIND_ADAPTER.** The local compiler spike proves conditional execution can be hidden behind AAO `PrototypeWorkflow`/run-state data. Retain an `AAO Workflow Compiler` boundary.
- **Vercel AI SDK — ADOPT_BEHIND_ADAPTER.** Use an `AAO ModelExecutor` plus model-policy/provider boundary. The installed `ai` package executes locally with structured output, invalid-output handling, and canonical error mapping; live and local-compatible providers remain future-gate work.
- **MCP TypeScript SDK — ADOPT_BEHIND_ADAPTER.** Use as a connector protocol only. `AAO Tool`, permissions, approvals, validation, and audit must execute before invocation. Re-spike current split v2 packages before production.
- **AAO-owned local durability — ADOPT.** Continue with the `DurableExecutor` boundary and an AAO run/checkpoint model; choose a real backing store only after a crash/recovery requirement exists.
- **Capability adapters — ADOPT.** `CrmCapability` demonstrates provider-independent workflow behavior. Canonicalise capabilities, never full vendor schemas.
- **xyflow — REFERENCE_ONLY.** Use later for a React visualisation of backend truth, never for execution semantics.

## Rejected candidates

- **Dify — REJECT** as a platform foundation: its modified Apache terms and platform-shaped architecture weaken AAO differentiation.
- **Flowise — REJECT** as a foundation: visual-builder semantics are not AAO's runtime contract, and the project has announced EOL.

## Deferred candidates

- **Trigger.dev — DEFER.** It is a future durable-execution adapter candidate, but adoption would add hosted/self-hosted operational assumptions prematurely.
- **Nango — DEFER.** Its Elastic License and full integration-platform surface require legal/product justification. It may later serve only behind an authenticated-connection interface.
- **Composio — NEEDS_FURTHER_SPIKE.** Its MIT SDK and breadth may help, but credential custody, hosted-service dependency, and vendor tool semantics need a targeted real-provider, read-only test.
- **Mastra and Langflow — REFERENCE_ONLY.** Learn from ergonomics and UX; do not inherit product contracts or foundations.

## AAO-owned surfaces

AAO owns the stable contracts for Workflow, Node, Tool, Agent, Model Policy, Permission, Approval, Company Configuration, Run, State, Checkpoint, Trace, Eval, Artifact, capability contracts, policy enforcement, side-effect authorisation, idempotency, and final execution gates.

## Replacement boundaries and risks

| Dependency | AAO boundary | Main risk | Mitigation |
| --- | --- | --- | --- |
| LangGraph | workflow compiler and typed AAO run state | graph/checkpoint semantics leak upward | framework types confined to adapter; contract tests |
| Vercel AI SDK | `ModelExecutor` plus AAO model policy | provider behaviour or gateway assumptions leak | provider adapters and canonical error/result tests |
| MCP SDK | AAO tool invocation/authorisation wrapper | tool discovery bypasses policy | validate and authorise before `callTool`; audit each invocation |
| future durability provider | `DurableExecutor` and AAO run record | replay duplicates side effects | operation keys, checkpoints, and idempotency tests |
| future integration provider | capability contracts such as `CrmCapability` | vendor schemas become workflow contracts | provider mapping tests and native fallback |

Other risks are licensing changes, hosted-service dependency, local development friction, and unnecessary complexity. Pin versions, review license changes on upgrades, keep credentials optional in local work, and add no provider until an evidence-backed workflow requires it.

## Vercel AI SDK adapter compared with direct provider SDK adapters

| Concern | Vercel AI SDK adapter | Direct provider SDK adapters |
| --- | --- | --- |
| AAO abstraction leakage | One `ModelExecutor` adapter contains AI SDK model types. | Each provider adapter must separately contain its provider types and semantics. |
| Structured outputs | `generateText` with `Output.object` provides a single local structured-output path. | Each provider's response-format and validation API must be normalized by AAO. |
| Tool calling | Useful provider-neutral transport beneath AAO-owned authorization and execution gates. | Provider tool semantics must be individually normalized beneath those same AAO gates. |
| Provider portability | Supports a common model interface while AAO retains the replaceable boundary. | Maximizes access to provider-specific features, with more adapter implementations. |
| Local/OpenAI-compatible endpoint | Plausible through a compatible provider adapter, but not yet exercised. | Plausible through a provider's compatible client, but not yet exercised. |
| Dependency complexity | One SDK plus selected provider packages; provider behavior still requires evidence. | Fewer abstraction layers per provider, but separate SDKs and mappings grow with each provider. |
| Observability | SDK telemetry can inform adapter instrumentation; AAO remains the authoritative trace/audit surface. | Each adapter must normalize provider telemetry into the same AAO trace/audit surface. |

The executable local evidence supports `ADOPT_BEHIND_ADAPTER`; it does not select a production provider or relax AAO model-policy, authorization, evaluation, or observability ownership.

## Consequences

Sprint 0 may proceed after Sprint 0A.1 to refine canonical contracts and repository structure. The following are explicit future gates, not Sprint 0 architecture-contract prerequisites:

| Future gate | Intended phase |
| --- | --- |
| Live provider test; local/OpenAI-compatible endpoint test; model/provider benchmarking | Before selecting or operating a production model/provider adapter. |
| Current supported MCP SDK version re-spike; auth/transport validation; connector lifecycle behavior | Before a production MCP connector migration. |
| Crash-safe persistence; durable idempotency; atomic or recoverable side-effect contract | Before durable external side effects or crash recovery are required. |
| One read-only real provider integration; authentication/credential boundary; integration-specific evals | Before enabling that provider integration in a governed workflow. |
