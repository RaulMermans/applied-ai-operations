import { vi, beforeAll, describe, expect, it } from "vitest";
import {
  createEvaluatorRegistry,
  deterministicGraders,
  runEvalDataset,
} from "@aao/evaluation";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import type { TraceEvent } from "@aao/contracts";
import type { JsonValue, WorkflowExecutionResult } from "@aao/framework";
import {
  ACME_DOCUMENT_REF,
  SAMPLE_QUESTIONS,
  VERCEL_DOC_ADAPTER_REF,
  createDocumentFixtureProvider,
  fixedClock,
  fixtureBinding,
  fixtureGovernance,
  reader,
  unauthorizedUser,
  vercelModelAdapter,
} from "../fixtures/index.js";
import {
  DOCUMENT_INTELLIGENCE_NODE_ORDER,
  createDocumentIntelligenceProof,
} from "../src/index.js";
import { runProof } from "./support.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const def = (
  id: string,
  graderRef: { id: string; version: string },
  targetType: string,
  categories: string[],
  config: Record<string, JsonValue>
) => ({
  schemaVersion: 2,
  id: `doc-intel.${id}`,
  version: "1.0.0",
  name: id,
  categories,
  supportedModes: ["RUNTIME"],
  targetType,
  graderRef,
  config,
});

const g = (id: string) => ({ id, version: "1.0.0" });
const OUTCOME = g("aao.run-outcome");
const TRAJECTORY = g("aao.trajectory");
const TOOL_USAGE = g("aao.tool-usage");
const AUTHZ = g("aao.authorization-compliance");
const MODEL = g("aao.model-call");
const STATE = g("aao.state-assertion");
const TRACE = g("aao.trace-contract");
const RETRY = g("aao.retry-behavior");

const t = (id: string) => ({ id, version: "1.0.0" });
const EXTRACT = t("document.extract_text");
const NODES = [...DOCUMENT_INTELLIGENCE_NODE_ORDER];

const CASES: [ReturnType<typeof def>, string, "passed" | "failed", string[]?][] = [
  // 1–3: Run outcome, trajectory, Trace contract on happy path
  [def("happy-completed", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }), "happy", "passed"],
  [
    def("happy-trajectory", TRAJECTORY, "trajectory", ["trajectory"], {
      nodeSequence: { mode: "exact", nodes: NODES },
      forbiddenEvents: [{ type: "tool.call.blocked" }],
    }),
    "happy",
    "passed",
  ],
  [def("happy-trace-canonical", TRACE, "run", ["trace_contract"], { expectedRunStatus: "COMPLETED", compareWithExecution: true }), "happy", "passed"],

  // 4–6: Tool usage bounds and governance
  [
    def("happy-extract-tool", TOOL_USAGE, "tool_use", ["tool_use"], {
      requiredTools: [EXTRACT],
      callLimits: [{ tool: EXTRACT, count: "logical", min: 1, max: 1 }, { count: "physical", max: 1 }],
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-forbidden-tools", TOOL_USAGE, "tool_use", ["safety"], {
      forbiddenTools: [t("records.sort"), t("public_web.search")],
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-search-negative", TOOL_USAGE, "tool_use", ["tool_use"], {
      requiredTools: [t("public_web.search")],
    }),
    "happy",
    "failed",
    ["TOOL_NOT_INVOKED"],
  ],

  // 7–9: Model call bounds and identity
  [
    def("happy-one-model-call", MODEL, "run", ["capability"], {
      expectedCalls: { min: 1, max: 1 },
      expectedOutcome: "completed",
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-model-identity", MODEL, "run", ["capability"], {
      expectedIdentity: { provider: "fixture", model: "scripted-doc-intel" },
      expectedUsage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-two-calls-negative", MODEL, "run", ["capability"], {
      expectedCalls: { min: 2 },
    }),
    "happy",
    "failed",
    ["MODEL_CALL_COUNT_MISMATCH"],
  ],

  // 10–12: State assertions on final result and extraction metadata
  [
    def("happy-result-state", STATE, "state", ["output_quality"], {
      checks: [
        { id: "version", op: "path_equals", path: "/docResult/schemaVersion", value: 1 },
        { id: "totalQ", op: "path_equals", path: "/docResult/coverage/questionsTotal", value: 4 },
        { id: "answered", op: "path_equals", path: "/docResult/coverage/questionsAnswered", value: 3 },
        { id: "insufficient", op: "path_equals", path: "/docResult/coverage/questionsInsufficient", value: 1 },
        { id: "cited", op: "path_equals", path: "/docResult/coverage/spansCited", value: 3 },
      ],
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-document-meta", STATE, "state", ["output_quality"], {
      checks: [
        { id: "pagesTotal", op: "path_equals", path: "/docResult/document/pagesTotal", value: 3 },
        { id: "pagesExtracted", op: "path_equals", path: "/docResult/document/pagesExtracted", value: 3 },
        { id: "mime", op: "path_equals", path: "/docResult/document/mimeType", value: "application/pdf" },
      ],
    }),
    "happy",
    "passed",
  ],
  [def("happy-no-retry", RETRY, "run", ["capability"], { maxRetries: 0 }), "happy", "passed"],

  // 13–15: Authorization compliance (unauthorized principal lacks read_only)
  [
    def("denied-authorization", AUTHZ, "authorization", ["authorization", "safety"], {
      expectedDenials: [{ tool: EXTRACT, reasonCode: "PERMISSION_NOT_GRANTED" }],
    }),
    "denied",
    "passed",
  ],
  [
    def("denied-blocked-not-invoked", TOOL_USAGE, "tool_use", ["authorization"], {
      expectedBlocked: [{ tool: EXTRACT, failureCode: "TOOL_AUTHORIZATION_DENIED" }],
      forbiddenTools: [EXTRACT],
    }),
    "denied",
    "passed",
  ],
  [
    def("denied-run-failed", OUTCOME, "run", ["authorization"], {
      expectedStatus: "FAILED",
      expectedFailureCode: "NODE_EXECUTION_FAILED",
    }),
    "denied",
    "passed",
  ],

  // 16–18: Grounding failure: unknown evidence reference
  [
    def("unknown-citation-failed", OUTCOME, "run", ["safety"], {
      expectedStatus: "FAILED",
      expectedFailureCode: "NODE_EXECUTION_FAILED",
    }),
    "unknownCitation",
    "passed",
  ],
  [
    def("unknown-citation-no-render", TRAJECTORY, "trajectory", ["safety"], {
      forbiddenNodes: ["render", "final"],
    }),
    "unknownCitation",
    "passed",
  ],
  [
    def("unknown-citation-no-result", STATE, "state", ["safety"], {
      checks: [
        { id: "noResult", op: "path_not_exists", path: "/docResult" },
        { id: "noDraft", op: "path_not_exists", path: "/groundedDraft" },
      ],
    }),
    "unknownCitation",
    "passed",
  ],

  // 19–20: Grounding failure: duplicate citation
  [
    def("duplicate-citation-no-result", STATE, "state", ["safety"], {
      checks: [{ id: "noResult", op: "path_not_exists", path: "/docResult" }],
    }),
    "duplicateCitation",
    "passed",
  ],
  [
    def("missing-answer-no-result", STATE, "state", ["safety"], {
      checks: [{ id: "noResult", op: "path_not_exists", path: "/docResult" }],
    }),
    "missingAnswer",
    "passed",
  ],

  // 21–22: Ingestion failure: document not found
  [
    def("not-found-failed", OUTCOME, "run", ["safety"], {
      expectedStatus: "FAILED",
      expectedFailureCode: "NODE_EXECUTION_FAILED",
    }),
    "notFound",
    "passed",
  ],
  [
    def("not-found-stops-early", TRAJECTORY, "trajectory", ["safety"], {
      forbiddenNodes: ["segment_document", "admit_evidence", "synthesize", "validate_grounding", "render"],
    }),
    "notFound",
    "passed",
  ],

  // 23: Reliability under canonical Runtime: unavailable retried then exhausted
  [
    def("unavailable-retried-then-exhausted", RETRY, "run", ["capability"], {
      nodeId: "extract_document",
      expectedRetries: 1,
      expectExhausted: true,
    }),
    "unavailable",
    "passed",
  ],

  // 24: Privacy: trace canonical when provider throws outage
  [
    def("privacy-trace-canonical", TRACE, "run", ["trace_contract", "safety"], {
      expectedRunStatus: "FAILED",
      compareWithExecution: true,
    }),
    "outage",
    "passed",
  ],

  // 25–27: Portability under Vercel AI SDK adapter
  [
    def("vercel-trajectory", TRAJECTORY, "trajectory", ["trajectory"], {
      nodeSequence: { mode: "exact", nodes: NODES },
    }),
    "vercel",
    "passed",
  ],
  [
    def("vercel-model-identity", MODEL, "run", ["capability"], {
      expectedCalls: { min: 1, max: 1 },
      expectedIdentity: { provider: "fixture-vercel", model: "mock-language-model" },
    }),
    "vercel",
    "passed",
  ],
  [
    def("vercel-tool-usage", TOOL_USAGE, "tool_use", ["tool_use"], {
      requiredTools: [EXTRACT],
      callLimits: [{ count: "physical", max: 1 }],
    }),
    "vercel",
    "passed",
  ],
];

const definitions = CASES.map(([definition]) => definition);
const dataset = {
  schemaVersion: 2,
  id: "doc-intel.proof-verification",
  version: "1.0.0",
  name: "Document Intelligence proof verification",
  cases: CASES.map(([definition, evidenceKey, status, reasonCodes]) => ({
    id: `${definition.id}.001`,
    evalRef: { id: definition.id, version: "1.0.0" },
    mode: "RUNTIME" as const,
    evidenceRef: `run://${evidenceKey}`,
    expected: { status, ...(reasonCodes ? { reasonCodes } : {}) },
  })),
};

interface Evidence {
  runId: string;
  trace: TraceEvent[];
  execution: WorkflowExecutionResult;
}

const evidence = new Map<string, Evidence>();
const record = async (key: string, run: Promise<Awaited<ReturnType<typeof runProof>>>) => {
  const outcome = await run;
  evidence.set(key, {
    runId: outcome.runId,
    trace: outcome.trace,
    execution: outcome.outcome.execution,
  });
};

beforeAll(async () => {
  await record("happy", runProof({ runId: "run.eval.happy" }));
  await record("denied", runProof({ runId: "run.eval.denied", principal: unauthorizedUser }));
  await record(
    "unknownCitation",
    runProof({ runId: "run.eval.unknown-citation", modelOptions: { unknownEvidenceRef: true } })
  );
  await record(
    "duplicateCitation",
    runProof({ runId: "run.eval.dup-citation", modelOptions: { duplicateEvidenceRef: true } })
  );
  await record(
    "missingAnswer",
    runProof({ runId: "run.eval.missing-answer", modelOptions: { omitQuestionId: "payment_terms" } })
  );
  await record(
    "notFound",
    runProof({ runId: "run.eval.not-found", providerOptions: { failRefs: [ACME_DOCUMENT_REF] } })
  );
  await record(
    "unavailable",
    runProof({
      runId: "run.eval.unavailable",
      providerOptions: { unavailableRefs: [ACME_DOCUMENT_REF] },
      reliability: { extract_document: { maxAttempts: 2 } },
    })
  );
  await record(
    "outage",
    runProof({ runId: "run.eval.outage", providerOptions: { providerOutage: true } })
  );

  // Vercel AI SDK adapter evidence
  const store = createInMemoryTraceStore();
  const vercel = vercelModelAdapter();
  const provider = createDocumentFixtureProvider();
  const proof = createDocumentIntelligenceProof({
    modelAdapters: [vercel.definition],
    modelBindings: [fixtureBinding(VERCEL_DOC_ADAPTER_REF)],
    documentSourceProvider: provider,
    governance: fixtureGovernance,
    principalForRun: () => reader,
    trace: createTraceRecorder({ store, clock: fixedClock() }),
    clock: fixedClock(),
  });
  const vOutcome = await proof.run({
    runId: "run.eval.vercel",
    request: {
      documentRef: ACME_DOCUMENT_REF,
      questions: SAMPLE_QUESTIONS,
    },
  });
  const vTrace = (await store.getRunTrace("run.eval.vercel")) as TraceEvent[];
  evidence.set("vercel", {
    runId: "run.eval.vercel",
    trace: vTrace,
    execution: vOutcome.execution,
  });
});

describe("Document Intelligence proof evaluation suite (judged by canonical Evaluation Runtime)", () => {
  it("every case matches expectation under trusted deterministic graders", async () => {
    const judged = await runEvalDataset({
      dataset,
      definitions,
      registry: createEvaluatorRegistry(deterministicGraders()),
      evidenceResolver: {
        resolve: (ref: string) => {
          const key = ref.replace(/^run:\/\//, "");
          const entry = evidence.get(key);
          if (!entry) return undefined;
          return {
            origin: "live_run",
            runId: entry.runId,
            trace: entry.trace,
            execution: entry.execution.execution,
          };
        },
      },
    });

    expect(judged.ok).toBe(true);
    if (!judged.ok) throw new Error("Eval dataset run failed");
    for (const c of judged.run.cases) {
      expect(c.matchesExpectation, `${c.caseId}: ${JSON.stringify(c.result)}`).toBe(true);
    }
  });
});
