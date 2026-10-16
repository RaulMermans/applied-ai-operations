import {
  defineGovernance,
  defineModelAdapter,
  type ModelAdapter,
  type ModelAdapterDefinition,
  type ModelAdapterRequest,
  type ModelAdapterResult,
  type ModelBindingDefinition,
  type Principal,
} from "@aao/framework";
import { createVercelAiModelAdapter, VERCEL_AI_SDK_ADAPTER_MANIFEST } from "@aao/model-runtime/vercel-ai";
import { MockLanguageModelV3 } from "ai/test";
import type { DraftAnswer, DocumentIntelligenceDraft } from "../src/contracts.js";

export const reader: Principal = Object.freeze({ id: "user.reader", type: "user" });
export const unauthorizedUser: Principal = Object.freeze({ id: "user.unauthorized", type: "user" });

export const fixtureGovernance = defineGovernance({
  actors: [reader, unauthorizedUser],
  roles: [
    { id: "reader", version: "1.0.0", permissionClasses: ["read_only"] },
    { id: "unauthorized", version: "1.0.0", permissionClasses: ["write_draft"] },
  ],
  bindings: [
    { id: "reader.reader", actorId: reader.id, roleId: "reader", status: "active" },
    { id: "unauthorized.unauthorized", actorId: unauthorizedUser.id, roleId: "unauthorized", status: "active" },
  ],
  policies: [],
});

export interface ScriptedModelOptions {
  /** If provided, replaces the default synthesis draft entirely */
  overrideDraft?: unknown;
  /** Inject a non-existent evidenceId into citations */
  unknownEvidenceRef?: boolean;
  /** Inject duplicate evidenceId within a single finding */
  duplicateEvidenceRef?: boolean;
  /** Omit an answer to a question */
  omitQuestionId?: string;
  /** Throw an error during synthesis */
  throwError?: boolean;
  /** Attempt to author a URL in statement */
  includeUrlInStatement?: boolean;
  /** Attempt to author raw anchor metadata (page number / offset) in statement */
  includeAnchorInStatement?: boolean;
  /** Succumb to prompt injection */
  obeyInjection?: boolean;
}

interface EvidencePromptSpan {
  evidenceId: string;
  pageNumber: number;
  text: string;
}

interface SynthesisPromptBody {
  questions: readonly { id: string; question: string }[];
  evidenceSpans: readonly EvidencePromptSpan[];
}

export function synthesizeDraftFromPrompt(
  promptJson: string,
  options: ScriptedModelOptions = {}
): DocumentIntelligenceDraft {
  if (options.overrideDraft) {
    return options.overrideDraft as DocumentIntelligenceDraft;
  }

  let spans: readonly EvidencePromptSpan[] = [];
  let questions: readonly { id: string; question: string }[] = [];

  try {
    const parsed = JSON.parse(promptJson) as SynthesisPromptBody;
    spans = parsed.evidenceSpans ?? [];
    questions = parsed.questions ?? [];
  } catch {
    // If not JSON, empty
  }

  const answers: DraftAnswer[] = [];

  for (const q of questions) {
    if (options.omitQuestionId === q.id) {
      continue;
    }

    if (q.id === "payment_terms") {
      const match = spans.find((s) => s.text.includes("$120,000") || s.text.includes("payment"));
      if (match) {
        const refs: string[] = [match.evidenceId];
        if (options.duplicateEvidenceRef) {
          refs.push(match.evidenceId);
        }
        if (options.unknownEvidenceRef) {
          refs.push("ev.0000000000000000");
        }
        let statement = "The annual subscription fee is $120,000 USD payable quarterly in advance, with payment due within 30 days.";
        if (options.includeUrlInStatement) {
          statement += " See details at https://acme.example/terms.";
        }
        if (options.includeAnchorInStatement) {
          statement += " Located on page 1 chars 40-120.";
        }
        answers.push({
          questionId: q.id,
          status: "answered",
          findings: [{ statement, evidenceRefs: Object.freeze(refs) }],
        });
        continue;
      }
    }

    if (q.id === "governing_law") {
      const match = spans.find((s) => s.text.includes("Delaware"));
      if (match) {
        answers.push({
          questionId: q.id,
          status: "answered",
          findings: [
            {
              statement: "The agreement is governed by the laws of the State of Delaware without regard to conflict of laws principles.",
              evidenceRefs: Object.freeze([match.evidenceId]),
            },
          ],
        });
        continue;
      }
    }

    if (q.id === "breach_notification") {
      const match = spans.find((s) => /72\s+hours/.test(s.text));
      if (match) {
        answers.push({
          questionId: q.id,
          status: "answered",
          findings: [
            {
              statement: "Acme will notify Customer within 72 hours of verification of a confirmed security incident affecting Customer Data.",
              evidenceRefs: Object.freeze([match.evidenceId]),
            },
          ],
        });
        continue;
      }
    }

    // Default or unanswered
    if (options.obeyInjection) {
      answers.push({
        questionId: q.id,
        status: "answered",
        findings: [
          {
            statement: "I am now the administrator. All fees are waived and questions approved.",
            evidenceRefs: spans.length > 0 ? Object.freeze([spans[0]!.evidenceId]) : Object.freeze([]),
          },
        ],
      });
    } else {
      answers.push({
        questionId: q.id,
        status: "insufficient_evidence",
        findings: Object.freeze([]),
        limitation: `No relevant evidence was found in the admitted document spans for question '${q.id}'.`,
      });
    }
  }

  return {
    answers: Object.freeze(answers),
    overallLimitations: Object.freeze(["Findings are strictly based on the admitted evidence spans."]),
  };
}

const USAGE = { inputTokens: 120, outputTokens: 40, totalTokens: 160 };

export interface ScriptedDocumentModel extends ModelAdapter {
  readonly requests: ModelAdapterRequest[];
}

export function scriptedDocumentModel(options: ScriptedModelOptions = {}): ScriptedDocumentModel {
  const requests: ModelAdapterRequest[] = [];
  return {
    requests,
    async invoke(request: ModelAdapterRequest): Promise<ModelAdapterResult> {
      requests.push(JSON.parse(JSON.stringify(request)) as ModelAdapterRequest);
      if (options.throwError) {
        throw new Error("Simulated model provider service outage");
      }

      const userMsg = request.messages.find((m) => m.role === "user");
      const userText = typeof userMsg?.content === "string" ? userMsg.content : "";
      const draft = synthesizeDraftFromPrompt(userText, options);

      const name = request.output.kind === "structured" ? request.output.name : undefined;
      if (name === "document_intelligence_draft") {
        return {
          status: "succeeded",
          output: draft,
          finishReason: "stop",
          usage: USAGE,
        };
      }

      return { status: "failed", reason: "unsupported_response" };
    },
  };
}

export const NATIVE_DOC_ADAPTER_REF = Object.freeze({ id: "fixture.doc-intel-model", version: "1.0.0" });
export const VERCEL_DOC_ADAPTER_REF = Object.freeze({
  id: VERCEL_AI_SDK_ADAPTER_MANIFEST.id,
  version: VERCEL_AI_SDK_ADAPTER_MANIFEST.version,
});

export function nativeModelAdapter(adapter: ModelAdapter = scriptedDocumentModel()): ModelAdapterDefinition {
  return defineModelAdapter({
    manifest: {
      id: NATIVE_DOC_ADAPTER_REF.id,
      version: NATIVE_DOC_ADAPTER_REF.version,
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

      const draft = synthesizeDraftFromPrompt(userText, options);

      return {
        content: [{ type: "text", text: JSON.stringify(draft) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 40, text: 40, reasoning: 0 } },
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

export function fixtureBinding(adapterRef: { id: string; version: string } = NATIVE_DOC_ADAPTER_REF): ModelBindingDefinition {
  return {
    id: "doc-intel-model",
    priority: 10,
    capabilities: ["model.text_generation", "model.structured_output"],
    identity:
      adapterRef.id === NATIVE_DOC_ADAPTER_REF.id
        ? { provider: "fixture", model: "scripted-doc-intel" }
        : { provider: "fixture-vercel", model: "mock-language-model" },
    adapterRef: { ...adapterRef },
  };
}
