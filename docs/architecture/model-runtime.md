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
AAO Model Adapter       ModelAdapter.invoke(AAO data) — invoked exactly once
      ↓
Vercel AI SDK           generateText (+ Output.object(jsonSchema(...)) for structured), maxRetries: 0
      ↓
Injected model          any AI-SDK-compatible LanguageModel (ai/test in tests)
      ↓
Validated ModelResult   isJsonSafe + output-kind check + Ajv schema validation + ModelResultSchema
```

The single entry point is `executeModelRequest({ request, modelPolicyRef, policies, models })`, returning `{ ok: true, result } | { ok: false, failure }`.

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

Provider failures are reduced to an enumerated `reason`; no `Error.message`, stack, thrown value, URL, or header is ever copied into a failure. Inside a workflow, the Runtime further reduces a model node failure to its own redacted `NODE_EXECUTION_FAILED`.

## Model capability vs Integration capability

- **Model capability** — a property required from an inference endpoint: `model.text_generation`, `model.structured_output`. Declared on Model Registry bindings, required by `ModelPolicySpec.requiredCapabilities`, `ModelRequest.requiredCapabilities`, and the output mode.
- **Integration Fabric capability** (`CapabilitySpec`) — a business/system ability exposed to AAO: `crm.accounts.search`, `email.draft.create`.

They are related concepts but separate registries and runtime responsibilities. Models are never routed through `CapabilitySpec`.

## Determinism

- **Routing determinism** — guaranteed: same request, policy, binding definitions, and priorities always select the same binding, independent of registration order.
- **Generation determinism** — not claimed for real providers. Tests are deterministic only because they use `ai/test` models.

## Explicit non-goals (V1)

Agents, tools/tool calling, retries, fallback, adaptive/cost/quality routing, streaming, multimodal input, embeddings, model memory or conversation persistence, caching, prompt DSL/templating, live provider configuration and credentials, and live provider calls in tests or CI.
