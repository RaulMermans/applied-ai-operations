import {
  defineModelAdapter,
  type ModelAdapter,
  type ModelAdapterDefinition,
  type ModelAdapterRequest,
  type ModelAdapterResult,
  type ModelBindingDefinition,
} from "@aao/framework";
import {
  createVercelAiModelAdapter,
  VERCEL_AI_SDK_ADAPTER_MANIFEST,
} from "@aao/model-runtime/vercel-ai";
import { MockLanguageModelV3 } from "ai/test";
import { publicWebSourceId } from "@aao/integration-public-web";
import { NORTHSTAR_CORPUS, ARBOR_CORPUS } from "./public-web.js";

const USAGE = Object.freeze({
  inputTokens: 120,
  outputTokens: 40,
  totalTokens: 160,
});

export const NORTHSTAR_NATIVE_ADAPTER_REF = Object.freeze({
  id: "aao.native-model",
  version: "1.0.0",
});

export const ARBOR_VERCEL_ADAPTER_REF = Object.freeze({
  id: "aao.vercel-ai-sdk",
  version: "1.0.0",
});

export const NORTHSTAR_MODEL_BINDING: ModelBindingDefinition = Object.freeze({
  id: "northstar.model.native",
  priority: 10,
  capabilities: ["model.text_generation" as const, "model.structured_output" as const],
  identity: { provider: "fixture-native", model: "scripted-northstar" },
  adapterRef: { ...NORTHSTAR_NATIVE_ADAPTER_REF },
});

export const ARBOR_MODEL_BINDING: ModelBindingDefinition = Object.freeze({
  id: "arbor.model.vercel",
  priority: 10,
  capabilities: ["model.text_generation" as const, "model.structured_output" as const],
  identity: { provider: "fixture-vercel", model: "mock-arbor" },
  adapterRef: { ...ARBOR_VERCEL_ADAPTER_REF },
});

// Northstar Structured Outputs
const northstarSourceIds = {
  home: publicWebSourceId(NORTHSTAR_CORPUS.home.url),
  customers: publicWebSourceId(NORTHSTAR_CORPUS.customers.url),
  differentiation: publicWebSourceId(NORTHSTAR_CORPUS.differentiation.url),
};

export const NORTHSTAR_RESEARCH_PLAN = {
  queries: [
    { id: "q1", query: "Northstar Commerce retail operations", questionIds: ["offering"] },
    { id: "q2", query: "Northstar Commerce enterprise customers", questionIds: ["customers"] },
    { id: "q3", query: "Northstar Commerce real-time sync", questionIds: ["differentiation"] },
  ],
};

export const NORTHSTAR_RESEARCH_DRAFT = {
  answers: [
    {
      questionId: "offering",
      status: "answered",
      findings: [
        {
          statement: "Northstar Commerce provides inventory synchronization and checkout for retail brands.",
          sourceRefs: [northstarSourceIds.home],
        },
      ],
    },
    {
      questionId: "customers",
      status: "answered",
      findings: [
        {
          statement: "Northstar Commerce is used by enterprise retail brands and high-growth direct-to-consumer merchants.",
          sourceRefs: [northstarSourceIds.customers],
        },
      ],
    },
    {
      questionId: "differentiation",
      status: "answered",
      findings: [
        {
          statement: "Northstar Commerce differentiates through sub-second POS inventory replication and zero-downtime catalog migrations.",
          sourceRefs: [northstarSourceIds.differentiation],
        },
      ],
    },
  ],
  overallLimitations: ["Pricing levels were not found in retrieved sources."],
};

export const NORTHSTAR_OPS_PROPOSAL = {
  operation: "account.update_display_name",
  target: { accountId: "NS-COMMERCE-001" },
  changes: { displayName: "Northstar Global Retail" },
  justification: "Rebranding for omnichannel retail expansion across international markets",
};

// Arbor Structured Outputs
const arborSourceIds = {
  home: publicWebSourceId(ARBOR_CORPUS.home.url),
  clients: publicWebSourceId(ARBOR_CORPUS.clients.url),
  differentiation: publicWebSourceId(ARBOR_CORPUS.differentiation.url),
};

export const ARBOR_RESEARCH_PLAN = {
  queries: [
    { id: "q1", query: "Arbor Consulting corporate strategy", questionIds: ["offering"] },
    { id: "q2", query: "Arbor Consulting executive clients", questionIds: ["clients"] },
    { id: "q3", query: "Arbor Consulting evidence-anchored audits", questionIds: ["differentiation"] },
  ],
};

export const ARBOR_RESEARCH_DRAFT = {
  answers: [
    {
      questionId: "offering",
      status: "answered",
      findings: [
        {
          statement: "Arbor Consulting delivers corporate transformation and digital strategy for Fortune 500 institutions.",
          sourceRefs: [arborSourceIds.home],
        },
      ],
    },
    {
      questionId: "clients",
      status: "answered",
      findings: [
        {
          statement: "Arbor Consulting advises executive leadership teams and board committees across Europe and North America.",
          sourceRefs: [arborSourceIds.clients],
        },
      ],
    },
    {
      questionId: "differentiation",
      status: "answered",
      findings: [
        {
          statement: "Arbor Consulting distinguishes its practice through evidence-anchored workflow audits and deterministic operating models.",
          sourceRefs: [arborSourceIds.differentiation],
        },
      ],
    },
  ],
  overallLimitations: ["Billing rates were not found in retrieved sources."],
};

export const ARBOR_OPS_PROPOSAL = {
  operation: "account.update_display_name",
  target: { accountId: "ARB-CLIENT-202" },
  changes: { displayName: "Arbor Strategic Partners" },
  justification: "Legal entity restructuring into partnership tier",
};

/**
 * Dynamically synthesizes a research plan matching whatever questions are requested.
 */
function synthesizeResearchPlan(
  messages: readonly { role: string; content: string }[],
  companyKind: "northstar" | "arbor"
) {
  let questions: Array<{ id: string; question: string }> = [];
  const userMsg = messages.find((m) => m.role === "user");
  if (userMsg) {
    try {
      const parsed = JSON.parse(userMsg.content) as {
        questions?: Array<{ id: string; question: string }>;
      };
      if (parsed.questions && Array.isArray(parsed.questions)) {
        questions = parsed.questions;
      }
    } catch {
      // not JSON
    }
  }

  if (
    questions.length === 3 &&
    questions.some((q) => q.id === "offering") &&
    questions.some((q) => q.id === (companyKind === "northstar" ? "customers" : "clients")) &&
    questions.some((q) => q.id === "differentiation")
  ) {
    return companyKind === "northstar" ? NORTHSTAR_RESEARCH_PLAN : ARBOR_RESEARCH_PLAN;
  }

  if (questions.length === 0) {
    return companyKind === "northstar" ? NORTHSTAR_RESEARCH_PLAN : ARBOR_RESEARCH_PLAN;
  }

  return {
    queries: questions.map((q, idx) => ({
      id: `q${idx + 1}`,
      query:
        companyKind === "northstar"
          ? `Northstar Commerce ${q.id} query`
          : `Arbor Consulting ${q.id} query`,
      questionIds: [q.id],
    })),
  };
}

/**
 * Dynamically synthesizes research draft answers matching whatever questions and admitted sources exist.
 */
function synthesizeResearchDraft(
  messages: readonly { role: string; content: string }[],
  companyKind: "northstar" | "arbor"
) {
  let questions: Array<{ id: string; question: string }> = [];
  let sources: Array<{ sourceId: string; url: string; title: string }> = [];
  const userMsg = messages.find((m) => m.role === "user");
  if (userMsg) {
    try {
      const parsed = JSON.parse(userMsg.content) as {
        questions?: Array<{ id: string; question: string }>;
        sources?: Array<{ sourceId: string; url: string; title: string }>;
      };
      if (parsed.questions && Array.isArray(parsed.questions)) {
        questions = parsed.questions;
      }
      if (parsed.sources && Array.isArray(parsed.sources)) {
        sources = parsed.sources;
      }
    } catch {
      // not JSON
    }
  }

  if (
    questions.length === 3 &&
    questions.some((q) => q.id === "offering") &&
    questions.some((q) => q.id === (companyKind === "northstar" ? "customers" : "clients")) &&
    questions.some((q) => q.id === "differentiation")
  ) {
    return companyKind === "northstar" ? NORTHSTAR_RESEARCH_DRAFT : ARBOR_RESEARCH_DRAFT;
  }

  const defaultSourceId =
    companyKind === "northstar" ? northstarSourceIds.home : arborSourceIds.home;
  const availableSourceId = sources[0]?.sourceId ?? defaultSourceId;

  return {
    answers: questions.map((q) => ({
      questionId: q.id,
      status: "answered",
      findings: [
        {
          statement:
            companyKind === "northstar"
              ? `Northstar Commerce provides inventory synchronization and checkout for ${q.id}.`
              : `Arbor Consulting delivers corporate transformation and workflow advisory for ${q.id}.`,
          sourceRefs: [availableSourceId],
        },
      ],
    })),
    overallLimitations: ["Pricing levels were not found in retrieved sources."],
  };
}

/**
 * Dynamically synthesizes a grounded document intelligence draft from admitted evidence spans.
 */
function synthesizeDocumentDraft(
  messages: readonly { role: string; content: string }[],
  companyKind: "northstar" | "arbor"
) {
  let evidenceSpans: Array<{ evidenceId: string; pageNumber: number; text: string }> = [];
  let questions: Array<{ id: string; question: string }> = [];

  const userMsg = messages.find((m) => m.role === "user");
  if (userMsg) {
    try {
      const parsed = JSON.parse(userMsg.content) as {
        evidenceSpans?: Array<{ evidenceId: string; pageNumber: number; text: string }>;
        questions?: Array<{ id: string; question: string }>;
      };
      if (parsed.evidenceSpans) evidenceSpans = parsed.evidenceSpans;
      if (parsed.questions) questions = parsed.questions;
    } catch {
      // not JSON
    }
  }

  const answers = questions.map((q) => {
    const span = evidenceSpans[0];
    if (!span) {
      return {
        questionId: q.id,
        status: "insufficient_evidence",
        findings: [],
        limitation: "No evidence spans admitted.",
      };
    }

    const statement =
      companyKind === "northstar"
        ? `Supplier terms provide 30-day payment and 99.9% delivery fulfillment for ${q.question}.`
        : `Consulting terms provide monthly advisory billing and 12-month term for ${q.question}.`;

    return {
      questionId: q.id,
      status: "answered",
      findings: [
        {
          statement,
          evidenceRefs: [span.evidenceId],
        },
      ],
    };
  });

  return {
    answers,
    overallLimitations: ["Findings are strictly based on admitted document evidence."],
  };
}

export function createNorthstarModelAdapter(): ModelAdapterDefinition {
  const requests: ModelAdapterRequest[] = [];

  const adapter: ModelAdapter & { requests: ModelAdapterRequest[] } = {
    requests,
    async invoke(request): Promise<ModelAdapterResult> {
      requests.push(JSON.parse(JSON.stringify(request)) as ModelAdapterRequest);
      const name = request.output.kind === "structured" ? request.output.name : undefined;

      if (name === "research_plan") {
        const plan = synthesizeResearchPlan(request.messages, "northstar");
        return { status: "succeeded", output: plan, finishReason: "stop", usage: USAGE };
      }
      if (name === "company_research_draft") {
        const draft = synthesizeResearchDraft(request.messages, "northstar");
        return { status: "succeeded", output: draft, finishReason: "stop", usage: USAGE };
      }
      if (name === "document_intelligence_draft") {
        const draft = synthesizeDocumentDraft(request.messages, "northstar");
        return { status: "succeeded", output: draft, finishReason: "stop", usage: USAGE };
      }
      if (name === "operational_request_interpretation" || name === "OperationalActionProposal") {
        return { status: "succeeded", output: NORTHSTAR_OPS_PROPOSAL, finishReason: "stop", usage: USAGE };
      }

      return { status: "failed", reason: "unsupported_response" };
    },
  };

  return defineModelAdapter({
    manifest: {
      id: NORTHSTAR_NATIVE_ADAPTER_REF.id,
      version: NORTHSTAR_NATIVE_ADAPTER_REF.version,
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

export function createArborModelAdapter(): {
  definition: ModelAdapterDefinition;
  providerCalls: () => number;
} {
  let providerCalls = 0;

  const model = new MockLanguageModelV3({
    doGenerate: (async (options: {
      prompt: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
      responseFormat?: { type: string; name?: string };
    }) => {
      providerCalls += 1;
      const name = options.responseFormat?.name;
      const msgs = options.prompt.map((p) => ({
        role: p.role,
        content: typeof p.content === "string" ? p.content : p.content.map((c) => c.text ?? "").join(""),
      }));

      let output: unknown;
      if (name === "research_plan") {
        output = synthesizeResearchPlan(msgs, "arbor");
      } else if (name === "company_research_draft") {
        output = synthesizeResearchDraft(msgs, "arbor");
      } else if (name === "document_intelligence_draft") {
        output = synthesizeDocumentDraft(msgs, "arbor");
      } else if (name === "operational_request_interpretation" || name === "OperationalActionProposal") {
        output = ARBOR_OPS_PROPOSAL;
      } else {
        throw new Error(`Unscripted mock model request: ${name}`);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 40, text: 40, reasoning: 0 },
        },
        warnings: [],
      };
    }) as never,
  });

  const adapter = createVercelAiModelAdapter({ model });
  const definition = defineModelAdapter({
    manifest: VERCEL_AI_SDK_ADAPTER_MANIFEST,
    adapter,
  });

  return {
    definition,
    providerCalls: () => providerCalls,
  };
}
