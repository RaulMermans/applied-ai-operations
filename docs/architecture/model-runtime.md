# Model Runtime

`@aao/model-runtime` (`packages/model-runtime`) is AAO's provider-neutral model execution layer (Sprint 6, [ADR-011](../decisions/ADR-011-model-runtime-and-capability-routing.md)). **AAO defines what model execution means; the AI SDK only performs the provider interaction.**

## Model execution path

```text
ModelRequest            validateModelRequest: isJsonSafe + ModelRequestSchema + strict JSON Schema compile
      ↓
ModelPolicy             ModelPolicyRegistry.get(modelPolicyRef) — canonical ModelPolicySpec; non-empty constraints fail closed
      ↓
Capability Router       deriveRequiredCapabilities → selectModelBinding (filter → priority desc → id asc)
      ↓
Registered Model Binding
      ↓
AAO Model Adapter       ModelAdapter.invoke(AAO data, { signal }) — invoked exactly once; signal = the caller's cancellation lineage
      ↓
Vercel AI SDK           generateText (+ Output.object(jsonSchema(...)) for structured), maxRetries: 0, abortSignal: signal
      ↓
Injected model          any AI-SDK-compatible LanguageModel (ai/test in tests)
      ↓
Validated ModelResult   isJsonSafe + output-kind check + Ajv schema validation + ModelResultSchema
```

The single entry point is `executeModelRequest({ request, modelPolicyRef, policies, models, signal? })`, returning `{ ok: true, result } | { ok: false, failure }`.

## Workflow path

```text
Workflow model Node     config: { modelPolicyRef, requestStateKey, resultStateKey }
      ↓
Runtime Node Registry   caller registers createModelNodeExecutor({ models, policies }) explicitly
      ↓                 (preflight calls its validateConfig before any node runs)
Model Node Executor     reads RunState.values[requestStateKey]
      ↓
Model Runtime           executeModelRequest
      ↓
State patch             { [resultStateKey]: ModelResult }
      ↓
AAO Runtime             validates + applies patch, revision + 1; on failure node FAILED, Run FAILED, no patch
```

The prompt is not constructed here: a prior deterministic node, intake layer, or caller prepares the `ModelRequest` in state. There is no prompt-template language.

## Contracts

| Contract | Shape (V1) |
| --- | --- |
| `ModelMessage` | `{ role: "system" \| "user" \| "assistant", content: non-empty string }` |
| `ModelRequest` | `{ schemaVersion: 1, invocationId, messages (≥1, incl. a user message), output, requiredCapabilities?, maxOutputTokens? }` |
| `output` | `{ kind: "text" }` or `{ kind: "structured", schema: <JSON Schema, top-level object>, name? }` |
| `ModelResult` | `{ schemaVersion: 1, invocationId, modelBindingId, outputKind, output, finishReason?, usage? }` |
| `finishReason` | `stop \| length \| content_filter \| other` |
| `usage` | `{ inputTokens?, outputTokens?, totalTokens? }` — only when reliably reported; no cost |
| `ModelFailure` | `{ code, message, invocationId?, modelBindingId?, details? }` |

Everything is JSON-safe and JSON round-trips; registries and adapters are live dependencies and never appear in requests, results, state, or snapshots. `invocationId` is caller-owned.

## Failures

| Code | When | Adapter invoked? |
| --- | --- | --- |
| `INVALID_MODEL_REQUEST` | request not JSON-safe, schema-invalid, or structured schema not a valid strict JSON Schema | no |
| `MODEL_POLICY_NOT_FOUND` | `modelPolicyRef` not registered | no |
| `UNSUPPORTED_MODEL_POLICY_CONSTRAINTS` | policy has non-empty `constraints` | no |
| `MODEL_ROUTE_NOT_FOUND` | no binding declares every required capability | no |
| `MODEL_INVOCATION_FAILED` | adapter threw or reported `provider_error` | once |
| `INVALID_MODEL_RESULT` | malformed adapter result, non-JSON-safe output, wrong output kind, unsupported response (e.g. tool calls), unparseable output | once |
| `MODEL_OUTPUT_SCHEMA_MISMATCH` | structured output violates the requested schema | once |

Provider failures are reduced to an enumerated `reason`; no `Error.message`, stack, thrown value, URL, or header is ever copied into a failure. Inside a workflow, the model node returns the Runtime's safe executor-failure result `{ ok: false, failure: { namespace: "model", code } }` (Sprint 7), so the Runtime reports `NODE_EXECUTION_FAILED` with `executorFailure: { namespace: "model", code: "MODEL_ROUTE_NOT_FOUND" }` (for example) — only the code crosses into the Runtime, never the failure's message or details.

## Model capability vs Integration capability

- **Model capability** — a property required from an inference endpoint: `model.text_generation`, `model.structured_output`. Declared on Model Registry bindings, required by `ModelPolicySpec.requiredCapabilities`, `ModelRequest.requiredCapabilities`, and the output mode.
- **Integration Fabric capability** (`CapabilitySpec`) — a business/system ability exposed to AAO: `crm.accounts.search`, `email.draft.create`.

They are related concepts but separate registries and runtime responsibilities. Models are never routed through `CapabilitySpec`.

## Determinism

- **Routing determinism** — guaranteed: same request, policy, binding definitions, and priorities always select the same binding, independent of registration order.
- **Generation determinism** — not claimed for real providers. Tests are deterministic only because they use `ai/test` models.

## Consumers

The `model` node (one invocation per node) and, since Sprint 7, the bounded Agent Runtime (`@aao/agent-runtime`), which calls `executeModelRequest` once per Agent iteration with a structured `AgentDecision` output — see [agent runtime](agent-runtime.md). Agents use only this package's entry point; they never import the AI SDK adapter.

## Explicit non-goals (V1)

Agent loops inside Model Runtime, tools/tool calling, retries, fallback, adaptive/cost/quality routing, streaming, multimodal input, embeddings, model memory or conversation persistence, caching, prompt DSL/templating, live provider configuration and credentials, and live provider calls in tests or CI.

## Trace and binding identity (Sprint 15)

`ModelBinding` accepts optional trusted `identity: { provider, model, revision? }` registration metadata. It is never parsed from a binding id or derived from output. `executeModelRequest` accepts an optional `ModelInvocationObserver`, called only around an actual adapter invocation. The model node maps it to these events:

- `model.call.started`: invocation, policy, binding, output kind, required capabilities, and identity if registered.
- `model.call.completed`: finish reason and token usage.
- `model.call.failed`: the safe Model failure code.

Messages, output, provider errors, URLs, and headers are never traced. No prompt version or cost is fabricated. See [trace runtime](trace-runtime.md).

## Adapter contract (Sprint 20)

`ModelAdapter` is the public `model` adapter port ([ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md), [adapter contract](adapter-contract.md)). This package is its single owner.

- **Invocation context.** `invoke(request, context)` always receives `{ signal }`.
  - The `model` node passes the Runtime attempt's own signal, and the Agent Runtime passes its caller's. No layer creates its own timer.
  - An already-aborted signal invokes nothing (`MODEL_INVOCATION_FAILED`, `details.reason: "cancelled"`, and no model-call Trace).
  - An adapter that ignores the signal still cannot commit a late result.
  - Code that only implements `invoke` keeps compiling. Callers of `invoke` must pass the context.
- **`defineModelAdapter({ manifest, adapter })`** pairs the port with an `AdapterManifest` (kind `model`). It snapshots the manifest and captures `invoke`. A raw adapter in a low-level `ModelRegistry` claims no capability.
- **Vercel AI SDK.** `@aao/model-runtime/vercel-ai` exports `VERCEL_AI_SDK_ADAPTER_MANIFEST` (every model capability supported and verified) and `defineVercelAiModelAdapter({ model })`. Its conformance subject is the explicit `@aao/model-runtime/vercel-ai/conformance` export, which uses the SDK's `ai/test` model and is never loaded by the root.
- **Binding vs adapter capabilities.** Binding capabilities (`model.text_generation`, `model.structured_output`) stay the routing vocabulary. `@aao/framework` requires every capability a binding declares to be declared supported by its adapter's manifest.
