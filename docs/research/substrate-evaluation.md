# Sprint 0A substrate evaluation

This is evidence for a provisional decision, not production architecture. The only installed dependencies are the three packages exercised by local tests plus their test/build toolchain.

| Candidate | Purpose | Local-first | License | AAO abstraction preserved | Replaceable | Complexity | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LangGraph.js | graph execution | Yes, local invoke tested | MIT | `PrototypeWorkflow` compiler boundary | Yes | Medium | ADOPT_BEHIND_ADAPTER |
| Vercel AI SDK | model provider abstraction | Yes, credential-free adapter test | Apache-2.0 | `ModelExecutor` | Yes | Medium | ADOPT_BEHIND_ADAPTER |
| MCP TypeScript SDK | connector protocol | Yes, in-memory client/server tested | MIT for installed v1 package; current v2 is mixed Apache-2.0/MIT | authorization wrapper before `callTool` | Yes | Medium | ADOPT_BEHIND_ADAPTER |
| Trigger.dev | durable jobs | Not evaluated as runtime | Apache-2.0, source-distribution obligations noted | `DurableExecutor` | Potentially | High | DEFER |
| Composio | integration catalogue/auth | Hosted credentials are material | MIT SDK | `CrmCapability` only | Potentially | Medium | NEEDS_FURTHER_SPIKE |
| Nango | OAuth/authenticated integrations | Self-hosting is not local-minimal | Elastic License | auth connection boundary only | Potentially | High | DEFER |
| @xyflow/react | visual workflow graph | Yes, when UI exists | MIT | backend workflow/run truth remains authoritative | Yes | Low | REFERENCE_ONLY |
| Mastra | application framework reference | N/A | Apache-2.0 core; enterprise directories restricted | N/A | N/A | High | REFERENCE_ONLY |
| Flowise | visual agent builder reference | N/A | Apache-2.0 OSS; enterprise/cloud code restricted; project EOL announced | N/A | N/A | High | REJECT |
| Langflow | visual application framework reference | N/A | MIT | N/A | N/A | High | REFERENCE_ONLY |
| Dify | AI application platform reference | N/A | modified Apache-2.0 with multi-tenant/logo restrictions | N/A | N/A | High | REJECT |

## Executable evidence

### Graph runtime

`workflow.test.ts` compiles a neutral `PrototypeWorkflow` into LangGraph and executes normalise → classify → conditional branch → output. LangGraph types occur only in `workflow.ts`; the public contract package has none. The runtime's dynamically typed node-name API requires a narrow internal bridge because AAO node IDs are data driven. That bridge is the principal leakage risk and must not expand into the contracts package.

### Model layer

`model.test.ts` proves an AAO `ModelExecutor` adapter executes the installed Vercel AI SDK `generateText`/`Output.object` path against its deterministic test model, validates structured output, and maps invalid output and provider failure into `ModelExecutionError`, with no API key. No live provider was tested. Future gates cover direct provider packages and an OpenAI-compatible local endpoint (for example, Ollama/vLLM) before selecting a production provider adapter. Vercel AI SDK can be used in Node; it does not require Vercel deployment, but its current releases should be checked against the supported Node version at adoption time.

### MCP

`mcp.test.ts` uses the official package's in-memory client/server transport, discovers `crm.read_account`, invokes it when allowed, and proves denied and malformed requests leave the server invocation count at zero. MCP is therefore suitable only as a connector protocol below AAO policy. The installed monolithic v1 package works with the Node 20 lab; the official SDK's current v2 split client/server packages should be re-spiked before production adoption.

### Durability

`durability.test.ts` uses an in-memory map to demonstrate the AAO-owned `DurableExecutor` contract and persisted run shape: `runId`, status, current step, state, completed operations, and checkpoint. After an interruption/resume, an operation whose in-memory checkpoint was successfully recorded does not run again. This is not crash-safe persistence, atomic side-effect delivery, or exactly-once execution: a crash after the effect and before the record could replay it. A production adapter needs a durable store, idempotency keys, and a recoverable side-effect contract before real external execution.

### Integrations

`integrations.test.ts` binds the same `findQualifiedAccounts` workflow to two fake providers with incompatible provider schemas. Both implement AAO's `CrmCapability.searchAccounts`, producing the same logical result. This validates capability canonicalisation, not a universal vendor data model.

## Integration assessment

Composio's SDK is MIT, but its credential/tool execution model is a hosted-dependency concern. Evaluate only a narrowly scoped, read-only connector behind AAO tool/permission contracts when an actual provider priority exists. Nango's Elastic License and hosted/enterprise positioning make it unsuitable as a default dependency now; it may later serve only as an authenticated-connection implementation, never as AAO's canonical tools or policy layer. Native adapters remain preferable for the first critical providers where stable capability semantics, auditability, and deterministic side effects matter.

## Framework references

| Reference | Learn | Avoid | Stance |
| --- | --- | --- | --- |
| Mastra | ergonomic workflow and observability ideas | importing its agent/application abstractions as AAO contracts | Reference only; inspect package-level license before copying any code |
| Flowise | visual discoverability for flows | canvas-first runtime/product architecture; it is now EOL | Reject as a foundation |
| Langflow | rapid visual iteration and test playgrounds | Python platform dependency and visual graph as truth | Reference only |
| Dify | product packaging and ops UX | platform adoption and restrictive modified license | Reject |
| xyflow | present backend-defined workflow/run state | treating the canvas as an execution engine | UI-only reference |

## License review

| Dependency/reference | Repository/package | License and implication |
| --- | --- | --- |
| LangGraph.js | `langchain-ai/langgraphjs`, `@langchain/langgraph` | MIT; commercial/private dependency and copying permitted with notice retention. |
| Vercel AI SDK | `vercel/ai`, `ai` | Apache-2.0; commercial/private dependency and copying permitted, subject to license/NOTICE and patent terms. |
| MCP TypeScript SDK | `modelcontextprotocol/typescript-sdk`, `@modelcontextprotocol/sdk` | Installed v1 package reports MIT; upstream v2 describes Apache-2.0 new contributions and MIT existing code. Pin and re-review at v2 migration. |
| Zod | `colinhacks/zod`, `zod` | MIT; schema validation for local spikes. |
| TypeScript | `microsoft/TypeScript` | Apache-2.0; compile only. |
| Vitest / ESLint / typescript-eslint | respective npm packages | MIT; local verification only. |
| Trigger.dev | `triggerdotdev/trigger.dev` | Apache-2.0; if copying/distributing, satisfy attribution/license requirements. Not installed. |
| Composio | `ComposioHQ/composio` | MIT SDK; hosted service terms and credential custody still require review. Not installed. |
| Nango | `NangoHQ/nango` | Elastic License; source-available restrictions make it unsuitable for code copying or default dependence without legal review. Not installed. |
| xyflow | `xyflow/xyflow`, `@xyflow/react` | MIT core; UI-only when needed. Not installed. |
| Mastra / Flowise | respective repositories | Apache-2.0 core portions, but enterprise directories have separate commercial licenses. Do not copy restricted code. |
| Langflow | `langflow-ai/langflow` | MIT; conceptual reference only. |
| Dify | `langgenius/dify` | Modified Apache-2.0 with multi-tenant and branding conditions; do not copy as a foundation. |

Licenses were checked from upstream repository license pages and package registry metadata on 2026-09-20. This is engineering due diligence, not legal advice.
