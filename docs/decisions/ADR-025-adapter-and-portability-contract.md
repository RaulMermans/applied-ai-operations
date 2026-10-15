# ADR-025: Adapter and portability contract

Status: accepted

## Context

By Sprint 19, AAO could verify that the Vercel AI SDK and MCP substrates produce the same canonical evidence as AAO's native references (ADR-023). It could also expose a public façade (ADR-024). The adapter seam itself was still internal:

- `ModelAdapter` had no cancellation channel. A Runtime attempt timeout abandoned the attempt but never reached the provider.
- Conformance drivers were test-owned `.mjs` modules that the CLI loaded by repository-relative path. Each driver declared its own `SUPPORTED`/`UNSUPPORTED` table. A claim and its verification were the same word.
- There was no manifest, capability catalog, contract version, or compatibility evidence a host could check before execution.
- `@aao/framework` refused `model`, `agent`, and `deterministic` nodes.
- MCP had no retry safety, so a read-only remote Tool could never be retried, even when the host knew that was safe.
- `continueWaitingWorkflow` mutated the caller's `RuntimeExecutionState`.

Sprint 20 had to make this true: *AAO workflows, governance, evaluation, and durability are defined independently of model providers, Tool protocols, and agent runtimes. External substrates plug in only through explicit, versioned, conformance-tested adapter contracts.*

## Inventory

Before deciding, every existing adapter-related concept was classified:

| Concept | Where | Decision |
| --- | --- | --- |
| `ModelAdapter`, `ModelAdapterRequest`, `ModelAdapterResult` | `@aao/model-runtime` | **KEEP**, the single public `model` port. MIGRATE to v1 with the invocation context (`signal`). |
| `ModelBinding`, `ModelRegistry`, `ModelPolicyRegistry`, capability routing | `@aao/model-runtime` | **KEEP**. The Framework composes them. It builds no second registry or router. |
| `MODEL_CAPABILITIES` (binding/endpoint capabilities) | `@aao/model-runtime` | **KEEP**. These are distinct from adapter capabilities, and a binding's capabilities must be declared supported by its adapter. |
| Vercel AI SDK adapter | `@aao/model-runtime/vercel-ai` | **KEEP** in place (no package rename). MIGRATE to forward `signal` and to ship `VERCEL_AI_SDK_ADAPTER_MANIFEST`. |
| `@aao/mcp-connector`, `createMcpToolBinding` | `@aao/mcp-connector` | **KEEP**. MIGRATE to add host-owned `retrySafety`, a retryable transient-failure signal, and `MCP_CONNECTOR_ADAPTER_MANIFEST`. |
| `retrySafety`, `idempotency`, `recoverySafety`, `toolRecoverySafety` | contracts / Tool Runtime / Runtime | **KEEP** as the one safety vocabulary. No `McpRetrySafety`. |
| Sprint 18 scenarios, `verifyAdapter`, `AdapterVerificationDriver`, `ScenarioSupport` (`SUPPORTED`) | `@aao/evaluation` | **REPLACE** with scenarios in `@aao/adapters` (capability-gated) and `evaluateAdapterConformance` driven by a manifest. `SUPPORTED` as an outcome is DELETED. |
| Sprint 18 `AdapterConformanceReport` (internal) | `@aao/evaluation` | **REPLACE** with the public `AdapterConformanceReport` v1 plus integrity validation. |
| Test-owned drivers (`tool-runtime/conformance`, `model-runtime/conformance`, `mcp-connector/conformance/driver.mjs`) | repository paths | **DELETE**. Official subjects become explicit package exports. The native references and the canonical harness move to the conformance host. |
| `evals/definitions/adapter-conformance.v1.yaml`, `evals/datasets/adapter-conformance-foundation.v1.yaml` | `evals/` | **MIGRATE** into `@aao/adapters` as the canonical conformance suite (package data). |
| `@aao/substrate-contracts` `ModelExecutor`, `DurableExecutor`, `CrmCapability`; `@aao/substrate-spikes` | Sprint 0A | **KEEP_AS_HISTORICAL_EVIDENCE**. These are not contracts, and nothing in Sprint 20 imports them. |
| LangGraph | Sprint 0A research | **DEFERRED**. There is no adapter, and none is invented. |

## Decision

### One owner per concept

- **`@aao/adapters` is the canonical adapter-contract package.** It is vendor-free and depends only on `@aao/contracts` and `zod`. It owns the contract and conformance versions, the kind taxonomy, the capability catalog, `AdapterManifest` V1, exact `AdapterRef`s, `checkAdapterCompatibility`, the canonical conformance suite (scenarios, Eval definitions, dataset), the conformance vocabulary, `AdapterConformanceReport` V1 with `validateAdapterConformanceReportIntegrity`, and the generated compatibility matrix.
- **Executable ports stay with their kind's owner.** `ModelAdapter` stays in `@aao/model-runtime`, which owns `ModelRequest`/`ModelResult` semantics. Moving it would have created a second home for those. `defineModelAdapter` (also in `@aao/model-runtime`) pairs the port with a manifest. A Tool provider's port is the Tool Runtime's canonical `RegisteredTool`.
- **Judging is Evaluation's job, and running is the host's.** `evaluateAdapterConformance` lives in `@aao/evaluation` and judges evidence a host-side driver produced. The canonical harness, which runs a real AAO Run per scenario, and the native references live in the explicit `@aao/framework/conformance` subpath, together with the public `verifyAdapterConformance`. This deliberately departs from putting `verifyAdapterConformance` in `@aao/adapters`. Execution packages depend on `@aao/adapters`, and the invariant "no execution package depends on Evaluation" (ADR-022) must hold transitively.

Dependency direction:

```text
@aao/contracts ← @aao/adapters ← @aao/model-runtime, @aao/mcp-connector, @aao/evaluation ← @aao/framework
```

`@aao/adapters` never imports a vendor SDK, a protocol SDK, an execution package, or Evaluation. A static test enforces this.

### Versioning

- **`AAO_ADAPTER_CONTRACT_VERSION = 1`.** It is independent of `AAO_FRAMEWORK_API_VERSION`, a Workflow `schemaVersion`, a Tool version, and adapter package semver. Any other declared version fails as `ADAPTER_CONTRACT_VERSION_UNSUPPORTED` at definition or registration. There is no compatibility guessing.
- **`AAO_ADAPTER_CONFORMANCE_VERSION = 1`.** The suite (scenarios, definitions, dataset `aao.adapter-conformance@1.0.0`, and the claim → outcome rules) is versioned. A report records the suite version it ran. "AAO conformance v1 PASS" may be claimed only for a *complete* report of that exact suite for the adapter's own manifest (`adapterConformancePassed(report, manifest)`). See [Integrity is not completeness](#integrity-is-not-completeness-sprint-20-closure).

### Kinds: one envelope, kind-specific ports

`model`, `tool_provider`, and `agent_runtime` share a manifest envelope. There is no universal `Adapter.execute(any)`.

- **MCP is a `tool_provider`, permanently.** It is never a workflow runtime, agent runtime, or governance, authorization, approval, or durability provider.
- **`agent_runtime` has an empty capability catalog.** The native bounded Agent Runtime is the reference semantics. A future LangGraph adapter must map to AAO behavior, never the reverse. LangGraph stays deferred.

### AdapterManifest V1: metadata, not authority

- **Shape.** The manifest is strict, JSON-safe, deep-frozen, and canonically ordered: `schemaVersion`, `adapterContractVersion`, `id`, exact `version` (`MAJOR.MINOR.PATCH`), `kind`, optional `displayName`, `capabilities`, and optional informational `limitations`.
- **No executable or secret content.** Unknown fields are rejected, so the manifest has no handlers, credentials, SDK objects, module paths, or dynamic-import targets. The host imports code, and the manifest only describes it.
- **Complete declarations.** Every capability of the kind's catalog is declared exactly once, as `supported` or `unsupported`. Free-form prose never decides behavior.
- **Never authority.** A manifest grants no permission and establishes no identity. It cannot set a Principal, Role, permission class, Approval, retry or recovery safety, or Tool support class. Those fields are schema-invalid.
- **Fingerprint.** `adapterManifestFingerprint` hashes the semantic fields only. It is *manifest identity*, not a code signature. Code attestation, SBOMs, and signing are deferred to Sprint 29.

### Capability catalog (contract v1)

Names are AAO semantics, never provider constructs. Only behavior AAO implements and conformance verifies is listed:

- **model:** `model.text_generation`, `model.structured_output`, `model.usage`, `model.cancellation`, `model.tool_call_response` (always mapped fail-closed).
- **tool_provider:** `tool.discovery`, `tool.execution`, `tool.retryable_failure` (report a transient failure, never decide a retry).

`checkAdapterCompatibility` is pure and deterministic, and involves no model. It checks kind, contract version, exact identity, and a supported superset of the required capabilities. **Compatibility is not authorization.** A compatible adapter can still be unauthorized for a Run.

### Claim versus verification

- **Manifest = declaration, conformance report = evidence.** The public outcomes are `PASSED`, `FAILED`, `UNSUPPORTED`, and `NOT_APPLICABLE`. There is no `SUPPORTED` outcome.
- **Scenario selection** (`scenarioClaim`):
  - A scenario of another kind is `NOT_APPLICABLE`.
  - One requiring nothing is a base invariant and always runs. Authorization blocking and the unsupported-class gate are base invariants.
  - Otherwise a scenario runs only when every capability it requires is declared supported. A declared-`unsupported` requirement makes it `UNSUPPORTED`. Conformance never infers support.
- **A false claim is FAILED, never downgraded.** For example, `model.cancellation` declared supported while the provider ignores the signal fails with `ADAPTER_BOUNDARY_UNOBSERVED`. Evidence leaks and driver errors also fail.
- **Reports never self-attest.** `validateAdapterConformanceReportIntegrity` recomputes every scenario outcome from its claim, cases, and findings, the summary, and the fingerprint, and can bind the report to its manifest.
- **Integrity is not completeness.** See the closure amendment below. A PASS requires full conformance, not only integrity.
- **The matrix is generated, never authority.** `buildAdapterCompatibilityMatrix` accepts only complete reports for their manifests and derives every cell from scenario outcomes. Its `authority` is `"none"`, and it cannot enable, authorize, or grant anything. LangGraph is listed as `DEFERRED`, outside the conformance vocabulary. The committed artifacts (`docs/generated/adapter-compatibility.json`, `docs/framework/adapter-compatibility.md`) are regenerated by `aao adapters matrix`, and a test fails on drift.

### Integrity is not completeness (Sprint 20 closure)

Conformance integrity and conformance completeness are separate checks. Internal report consistency does not prove complete AAO conformance. An intact report with no scenarios has `failed = 0`, and so does one that ran a convenient subset, narrowed a scenario's `requires`, or rewrote its own claim.

- **Report integrity** (`validateAdapterConformanceReportIntegrity`): the report is internally consistent. Every scenario's status follows from its claim, cases, and findings, the summary from the scenarios, and the fingerprint from the content. With a manifest, adapter identity and manifest fingerprint match. It says nothing about *which* scenarios ran.
- **Full conformance** (`validateCompleteAdapterConformanceReport(report, manifest)`): integrity, plus the canonical dataset id and version, exactly the canonical scenario set of the manifest's kind (no missing scenario, no extra scenario, and none from another kind), each scenario's canonical `requires`, the exact canonical cases and expectations of each scenario that ran, and each claim equal to `scenarioClaim(manifest, canonical scenario)`. The scenario set comes only from `conformanceScenariosForKind` over `ADAPTER_CONFORMANCE_SCENARIOS`, the single registry. A kind with no canonical scenario (`agent_runtime` today) can never be complete.
- **PASS** (`adapterConformancePassed(report, manifest)`): full conformance, no `FAILED` scenario, and at least one `PASSED` scenario. Zero scenarios, a partial report, a self-selected subset, or a self-downgraded claim never pass, and a report that verified nothing does not pass vacuously.
- **Distinct codes.** `ADAPTER_CONFORMANCE_REPORT_INVALID` (integrity), `ADAPTER_CONFORMANCE_DATASET_MISMATCH`, `ADAPTER_CONFORMANCE_SCENARIO_MISSING`, `ADAPTER_CONFORMANCE_SCENARIO_UNEXPECTED`, `ADAPTER_CONFORMANCE_SCENARIO_MISMATCH`, `ADAPTER_CONFORMANCE_CLAIM_MISMATCH`, and `ADAPTER_CONFORMANCE_INCOMPLETE`.
- **Partial runs stay supported.** `verifyAdapterConformance({ subject, scenarios })` still returns an intact report for local inspection. Its partiality is derived by the completeness check, not stored in the report, so the report schema and fingerprints are unchanged. The fingerprint already commits to scenario ids, `requires`, claims, cases, outcomes, and the dataset.
- **Consumers.** The compatibility matrix refuses any incomplete report (with its completeness code), so a partial report can never produce a green cell. `aao eval adapters` passes only if every official report passes `adapterConformancePassed` for its manifest.
- **Limit.** Completeness checks coverage and claims against the canonical suite. It cannot re-run grading from a serialized report. Case verdicts are evidence the Evaluation Runtime produced, and the official matrix is always regenerated from fresh runs.

### Registration

- **Explicit, exact, construction-time.** Adapters are registered explicitly at construction by exact `id@version`. A duplicate, whatever its content, fails (`ADAPTER_DUPLICATE`). Distinct exact versions may coexist, and a binding names one `adapterRef`, with no implicit latest.
- **No discovery or loading.** There is no runtime discovery (node_modules scans, environment, cwd plugins), no arbitrary module loading, no `aao adapters verify ./module.js`, and no marketplace or global registry.
- **No autonomous selection.** Selection is the existing deterministic Model Policy routing, unchanged. There is no LLM-chosen provider, cost-based switching, or Framework-level fallback.

### ModelAdapter v1 and cancellation

- **The signal is always present.** `invoke(request, { signal })` always carries the caller's signal. This is a deliberate, compile-visible change for code that *calls* `invoke`. Code that only *implements* it keeps compiling. A raw adapter without a manifest claims no capability.
- **One lineage.** The Runtime attempt's `AbortSignal` passes unchanged through the Model Node or Agent Runtime and Model Runtime to the adapter. No layer creates its own timer. An already-aborted signal invokes nothing (`MODEL_INVOCATION_FAILED`, reason `cancelled`, and no model-call Trace).
- **Agent and provider.** The native Agent Runtime checks the signal before every iteration (`AGENT_CANCELLED`), with no new iteration and no cleanup loop. The Vercel adapter forwards it to the SDK's `abortSignal`, and conformance proves the provider observes the abort.
- **Late results.** A late result remains non-authoritative (Sprint 13).
- **Cancellation without a timeout.** The Runtime cancels in-flight work only at the attempt-timeout boundary. Explicit Run cancellation is applied at safe boundaries (Sprint 14). This sprint does not claim mid-call cancellation of a Run.
- **Failures stay canonical.** Adapter failures are `MODEL_INVOCATION_FAILED`, `INVALID_MODEL_RESULT`, `NODE_ATTEMPT_TIMEOUT`, and the like. Adapter-contract errors cover declaration and registration only.

### Tool providers and MCP safety

- **No route around the Tool Runtime.** The provider's job is to discover, after which the host binds a canonical `ToolSpec`, registers it in the Tool Registry, and executes it through the Tool Runtime (support gate → Authorization → validation → provider).
- **Remote metadata is non-authoritative.** It may describe a name, description, or schemas. It never determines a permission class, retry or recovery safety, idempotency, identity, or Approval. Discovery drops annotations and `_meta`.
- **Retry safety comes only from the host.** `createMcpToolBinding({ retrySafety })` is the only way an MCP Tool becomes retryable. It defaults to `unsafe`, accepts `safe` only for `read_only`, and is never inferred from names, descriptions, annotations, or HTTP verbs. It maps into the canonical `retrySafety`. A server-side internal error or request timeout is reported as retryable, and the Runtime retries only if the host declared the Tool safe.
- **Retry safety ≠ recovery safety.** Crash-recovery safety stays the Tool Runtime's canonical derivation. The connector does not forward `toolExecutionId`, so it refuses any `idempotency` assertion, and a `write_draft` MCP Tool is never recovery-safe.
- **No side-effect expansion.** No adapter can make `external_side_effect`, `destructive`, or `sensitive_data` executable.

### Framework

- **Root additions.** The root adds only stable concepts:
  - values: `AAO_ADAPTER_CONTRACT_VERSION`, `AdapterContractError`, `defineAdapterManifest`, `defineModelAdapter`, `checkAdapterCompatibility`;
  - types: the manifest, kind, capability, and ref types, `AdapterConformanceReport`, the `ModelAdapter` port types, `ModelBindingDefinition`, `AgentDefinition`, `DeterministicExecutor*`, `RuntimeTracePort`, `ReliabilityPolicy`, and `PrepareWorkflowOptions`.

  The root never exports a concrete vendor, and its import graph reaches no vendor, MCP, Evaluation, or `vercel-ai` subpath.
- **`createAAO` options.** It accepts `modelAdapters`, `modelBindings` (exact `adapterRef`), `modelPolicies`, `agents`, `deterministicExecutors`, and an optional emit-only `trace`. It composes the canonical registries and executors. Construction fails with bounded diagnostics (`ADAPTER_NOT_FOUND`, `ADAPTER_KIND_MISMATCH`, `ADAPTER_CAPABILITY_UNSUPPORTED`, `ADAPTER_DUPLICATE`, `ADAPTER_MANIFEST_INVALID`, `ADAPTER_CONTRACT_VERSION_UNSUPPORTED`) before any provider call.
- **Execution scope.** `model`, `agent`, and `deterministic` nodes now execute. `evaluator` stays refused. There is no second Model or Agent runtime, and Agents keep their bounds and get no Tool use.
- **Reliability per prepared Workflow.** `prepareWorkflow(workflow, { reliability })` passes trusted per-node `ReliabilityPolicy` to the Runtime, which validates it.
- **Tool-provider registration.** No general tool-provider registration exists in Framework V1. MCP bindings are created in `@aao/mcp-connector` and registered as ordinary Tools (`defineTool`). A generic provider port would have been an over-generalized abstraction.

### Deterministic executors are not adapters

`deterministic` nodes reference trusted host code by exact `config.executorRef` (`createDeterministicNodeExecutor` in `@aao/runtime`). The node config, not the DSL schema, carries the reference, as `toolRef` does for Tools. Executors are registered at construction, and duplicates fail. They receive only identity, a frozen state copy, and the signal, and they propose a patch the Runtime validates. They are never retry- or recovery-safe.

### Continuation is non-mutating

`continueWaitingWorkflow` works on a detached copy and returns a new `RuntimeExecutionState`. It preserves Run and workflow identity, history, revision, approval references, and attempt counts. The fix is in Core, so `continueApprovedWorkflow` and `prepared.continue` inherit it. `resumeWorkflow` already cloned. The durable host rebuilds execution from its store and never receives caller input to mutate.

## Consequences

- **Truthful official matrix.** Native model, native Tool, Vercel AI SDK, and MCP pass every scenario they claim:
  - the native model declares no tool-call channel (`UNSUPPORTED`);
  - the native Tool has no discovery (`UNSUPPORTED`);
  - MCP now supports a host-declared retry;
  - Vercel cancellation reaches the provider.

  Semantic portability holds on 16 shared Tool cases and 9 shared model cases.
- **Portability proven end to end.** One vendor-free Workflow (deterministic → model → approval → Tool) runs unchanged under native bindings and under Vercel AI SDK + MCP bindings. It produces identical Workflow identity, trajectory, approval behavior, state shape, and semantic Eval verdicts.
- **Third-party verification.** A third-party adapter is verified with `@aao/framework/conformance`, with no repository paths. `aao eval adapters` no longer needs `--root` or the repository layout.
- **Unchanged.** No Trace schema, Audit, or Metrics change was needed. Adapter identity lives in conformance reports, not Trace.

## Not decided here

- a LangGraph (or any) `agent_runtime` adapter;
- a general Tool-provider port and Framework MCP registration;
- durable execution through `createAAO`;
- Audit pass-through;
- adapter code attestation, SBOMs, and signing (Sprint 29);
- a Toolbox (Sprint 21);
- company integrations;
- a Control Center or adapter UI;
- any marketplace or remote catalog.
