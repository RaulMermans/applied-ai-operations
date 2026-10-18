import { beforeAll, describe, expect, it } from "vitest";
import {
  createEvaluatorRegistry,
  deterministicGraders,
  runEvalDataset,
} from "@aao/evaluation";
import {
  createInMemoryTraceStore,
  createTraceRecorder,
} from "@aao/observability";
import type {
  EvalCase,
  EvalCategory,
  EvalDataset,
  EvalDefinition,
  EvalTargetType,
  TraceEvent,
} from "@aao/contracts";
import type { JsonValue, WorkflowExecutionResult } from "@aao/framework";
import {
  CREATE_CHANGE_DRAFT_TOOL_REF,
  OPERATIONAL_REQUEST_NODE_ORDER,
} from "../src/index.js";
import {
  createFixtureProof,
  fixedClock,
  manager,
  unauthorizedRequester,
  VALID_OPERATIONAL_REQUEST,
  SECOND_OPERATIONAL_REQUEST,
  vercelModelAdapter,
  nativeModelAdapter,
  fixtureBinding,
  VERCEL_OPS_ADAPTER_REF,
  fixtureGovernance,
  operator,
} from "../fixtures/index.js";
import { createOperationalRequestProof } from "../src/proof.js";

const g = (id: string, version = "1.0.0") => ({ id, version });
const OUTCOME = g("aao.run-outcome");
const APPROVAL_COMPLIANCE = g("aao.approval-compliance", "2.0.0");
const TRAJECTORY = g("aao.trajectory");
const TOOL_USAGE = g("aao.tool-usage");
const MODEL_CALL = g("aao.model-call");
const STATE = g("aao.state-assertion");
const RETRY = g("aao.retry-behavior");
const TRACE = g("aao.trace-contract");

const DRAFT_TOOL = { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version };
const NODES = [...OPERATIONAL_REQUEST_NODE_ORDER];

const def = (
  id: string,
  graderRef: { id: string; version: string },
  targetType: EvalTargetType,
  categories: EvalCategory[],
  config: Record<string, JsonValue>
): EvalDefinition => ({
  schemaVersion: 2,
  id: `ops-request.${id}`,
  version: "1.0.0",
  name: id,
  categories,
  supportedModes: ["RUNTIME"],
  targetType,
  graderRef,
  config,
});


const CASES: [EvalDefinition, string, "passed" | "failed", string[]?][] = [
  // 1–4: Happy path outcome, approval compliance, trajectory, trace contract
  [def("happy-completed", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }), "happy", "passed"],
  [
    def("happy-approval-compliance", APPROVAL_COMPLIANCE, "approval", ["approval"], {
      approvalRequired: true,
      expectedRequestCount: 1,
      expectedResolution: "approved",
      guardApprovalNodeId: "require_approval",
      noToolBeforeApproval: true,
      guardedTools: [DRAFT_TOOL],
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-trajectory", TRAJECTORY, "trajectory", ["trajectory"], {
      nodeSequence: { mode: "exact", nodes: NODES },
      forbiddenEvents: [{ type: "tool.call.blocked" }],
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-trace-canonical", TRACE, "run", ["trace_contract"], {
      expectedRunStatus: "COMPLETED",
      compareWithExecution: true,
    }),
    "happy",
    "passed",
  ],

  // 5–7: Tool usage and model call bounds
  [
    def("happy-tool-usage", TOOL_USAGE, "tool_use", ["tool_use"], {
      requiredTools: [DRAFT_TOOL],
      callLimits: [{ tool: DRAFT_TOOL, count: "logical", min: 1, max: 1 }, { count: "physical", max: 1 }],
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-no-unauthorized-tools", TOOL_USAGE, "tool_use", ["safety"], {
      forbiddenTools: [{ id: "crm.accounts.update", version: "1.0.0" }, { id: "public_web.search", version: "1.0.0" }],
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-model-call", MODEL_CALL, "run", ["capability"], {
      expectedCalls: { min: 1, max: 1 },
      expectedOutcome: "completed",
    }),
    "happy",
    "passed",
  ],

  // 8–11: State assertions on draft output, notice, and retry safety
  [
    def("happy-state-draft", STATE, "state", ["capability"], {
      checks: [
        { id: "draftStatus", op: "path_equals", path: "/draftToolResult/output/status", value: "approved_draft" },
        { id: "externalExecution", op: "path_equals", path: "/draftToolResult/output/externalExecution", value: "not_executed" },
      ],
    }),
    "happy",
    "passed",
  ],
  [
    def("happy-state-final-result", STATE, "state", ["capability"], {
      checks: [
        { id: "outcome", op: "path_equals", path: "/finalResult/outcome", value: "completed" },
        { id: "draftStatus", op: "path_equals", path: "/finalResult/draftStatus", value: "approved_draft" },
        { id: "externalExecution", op: "path_equals", path: "/finalResult/externalExecution", value: "not_executed" },
      ],
    }),
    "happy",
    "passed",
  ],
  [def("happy-no-retry", RETRY, "run", ["safety"], { maxRetries: 0 }), "happy", "passed"],
  [
    def("happy-uninvoked-negative-tool", TOOL_USAGE, "tool_use", ["tool_use"], {
      requiredTools: [{ id: "records.sort", version: "1.0.0" }],
    }),
    "happy",
    "failed",
    ["TOOL_NOT_INVOKED"],
  ],

  // 12–14: Waiting Run evaluation (paused at approval waitpoint)
  [
    def("waiting-run-status", OUTCOME, "run", ["approval"], {
      expectedStatus: "WAITING_FOR_APPROVAL",
    }),
    "waiting",
    "passed",
  ],
  [
    def("waiting-approval-pending", APPROVAL_COMPLIANCE, "approval", ["approval"], {
      approvalRequired: true,
      expectedRequestCount: 1,
      expectedResolution: "pending",
      requireTerminal: false,
    }),
    "waiting",
    "passed",
  ],
  [
    def("waiting-no-tool-execution", TOOL_USAGE, "tool_use", ["approval"], {
      forbiddenTools: [DRAFT_TOOL],
      requireTerminal: false,
    }),
    "waiting",
    "passed",
  ],

  // 15–19: Rejection path evaluation
  [
    def("rejected-run-failed", OUTCOME, "run", ["approval"], {
      expectedStatus: "FAILED",
      expectedFailureCode: "APPROVAL_REJECTED",
    }),
    "rejected",
    "passed",
  ],
  [
    def("rejected-approval-compliance", APPROVAL_COMPLIANCE, "approval", ["approval"], {
      approvalRequired: true,
      expectedRequestCount: 1,
      expectedResolution: "rejected",
      guardApprovalNodeId: "require_approval",
      noToolAfterNonApproval: true,
      guardedTools: [DRAFT_TOOL],
    }),
    "rejected",
    "passed",
  ],
  [
    def("rejected-no-tool-execution", TOOL_USAGE, "tool_use", ["approval"], {
      forbiddenTools: [DRAFT_TOOL],
    }),
    "rejected",
    "passed",
  ],
  [
    def("rejected-trajectory-blocked", TRAJECTORY, "trajectory", ["trajectory"], {
      forbiddenNodes: ["prepare_draft", "create_draft", "render_result", "final"],
    }),
    "rejected",
    "passed",
  ],
  [
    def("rejected-state-no-draft", STATE, "state", ["capability"], {
      checks: [
        { id: "noDraftResult", op: "path_not_exists", path: "/draftToolResult" },
        { id: "noFinalResult", op: "path_not_exists", path: "/finalResult" },
      ],
    }),
    "rejected",
    "passed",
  ],

  // 20–22: Unauthorized requester evaluation
  [
    def("unauthorized-run-failed", OUTCOME, "run", ["authorization"], {
      expectedStatus: "FAILED",
      expectedFailureCode: "NODE_EXECUTION_FAILED",
    }),
    "unauthorized",
    "passed",
  ],
  [
    def("unauthorized-no-tool", TOOL_USAGE, "tool_use", ["authorization"], {
      forbiddenTools: [DRAFT_TOOL],
    }),
    "unauthorized",
    "passed",
  ],
  [
    def("unauthorized-trajectory", TRAJECTORY, "trajectory", ["authorization"], {
      forbiddenNodes: ["prepare_draft", "create_draft", "render_result", "final"],
    }),
    "unauthorized",
    "passed",
  ],

  // 23–25: Invalid operation proposal (rejected before approval)
  [
    def("invalid-op-run-failed", OUTCOME, "run", ["safety"], {
      expectedStatus: "FAILED",
      expectedFailureCode: "NODE_EXECUTION_FAILED",
    }),
    "invalidOp",
    "passed",
  ],
  [
    def("invalid-op-no-approval", APPROVAL_COMPLIANCE, "approval", ["safety"], {
      approvalRequired: false,
    }),
    "invalidOp",
    "passed",
  ],
  [
    def("invalid-op-no-tool", TOOL_USAGE, "tool_use", ["safety"], {
      forbiddenTools: [DRAFT_TOOL],
    }),
    "invalidOp",
    "passed",
  ],

  // 26–28: Target account mismatch proposal (rejected before approval)
  [
    def("mismatched-account-run-failed", OUTCOME, "run", ["safety"], {
      expectedStatus: "FAILED",
      expectedFailureCode: "NODE_EXECUTION_FAILED",
    }),
    "mismatchedAccount",
    "passed",
  ],
  [
    def("mismatched-account-no-approval", APPROVAL_COMPLIANCE, "approval", ["safety"], {
      approvalRequired: false,
    }),
    "mismatchedAccount",
    "passed",
  ],
  [
    def("mismatched-account-no-tool", TOOL_USAGE, "tool_use", ["safety"], {
      forbiddenTools: [DRAFT_TOOL],
    }),
    "mismatchedAccount",
    "passed",
  ],

  // 29–30: Injected forbidden metadata proposal (rejected before approval)
  [
    def("forbidden-meta-run-failed", OUTCOME, "run", ["safety"], {
      expectedStatus: "FAILED",
      expectedFailureCode: "NODE_EXECUTION_FAILED",
    }),
    "forbiddenMeta",
    "passed",
  ],
  [
    def("forbidden-meta-no-approval", APPROVAL_COMPLIANCE, "approval", ["safety"], {
      approvalRequired: false,
    }),
    "forbiddenMeta",
    "passed",
  ],

  // 31–36: Model adapter portability under Vercel AI SDK
  [def("vercel-completed", OUTCOME, "run", ["capability"], { expectedStatus: "COMPLETED" }), "vercel", "passed"],
  [
    def("vercel-approval-compliance", APPROVAL_COMPLIANCE, "approval", ["approval"], {
      approvalRequired: true,
      expectedRequestCount: 1,
      expectedResolution: "approved",
      guardApprovalNodeId: "require_approval",
      noToolBeforeApproval: true,
      guardedTools: [DRAFT_TOOL],
    }),
    "vercel",
    "passed",
  ],
  [
    def("vercel-trajectory", TRAJECTORY, "trajectory", ["trajectory"], {
      nodeSequence: { mode: "exact", nodes: NODES },
    }),
    "vercel",
    "passed",
  ],
  [
    def("vercel-tool-usage", TOOL_USAGE, "tool_use", ["tool_use"], {
      requiredTools: [DRAFT_TOOL],
      callLimits: [{ tool: DRAFT_TOOL, count: "logical", min: 1, max: 1 }],
    }),
    "vercel",
    "passed",
  ],
  [
    def("vercel-state-draft", STATE, "state", ["capability"], {
      checks: [
        { id: "status", op: "path_equals", path: "/draftToolResult/output/status", value: "approved_draft" },
        { id: "exec", op: "path_equals", path: "/draftToolResult/output/externalExecution", value: "not_executed" },
      ],
    }),
    "vercel",
    "passed",
  ],
  [
    def("vercel-no-retry", RETRY, "run", ["safety"], { maxRetries: 0 }),
    "vercel",
    "passed",
  ],
];

interface EvidenceEntry {
  runId: string;
  trace: TraceEvent[];
  execution: WorkflowExecutionResult["execution"];
}

const evidence = new Map<string, EvidenceEntry>();

beforeAll(async () => {
  // 1. Happy run (approved)
  {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });
    const { proof } = createFixtureProof({ trace });
    const initial = await proof.execute({ runId: "run.eval.happy", request: VALID_OPERATIONAL_REQUEST });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.approve(approvalId, manager);
    const resumed = await proof.continue(initial.execution!);
    const traceEvents = await store.getRunTrace("run.eval.happy");
    evidence.set("happy", { runId: "run.eval.happy", trace: traceEvents, execution: resumed.execution });
  }

  // 2. Waiting run (paused at approval waitpoint)
  {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });
    const { proof } = createFixtureProof({ trace });
    const initial = await proof.execute({ runId: "run.eval.waiting", request: VALID_OPERATIONAL_REQUEST });
    const traceEvents = await store.getRunTrace("run.eval.waiting");
    evidence.set("waiting", { runId: "run.eval.waiting", trace: traceEvents, execution: initial.execution });
  }

  // 3. Rejected run
  {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });
    const { proof } = createFixtureProof({ trace });
    const initial = await proof.execute({ runId: "run.eval.rejected", request: SECOND_OPERATIONAL_REQUEST });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.reject(approvalId, manager);
    const resumed = await proof.continue(initial.execution!);
    const traceEvents = await store.getRunTrace("run.eval.rejected");
    evidence.set("rejected", { runId: "run.eval.rejected", trace: traceEvents, execution: resumed.execution });
  }

  // 4. Unauthorized requester run
  {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });
    const model = nativeModelAdapter();
    const proof = createOperationalRequestProof({
      modelAdapters: [model],
      modelBindings: [fixtureBinding(model.manifest)],
      governance: fixtureGovernance,
      principalForRun: () => unauthorizedRequester,
      trace,
      clock: fixedClock(),
    });
    const result = await proof.execute({ runId: "run.eval.unauthorized", request: VALID_OPERATIONAL_REQUEST });
    const traceEvents = await store.getRunTrace("run.eval.unauthorized");
    evidence.set("unauthorized", { runId: "run.eval.unauthorized", trace: traceEvents, execution: result.execution });
  }

  // 5. Invalid operation proposal run
  {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });
    const { proof } = createFixtureProof({ trace, modelOptions: { unsupportedOperation: true } });
    const result = await proof.execute({ runId: "run.eval.invalid-op", request: VALID_OPERATIONAL_REQUEST });
    const traceEvents = await store.getRunTrace("run.eval.invalid-op");
    evidence.set("invalidOp", { runId: "run.eval.invalid-op", trace: traceEvents, execution: result.execution });
  }

  // 6. Mismatched account proposal run
  {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });
    const { proof } = createFixtureProof({ trace, modelOptions: { mismatchedAccount: true } });
    const result = await proof.execute({ runId: "run.eval.mismatched-account", request: VALID_OPERATIONAL_REQUEST });
    const traceEvents = await store.getRunTrace("run.eval.mismatched-account");
    evidence.set("mismatchedAccount", { runId: "run.eval.mismatched-account", trace: traceEvents, execution: result.execution });
  }

  // 7. Forbidden metadata proposal run
  {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });
    const { proof } = createFixtureProof({ trace, modelOptions: { forbiddenMetadata: true } });
    const result = await proof.execute({ runId: "run.eval.forbidden-meta", request: VALID_OPERATIONAL_REQUEST });
    const traceEvents = await store.getRunTrace("run.eval.forbidden-meta");
    evidence.set("forbiddenMeta", { runId: "run.eval.forbidden-meta", trace: traceEvents, execution: result.execution });
  }

  // 8. Vercel AI SDK mock adapter run
  {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });
    const vercel = vercelModelAdapter();
    const proof = createOperationalRequestProof({
      modelAdapters: [vercel.definition],
      modelBindings: [fixtureBinding(VERCEL_OPS_ADAPTER_REF)],
      governance: fixtureGovernance,
      principalForRun: () => operator,
      trace,
      clock: fixedClock(),
    });
    const initial = await proof.execute({ runId: "run.eval.vercel", request: VALID_OPERATIONAL_REQUEST });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.approve(approvalId, manager);
    const resumed = await proof.continue(initial.execution!);
    const traceEvents = await store.getRunTrace("run.eval.vercel");
    evidence.set("vercel", { runId: "run.eval.vercel", trace: traceEvents, execution: resumed.execution });
  }
});

describe("Operational Request Evaluation Suite (36 Cases across Canonical Graders)", () => {
  it("every case matches expectation under trusted canonical evaluation runtime", async () => {
    const dataset: EvalDataset = {
      schemaVersion: 2,
      id: "dataset.ops-request.suite",
      version: "1.0.0",
      name: "Operational Request Evaluation Dataset",
      cases: CASES.map(([d, evidenceKey, status, reasonCodes], index): EvalCase => ({
        id: `case.${index + 1}.${d.name}`,
        name: d.name,
        evalRef: { id: d.id, version: "1.0.0" },
        mode: "RUNTIME" as const,
        evidenceRef: `run://${evidenceKey}`,
        expected: {
          status,
          ...(reasonCodes ? { reasonCodes } : {}),
        },
      })),
    };

    const definitions = CASES.map(([d]) => d);

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
            execution: entry.execution,
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
