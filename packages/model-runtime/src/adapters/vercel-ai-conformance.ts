// Vercel AI SDK model adapter — official conformance subject (Sprint 20,
// ADR-025). An explicit package export ("@aao/model-runtime/vercel-ai/conformance"),
// never loaded by the package root.
//
// It drives the production `createVercelAiModelAdapter` with the SDK's own
// deterministic `MockLanguageModelV3` (ai/test). There is no provider, no
// credentials, and no network. The provider-shaped responses stay inside
// this module. The AAO conformance host runs the canonical workflow, and
// only canonical AAO evidence and two boundary observations leave it: how
// many provider calls were made, and whether the provider saw the abort.
import { MockLanguageModelV3 } from "ai/test";
import type { AdapterConformanceScenario, AdapterManifest } from "@aao/adapters";
import type { ModelAdapter } from "../types.js";
import { VERCEL_AI_SDK_ADAPTER_MANIFEST, createVercelAiModelAdapter } from "./vercel-ai.js";

const PROVIDER_SECRET = "sk-live-SECRET https://api.example.com/v1?key=abc";

interface ModelParameters {
  outcome: string;
  usage: { inputTokens: number; outputTokens: number };
  structuredOutput: unknown;
  textOutput: string;
}

function response(parameters: ModelParameters, content: unknown[], finish = "stop") {
  return {
    content,
    finishReason: { unified: finish, raw: finish },
    usage: {
      inputTokens: { total: parameters.usage.inputTokens, noCache: parameters.usage.inputTokens, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: parameters.usage.outputTokens, text: parameters.usage.outputTokens, reasoning: 0 },
    },
    warnings: [],
  };
}

export interface ModelConformancePreparation {
  adapter: ModelAdapter;
  observations(): { providerCalls: number; cancellationObserved: boolean };
}

export interface VercelAiConformanceSubject {
  readonly manifest: AdapterManifest;
  readonly sensitiveMarkers: readonly string[];
  prepare(scenario: AdapterConformanceScenario): ModelConformancePreparation;
}

/** The scripted provider for one scenario. Each scenario gets a fresh model, so observations never leak across scenarios. */
export function createVercelAiConformanceSubject(): VercelAiConformanceSubject {
  return Object.freeze({
    manifest: VERCEL_AI_SDK_ADAPTER_MANIFEST,
    // Seeded into provider errors and tool-call responses: none may reach AAO evidence.
    sensitiveMarkers: Object.freeze([PROVIDER_SECRET, "api.example.com", "toolName"]),
    prepare(scenario: AdapterConformanceScenario): ModelConformancePreparation {
      const parameters = scenario.parameters as unknown as ModelParameters;
      let providerCalls = 0;
      let cancellationObserved = false;
      const doGenerate = (options: { abortSignal?: AbortSignal }) => {
        providerCalls += 1;
        switch (parameters.outcome) {
          case "structured":
            return Promise.resolve(response(parameters, [{ type: "text", text: JSON.stringify(parameters.structuredOutput) }]));
          case "text":
            return Promise.resolve(response(parameters, [{ type: "text", text: parameters.textOutput }]));
          case "provider_error":
            return Promise.reject(Object.assign(new Error(PROVIDER_SECRET), { statusCode: 503, isRetryable: true }));
          case "tool_call":
            return Promise.resolve(response(parameters, [{ type: "tool-call", toolCallId: "call-1", toolName: "search", input: "{}" }], "tool-calls"));
          case "never_settles":
            return new Promise<never>(() => {});
          case "blocks_until_cancelled":
            return new Promise<never>((_resolve, reject) => {
              const signal = options.abortSignal;
              const onAbort = () => {
                cancellationObserved = true;
                reject(new Error(`aborted ${PROVIDER_SECRET}`));
              };
              if (signal?.aborted) onAbort();
              else signal?.addEventListener("abort", onAbort, { once: true });
            });
          default:
            return Promise.reject(new Error("unknown scripted outcome"));
        }
      };
      const model = new MockLanguageModelV3({ doGenerate: doGenerate as never });
      return { adapter: createVercelAiModelAdapter({ model }), observations: () => ({ providerCalls, cancellationObserved }) };
    },
  });
}
