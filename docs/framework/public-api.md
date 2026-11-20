# Public API inventory (Local V1)

Supported consumer entry points. Adding or removing a root export is a deliberate, snapshot-tested change.

## `@aao/framework`

Value exports (API version `AAO_FRAMEWORK_API_VERSION = 1`):

`AAOFrameworkError`, `AAO_ADAPTER_CONTRACT_VERSION`, `AAO_FRAMEWORK_API_VERSION`, `AdapterContractError`, `checkAdapterCompatibility`, `createAAO`, `defineAdapterManifest`, `defineAgent`, `defineEval`, `defineGovernance`, `defineModelAdapter`, `defineModelPolicy`, `defineTool`, `defineWorkflow`.

Subpath `@aao/framework/conformance`: adapter conformance verification.

CLI (`aao`): `workflow validate|compile`, `eval ci|adapters|baseline propose`, `adapters matrix`, `inspect …`. There is no `aao run`.

**Host responsibilities:** `principalForRun` (or a company-host `trustedIdentity`), Tool handlers, optional model adapters/bindings/policies/agents/deterministic executors, optional Trace/Audit ports.

**Supported node kinds through `createAAO`:** `tool`, `approval`, `model`, `agent`, `deterministic`, `final_output`. `evaluator` nodes are refused at preparation.

**Supported Tool permission classes that can execute:** `read_only`, `write_draft`. Other classes fail closed at the Tool Runtime support gate.

`createAAO()` is not an authentication system. Hardened actor tokens and persistent Run bindings exist on `createCompanyAAO({ trustedIdentity })` in the company-portability proof, not on every Framework app.

## `@aao/adapters`

Vendor-free adapter envelope: contract version, kinds (`model`, `tool_provider`, `agent_runtime`), capability catalog, `AdapterManifest`, compatibility check, conformance vocabulary. Concrete adapters are not exported here.

## `@aao/toolbox`

`defineToolbox`, `coreToolbox` (`aao.core@1.0.0`), catalog helpers, `selectToolboxTools`. Metadata is not authority. Six `read_only` Tools: `text.normalize`, `text.chunk`, `records.dedupe`, `records.project`, `records.sort`, `records.count_by`.

## `@aao/capability-packs`

`defineCapabilityPack`, `createCapabilityPackCatalog`, `validatePackCompatibility`, `validateCompanyPackSelection`, and the three canonical packs:

- `aao.company-research@1.0.0`
- `aao.document-intelligence@1.0.0`
- `aao.operational-request@1.0.0`

Pack metadata cannot grant permission or skip Authorization.

## Failure behavior

Preparation failures throw `AAOFrameworkError`. Execution failures are canonical `WorkflowExecutionResult` values (`TOOL_AUTHORIZATION_DENIED`, `APPROVAL_REJECTED`, `RUNTIME_PREFLIGHT_FAILED`, …). Missing inspection evidence is `UNKNOWN` / `NOT_VERIFIED` / `UNAVAILABLE`, never inferred success.
