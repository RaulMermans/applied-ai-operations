# Adapter contract

The public, versioned contract through which external substrates plug into AAO (Sprint 20, [ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md)). AAO semantics come first. The adapter contract sits below them, and providers, protocols, and runtimes sit below it. A provider never defines AAO behavior.

```text
                AAO SEMANTICS
   (Workflow · Governance · Approval · Durability · Trace · Evals)
                     │
                     ▼
              Adapter Contract  (@aao/adapters, contract v1)
          ┌──────────┼──────────┐
          ▼          ▼          ▼
        Model       Tool       Agent
       Adapter    Provider    Runtime
          │          │          │
          ▼          ▼          ▼
       provider    MCP       future (LangGraph: deferred)
```

## Packages

| Concept | Owner |
| --- | --- |
| Versions, kinds, capability catalog, `AdapterManifest`, `AdapterRef`, compatibility, conformance suite, report and integrity, matrix | `@aao/adapters`: vendor-free, depends on `@aao/contracts` and `zod` only |
| `ModelAdapter` port, `defineModelAdapter` | `@aao/model-runtime` |
| Vercel AI SDK adapter and manifest | `@aao/model-runtime/vercel-ai` (conformance subject: `/vercel-ai/conformance`) |
| MCP Tool provider and manifest | `@aao/mcp-connector` (conformance subject: `/conformance`) |
| Judging conformance evidence | `@aao/evaluation` (`evaluateAdapterConformance`) |
| Canonical harness, native references, `verifyAdapterConformance` | `@aao/framework/conformance` |

Execution packages depend on `@aao/adapters`, never on Evaluation. The Framework root re-exports only the stable concepts listed in ADR-025.

## The manifest is a claim

```ts
const manifest = defineAdapterManifest({
  id: "acme.model-adapter",
  version: "1.0.0", // exact; no ranges, no "latest"
  kind: "model",
  capabilities: [
    { capability: "model.text_generation", support: "supported" },
    { capability: "model.structured_output", support: "supported" },
    { capability: "model.usage", support: "supported" },
    { capability: "model.cancellation", support: "unsupported" }, // a truthful under-claim is allowed
    { capability: "model.tool_call_response", support: "unsupported" },
  ],
});
```

- **Strict and complete.** It is JSON-safe and deep-frozen, and every catalog capability of the kind is declared exactly once. Unknown fields fail with `ADAPTER_MANIFEST_INVALID`. That rules out handlers, credentials, module paths, permissions, identity, approval, retry or recovery safety, and support classes.
- **Versioned.** A different `adapterContractVersion` fails with `ADAPTER_CONTRACT_VERSION_UNSUPPORTED`.
- **Not authority.** It establishes no identity and grants nothing.
- **Fingerprint.** `adapterManifestFingerprint` is manifest identity, not a code signature.

## Capabilities (contract v1)

| Kind | Capability | Meaning |
| --- | --- | --- |
| model | `model.text_generation` | returns text output |
| model | `model.structured_output` | honors a structured-output JSON Schema (AAO re-validates either way) |
| model | `model.usage` | reports exact token usage |
| model | `model.cancellation` | forwards the invocation `AbortSignal` to the provider boundary |
| model | `model.tool_call_response` | surfaces provider tool calls, always mapped fail-closed to `unsupported_response` |
| tool_provider | `tool.discovery` | lists remote Tool metadata for a trusted host to bind (never authority) |
| tool_provider | `tool.execution` | executes a host-bound Tool through a canonical handler, with normalized failures |
| tool_provider | `tool.retryable_failure` | reports a transient failure as retryable (the host still decides retry safety) |
| agent_runtime | none | added only with a conformance-complete implementation |

`checkAdapterCompatibility({ manifest, requirements })` returns `compatible`, `missingCapabilities`, and `mismatches`. It is pure, deterministic, and selects nothing. **Compatibility is not security:** Governance, Authorization, the Tool support gate, and Approval decide what a Run may do.

## Ports

### Model

```ts
interface ModelAdapter {
  invoke(request: ModelAdapterRequest, context: { readonly signal: AbortSignal }): Promise<ModelAdapterResult>;
}
```

The adapter returns canonical success or a structured failure (`provider_error`, `unsupported_response`, `unparseable_output`). A thrown value is treated as `provider_error`, and the raw error is never exposed. The signal is the Runtime attempt's own:

```text
Runtime attempt (timeout) → AbortSignal → Model Node / Agent Runtime → Model Runtime → ModelAdapter → provider SDK
```

An already-aborted signal invokes nothing. The Agent Runtime starts no new iteration once the signal is aborted. A late result never commits.

### Tool provider

There is no separate execution port. A provider discovers, and the trusted host binds a canonical `ToolSpec` and registers a `RegisteredTool`. Execution always goes through the Tool Runtime:

```text
proposal → Tool Runtime → support gate → Authorization → input validation → provider → output validation
```

A provider can never execute around that path, widen a permission class, or make itself retry-safe or recovery-safe.

### Agent runtime

Defined as a kind with no capabilities and no active implementation. The native bounded Agent Runtime is the reference semantics.

## Conformance: claim → verification → evidence

```text
Manifest claim ──► canonical scenarios (selected by the claim) ──► real AAO Run per scenario
     ──► canonical Eval definitions (Evaluation Runtime) ──► AdapterConformanceReport v1 ──► generated matrix
```

| Outcome | Meaning |
| --- | --- |
| `PASSED` | claimed (or a base invariant) and every canonical case matched |
| `FAILED` | claimed and did not conform. A false claim is FAILED, never downgraded. |
| `UNSUPPORTED` | a required capability is declared unsupported (a truthful gap, not a pass) |
| `NOT_APPLICABLE` | the scenario belongs to another kind (not support) |

| Scenario | Kind | Requires |
| --- | --- | --- |
| `tool.success-structured-result` | tool_provider | `tool.execution` |
| `tool.unauthorized-blocked` | tool_provider | base invariant |
| `tool.unsupported-permission-blocked` | tool_provider | base invariant |
| `tool.failure-normalized` | tool_provider | `tool.execution` |
| `tool.transient-retry` (host-declared safe: one retry, 2 physical, 1 logical) | tool_provider | `tool.execution`, `tool.retryable_failure` |
| `tool.unsafe-default-no-retry` | tool_provider | `tool.execution` |
| `tool.discovery-metadata-non-authoritative` | tool_provider | `tool.discovery`, `tool.execution` |
| `model.structured-output` | model | `model.structured_output` |
| `model.identity-and-usage` | model | `model.text_generation`, `model.usage` |
| `model.provider-error-normalized` | model | `model.text_generation` |
| `model.tool-call-fail-closed` | model | `model.tool_call_response` |
| `model.attempt-timeout` | model | `model.text_generation` |
| `model.cancellation-propagated` (provider must observe the abort) | model | `model.text_generation`, `model.cancellation` |

Privacy is enforced on every running scenario. Seeded provider and server secrets must never appear in evidence (`ADAPTER_EVIDENCE_LEAK`). Reports carry identifiers, claims, outcomes, codes, and fingerprints only, and `validateAdapterConformanceReportIntegrity` rejects any self-attested field.

### Verifying a third-party adapter

```ts
import { verifyAdapterConformance, adapterConformancePassed } from "@aao/framework/conformance";
import { defineAdapterManifest } from "@aao/framework";
import { createAcmeModelAdapter } from "acme-aao-adapter";

const report = await verifyAdapterConformance({
  subject: {
    manifest: defineAdapterManifest({ /* the adapter's own claim */ }),
    sensitiveMarkers: ["acme-secret"],
    // A fresh adapter per scenario, scripted by the scenario's canonical parameters.
    prepare: (scenario) => {
      const fake = createScriptedAcmeProvider(scenario.parameters); // the author's deterministic provider stub
      return { adapter: createAcmeModelAdapter({ client: fake }), observations: () => ({ cancellationObserved: fake.sawAbort }) };
    },
  },
});
adapterConformancePassed(report); // "AAO conformance v1 PASS" only when true
```

There is no discovery and no module loading. The developer imports the adapter, the suite, and the verifier explicitly.

## The official matrix

`aao adapters matrix --format json|markdown` regenerates [the compatibility matrix](../framework/adapter-compatibility.md) (`docs/generated/adapter-compatibility.json`) from manifests and fresh conformance reports. A test fails if the committed artifacts drift. The matrix is documentation evidence with `authority: "none"`. LangGraph appears only as `DEFERRED`.
