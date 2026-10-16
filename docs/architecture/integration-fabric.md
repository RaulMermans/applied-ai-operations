# Integration Fabric

**Integration Fabric = externally connected capabilities, exposed as normal governed AAO Tools.**

It is how AAO reaches systems outside itself, such as the public web and, later, business systems. It does this without a second execution path:

```text
Workflow tool node → Tool Registry → Tool Runtime (support gate → Authorization → input schema)
   → integration Tool handler → host-supplied provider → normalization → output schema → Run state
```

| It is not | Because |
| --- | --- |
| the Tool Runtime | Integration Tools are `defineTool` definitions. Execution, Authorization, validation, Trace, and reliability stay the Tool Runtime's. |
| the adapter contract | A provider port inside an integration package is a narrow domain port, not an `AdapterManifest` and not a new adapter kind ([ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md)). |
| the Toolbox | The Toolbox is provider-neutral computation with no external access ([ADR-026](../decisions/ADR-026-toolbox-foundation.md)), and it never depends on an integration. |
| a Capability Pack | A pack is a reusable business operation (Sprint 26). Integrations expose operations such as search and fetch, never `research_company`. |

## Rules

- **Host-injected providers.** An integration package names no vendor SDK. Trusted host code supplies the provider, along with its credentials and network policy.
- **AAO owns the contract.** Bounds, schemas, Tool identity, permission classes, retry safety, normalization, failure codes, and identifiers are defined by the integration package, never by provider responses.
- **Provider data is untrusted.** Only known fields are read. Nothing a provider returns can grant permission, name a principal, change retry behavior, approve, or instruct a model.
- **Bounded budgets.** Every Tool execution has a derivable maximum number of provider calls.
- **No governance or retry machinery.** Integrations implement no Authorization, Approval, Run lifecycle, or retry loop.
- **Offline CI.** Required tests use deterministic fixture providers: no network or credentials.
- **Dependency direction.** Integration → `@aao/framework` → Core. No Core package, and not the Toolbox, depends on an integration.

## Capabilities

| Package | Tools | Since |
| --- | --- | --- |
| [`@aao/integration-public-web`](../../packages/integration-public-web/README.md) | `public_web.search@1.0.0`, `public_web.fetch_pages@1.0.0` (`read_only`) | Sprint 22, [ADR-027](../decisions/ADR-027-company-research-proof.md) |
| [`@aao/integration-documents`](../../packages/integration-documents/README.md) | `document.extract_text@1.0.0` (`read_only`) | Sprint 23, [ADR-028](../decisions/ADR-028-document-intelligence-proof.md) |

MCP Tools ([MCP connector](mcp-connector.md)) follow the same principle through `createMcpToolBinding`. Future connectors start narrow, one capability at a time; there is no generic `@aao/integrations` framework.
