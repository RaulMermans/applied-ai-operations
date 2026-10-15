// The native AAO reference subjects (Sprint 18 semantics, Sprint 20 public
// shape). They are what every substrate is compared against: a plain
// trusted Tool handler under the Tool Runtime, and a plain host
// `ModelAdapter` with no SDK. They are reference semantics, not
// production integrations.
import { defineAdapterManifest, type AdapterConformanceScenario, type ToolScenarioOutcome } from "@aao/adapters";
import type { ModelAdapter, ModelAdapterResult } from "@aao/model-runtime";
import type { ToolHandler } from "@aao/tool-runtime";
import type { ModelConformanceSubject, ToolProviderConformanceSubject, ToolProviderHostBinding } from "./harness.js";

const PROVIDER_SECRET = "native-provider-secret sk-native-DO-NOT-LEAK";

/** The native Tool reference: Tool Runtime plus a trusted local handler. It has no remote discovery. */
export const NATIVE_TOOL_REFERENCE_MANIFEST = defineAdapterManifest({
  id: "aao.native-tool",
  version: "1.0.0",
  kind: "tool_provider",
  displayName: "AAO native Tool reference (local handler)",
  capabilities: [
    { capability: "tool.discovery", support: "unsupported" },
    { capability: "tool.execution", support: "supported" },
    { capability: "tool.retryable_failure", support: "supported" },
  ],
  limitations: [{ code: "reference.semantics_only", description: "The semantic reference for Tool-provider conformance, not an integration." }],
});

/** The native model reference: a plain host adapter that honors the invocation signal. It has no tool-call channel. */
export const NATIVE_MODEL_REFERENCE_MANIFEST = defineAdapterManifest({
  id: "aao.native-model",
  version: "1.0.0",
  kind: "model",
  displayName: "AAO native model reference (plain ModelAdapter)",
  capabilities: [
    { capability: "model.text_generation", support: "supported" },
    { capability: "model.structured_output", support: "supported" },
    { capability: "model.usage", support: "supported" },
    { capability: "model.cancellation", support: "supported" },
    { capability: "model.tool_call_response", support: "unsupported" },
  ],
  limitations: [{ code: "reference.semantics_only", description: "The semantic reference for model conformance, not a provider integration." }],
});

export function nativeToolReference(): ToolProviderConformanceSubject {
  return Object.freeze({
    manifest: NATIVE_TOOL_REFERENCE_MANIFEST,
    sensitiveMarkers: Object.freeze([PROVIDER_SECRET]),
    async prepare(scenario: AdapterConformanceScenario, host: ToolProviderHostBinding) {
      const parameters = scenario.parameters as { outcomes: ToolScenarioOutcome[]; expectedOutput: { name: string } };
      let calls = 0;
      const handler: ToolHandler = {
        async execute({ input }) {
          const outcome = parameters.outcomes[Math.min(calls, parameters.outcomes.length - 1)];
          calls += 1;
          if (outcome === "failure") return { ok: false, code: "HANDLER_REPORTED_ERROR" };
          if (outcome === "transient_failure") return { ok: false, code: "UPSTREAM_UNAVAILABLE", retryable: true };
          return { ok: true, output: { id: (input as { accountId: string }).accountId, name: parameters.expectedOutput.name } };
        },
      };
      // Exactly the host's spec and retry safety: the reference adds nothing.
      return { tool: { spec: host.spec, handler, retrySafety: host.retrySafety }, dispose: async () => undefined };
    },
  });
}

export function nativeModelReference(): ModelConformanceSubject {
  return Object.freeze({
    manifest: NATIVE_MODEL_REFERENCE_MANIFEST,
    sensitiveMarkers: Object.freeze([PROVIDER_SECRET]),
    prepare(scenario: AdapterConformanceScenario) {
      const parameters = scenario.parameters as { outcome: string; outputKind: string; structuredOutput: unknown; textOutput: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } };
      let cancellationObserved = false;
      const adapter: ModelAdapter = {
          async invoke(_request, context): Promise<ModelAdapterResult> {
            switch (parameters.outcome) {
              case "provider_error":
                throw new Error(PROVIDER_SECRET);
              case "never_settles":
                return new Promise<never>(() => {});
              case "blocks_until_cancelled":
                return new Promise<ModelAdapterResult>((resolve) => {
                  const onAbort = () => {
                    cancellationObserved = true;
                    resolve({ status: "failed", reason: "provider_error" });
                  };
                  if (context.signal.aborted) onAbort();
                  else context.signal.addEventListener("abort", onAbort, { once: true });
                });
              default:
                return { status: "succeeded", output: parameters.outputKind === "structured" ? parameters.structuredOutput : parameters.textOutput, finishReason: "stop", usage: parameters.usage };
            }
          },
      };
      return { adapter, observations: () => ({ cancellationObserved }) };
    },
  });
}
