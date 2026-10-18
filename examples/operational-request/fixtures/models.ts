import {
  defineModelAdapter,
  type ModelAdapter,
  type ModelAdapterDefinition,
  type ModelAdapterRequest,
  type ModelAdapterResult,
  type ModelBindingDefinition,
} from "@aao/framework";
import { createVercelAiModelAdapter, VERCEL_AI_SDK_ADAPTER_MANIFEST } from "@aao/model-runtime/vercel-ai";
import { MockLanguageModelV3 } from "ai/test";

export interface ScriptedModelOptions {
  /** Replaces the generated proposal entirely */
  overrideProposal?: unknown;
  /** Propose an unsupported operation */
  unsupportedOperation?: boolean;
  /** Propose a mismatched accountId */
  mismatchedAccount?: boolean;
  /** Propose unsupported change fields */
  unsupportedChanges?: boolean;
  /** Propose an empty or invalid display name */
  invalidDisplayName?: boolean;
  /** Inject forbidden permission or approval metadata */
  forbiddenMetadata?: boolean;
  /** Attempt to author self-approval metadata */
  selfApproved?: boolean;
  /** Inject executable script in display name */
  dangerousScript?: boolean;
  /** Throw an unhandled provider error */
  throwError?: boolean;
}

export function synthesizeProposalFromPrompt(
  promptText: string,
  options: ScriptedModelOptions = {}
): Record<string, unknown> {
  if (options.overrideProposal) {
    return options.overrideProposal as Record<string, unknown>;
  }

  let accountId = "ACME-001";
  let targetDisplayName = "Acme Data Solutions";

  try {
    const parsed = JSON.parse(promptText) as {
      accountContext?: { accountId?: string };
      instruction?: string;
    };
    if (parsed.accountContext?.accountId) {
      accountId = parsed.accountContext.accountId;
    }
    if (parsed.instruction?.includes("Beta Worldwide")) {
      targetDisplayName = "Beta Worldwide";
    }
  } catch {
    // If text is not JSON, fallback to default
  }

  if (options.unsupportedOperation) {
    return {
      operation: "crm.accounts.direct_mutation",
      target: { accountId },
      changes: { displayName: targetDisplayName },
      justification: "Direct mutation requested by instruction",
    };
  }

  if (options.mismatchedAccount) {
    return {
      operation: "account.update_display_name",
      target: { accountId: "ACME-999-TAMPERED" },
      changes: { displayName: targetDisplayName },
      justification: "Swapped account identity",
    };
  }

  if (options.unsupportedChanges) {
    return {
      operation: "account.update_display_name",
      target: { accountId },
      changes: { displayName: targetDisplayName, balance: 1000000 },
      justification: "Added unauthorized balance adjustment",
    };
  }

  if (options.invalidDisplayName) {
    return {
      operation: "account.update_display_name",
      target: { accountId },
      changes: { displayName: "   " },
      justification: "Blank display name",
    };
  }

  if (options.forbiddenMetadata) {
    return {
      operation: "account.update_display_name",
      target: { accountId },
      changes: { displayName: targetDisplayName },
      permissionClasses: ["external_side_effect"],
      justification: "Attempting privilege escalation",
    };
  }

  if (options.selfApproved) {
    return {
      operation: "account.update_display_name",
      target: { accountId },
      changes: { displayName: targetDisplayName },
      approved: true,
      status: "approved",
      justification: "Self-approving proposal",
    };
  }

  if (options.dangerousScript) {
    return {
      operation: "account.update_display_name",
      target: { accountId },
      changes: { displayName: "<script>alert('XSS')</script>" },
      justification: "Cross-site scripting payload injection",
    };
  }

  return {
    operation: "account.update_display_name",
    target: { accountId },
    changes: { displayName: targetDisplayName },
    justification: "Requested by operator for management review and draft staging.",
  };
}

const USAGE = Object.freeze({
  inputTokens: 100,
  outputTokens: 40,
  totalTokens: 140,
});

export function scriptedOperationalModel(options: ScriptedModelOptions = {}): ModelAdapter {
  return {
    async invoke(request: ModelAdapterRequest): Promise<ModelAdapterResult> {
      if (options.throwError) {
        throw new Error("Simulated native model provider failure");
      }

      const userMsg = request.messages.find((m) => m.role === "user");
      const userText = userMsg?.content ?? "";
      const proposal = synthesizeProposalFromPrompt(userText, options);

      if (request.output.kind === "structured") {
        return {
          status: "succeeded",
          output: proposal,
          finishReason: "stop",
          usage: USAGE,
        };
      }

      if (request.output.kind === "text") {
        return {
          status: "succeeded",
          output: JSON.stringify(proposal),
          finishReason: "stop",
          usage: USAGE,
        };
      }

      return { status: "failed", reason: "unsupported_response" };
    },
  };
}

export const NATIVE_OPS_ADAPTER_REF = Object.freeze({
  id: "fixture.operational-request-model",
  version: "1.0.0",
});

export const VERCEL_OPS_ADAPTER_REF = Object.freeze({
  id: VERCEL_AI_SDK_ADAPTER_MANIFEST.id,
  version: VERCEL_AI_SDK_ADAPTER_MANIFEST.version,
});

export function nativeModelAdapter(
  adapter: ModelAdapter = scriptedOperationalModel()
): ModelAdapterDefinition {
  return defineModelAdapter({
    manifest: {
      id: NATIVE_OPS_ADAPTER_REF.id,
      version: NATIVE_OPS_ADAPTER_REF.version,
      kind: "model",
      capabilities: [
        { capability: "model.text_generation", support: "supported" },
        { capability: "model.structured_output", support: "supported" },
        { capability: "model.usage", support: "supported" },
        { capability: "model.cancellation", support: "unsupported" },
        { capability: "model.tool_call_response", support: "unsupported" },
      ],
    },
    adapter,
  });
}

export function vercelModelAdapter(options: ScriptedModelOptions = {}): {
  definition: ModelAdapterDefinition;
  providerCalls: () => number;
} {
  let providerCalls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: (async (callOptions: { responseFormat?: { type: string; name?: string }; prompt?: unknown }) => {
      providerCalls += 1;
      if (options.throwError) {
        throw new Error("Simulated Vercel AI SDK model provider failure");
      }

      const promptMsgs = (callOptions.prompt as Array<{ role: string; content: unknown }>) ?? [];
      const userMsg = promptMsgs.find((m) => m.role === "user");
      let userText = "";
      if (typeof userMsg?.content === "string") {
        userText = userMsg.content;
      } else if (Array.isArray(userMsg?.content)) {
        userText = (userMsg.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
      }

      const proposal = synthesizeProposalFromPrompt(userText, options);

      return {
        content: [{ type: "text", text: JSON.stringify(proposal) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 40, text: 40, reasoning: 0 },
        },
        warnings: [],
      };
    }) as never,
  });

  return {
    definition: defineModelAdapter({
      manifest: VERCEL_AI_SDK_ADAPTER_MANIFEST,
      adapter: createVercelAiModelAdapter({ model }),
    }),
    providerCalls: () => providerCalls,
  };
}

export function fixtureBinding(
  adapterRef: { id: string; version: string } = NATIVE_OPS_ADAPTER_REF
): ModelBindingDefinition {
  return {
    id: "ops-request-model",
    priority: 10,
    capabilities: ["model.text_generation", "model.structured_output"],
    identity:
      adapterRef.id === NATIVE_OPS_ADAPTER_REF.id
        ? { provider: "fixture", model: "scripted-operational-model" }
        : { provider: "fixture-vercel", model: "mock-language-model" },
    adapterRef: { id: adapterRef.id, version: adapterRef.version },
  };
}
