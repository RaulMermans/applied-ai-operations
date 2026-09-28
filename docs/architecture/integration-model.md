# Integration model

## Capability-first integration

AAO canonicalizes capabilities, not whole enterprise schemas. Workflows use provider-neutral capabilities such as `crm.search_accounts`, `crm.get_account`, `email.create_draft`, `documents.search`, and `calendar.find_availability`.

They do not bind directly to vendor operation names such as `salesforce_query_sobject`, `hubspot_search_v3`, or `google_gmail_threads_list`.

```text
AAO capability → AAO provider boundary → implementation
                                         ├─ Salesforce
                                         ├─ HubSpot
                                         ├─ MCP
                                         ├─ Native API
                                         ├─ Internal system
                                         └─ Composio when evidence supports it
```

Provider-specific complexity stays behind adapters. AAO does not claim that all systems can be perfectly normalized. A vendor-specific capability may exist when genuinely necessary, but common operational work stays provider-neutral.

## Tool and provider boundaries

The AAO Tool Layer validates input and output, assigns namespaces and risk, enforces permissions and policy, invokes through controlled infrastructure, normalizes errors, and records audit metadata. A tool request from a model or agent is a proposal, not authority to invoke an external system.

Since Sprint 8 the Tool Runtime ([tool runtime](tool-runtime.md)) executes explicitly registered, trusted Tool bindings through one validated boundary, and since Sprint 9 every execution is authorized against a host-attested context ([authorization](authorization.md)). It does not resolve `capabilityRef`, and there is no general Integration Fabric or credential system. Sprint 10 adds an isolated MCP connector that supplies normal Tool handlers. The Integration Fabric will later create Tool bindings for normalized capabilities (`AAO Capability → Integration Fabric Adapter → AAO Tool Binding → Tool Runtime`).

## MCP role

MCP is a connector protocol, not the workflow engine. Sprint 10 implements only Tools through local stdio; resources, prompts, sampling, HTTP, and OAuth remain deferred. AAO retains host behavior, tool exposure, authorization, policy, approval, orchestration, state, traces, and evaluation. MCP access must not bypass the controlled tool path: MCP Tools become explicit host-owned AAO Tool bindings executed by the Tool Runtime (`MCP → AAO Tool Binding → Tool Runtime`), never `Agent → MCP` directly.

## Initial provider stance

Native capability adapters remain preferable for an initial critical provider where auditability and deterministic side effects matter. Composio needs a targeted, read-only real-provider spike before adoption. Nango remains deferred. See [ADR-000](../decisions/ADR-000-substrate-recommendation.md) for evidence and licensing context.

See [MCP connector](mcp-connector.md) and [ADR-015](../decisions/ADR-015-mcp-integration-boundary-and-tool-adapter-sessions.md): discovery is untrusted metadata; local `ToolSpec` and host-attested `AuthorizationContext` remain authoritative. Remote schema equivalence is not inferred. `capabilityRef` is carried without routing or resolution.
