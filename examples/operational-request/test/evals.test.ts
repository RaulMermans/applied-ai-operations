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
  defineTool,
  defineWorkflow,
  type ToolDefinition,
} from "@aao/framework";
import {
  deriveToolExecutionId,
  executeTool,
  createToolRegistry,
  type ExecuteToolParams,
} from "@aao/tool-runtime";

type AuthorizationContext = ExecuteToolParams["authorizationContext"];
import {
  fingerprintApprovalSubject,
  approvalIdForFingerprint,
  createApprovalEngine,
} from "@aao/approval";
import { createGovernanceRegistry } from "@aao/governance";
import {
  CREATE_CHANGE_DRAFT_TOOL_REF,
  OPERATIONAL_REQUEST_NODE_ORDER,
  createInMemoryDraftRepository,
  createOperationalApprovalVerifier,
  createOperationalDraftTool,
  type OperationalApprovalSubject,
  type OperationalChangeDraft,
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
  SECRET_DO_NOT_PERSIST,
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

const WRITE_DRAFT_AUTH: AuthorizationContext = {
  schemaVersion: 1,
  principal: { id: "user.operator", type: "user" },
  grantedPermissionClasses: ["write_draft"],
};

function registryWithTool(tool: ToolDefinition) {
  const registry = createToolRegistry();
  registry.register({
    spec: tool.spec,
    handler: tool.handler,
    retrySafety: tool.retrySafety,
    idempotency: tool.idempotency,
  });
  return registry;
}

describe("Sprint 24D Targeted Security & Persistence Evaluations (Section 19)", () => {
  it("evaluates cross-run isolation, spoofed execution refusal, persistence recovery, and replay safety under canonical Eval runtime", async () => {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });
    const proof = createFixtureProof({ trace }).proof;

    // 1. Run A reaches approval waitpoint
    const initialA = await proof.execute({
      runId: "run.eval.s24d.runA",
      request: VALID_OPERATIONAL_REQUEST,
    });
    expect(initialA.ok).toBe(true);
    expect(initialA.execution?.run.status).toBe("WAITING_FOR_APPROVAL");
    const waitA = initialA.execution?.wait;
    if (!waitA) throw new Error("Expected approval waitpoint");
    const approvalIdA = waitA.referenceId;
    const fingerprintA = waitA.requestFingerprint;

    // 2. Eligible manager approves Run A
    proof.approvals.approve(approvalIdA, manager);
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);

    // 3. Run B attempts cross-run reuse of Run A's genuine approval
    const runBToolExecutionId = deriveToolExecutionId("run.eval.s24d.runB", "create_draft");
    const tools = registryWithTool(
      createOperationalDraftTool({
        repository: proof.draftRepository,
        approvalVerifier: proof.approvalVerifier,
      })
    );

    const attackResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: runBToolExecutionId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_OPERATIONAL_REQUEST.requestId,
          accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
          operation: "account.update_display_name",
          proposedChanges: { displayName: "Acme Data Solutions" },
          approvalBinding: {
            approvalId: approvalIdA,
            requestFingerprint: fingerprintA,
            runId: "run.eval.s24d.runA",
          },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    // 4. Assert Run B cannot consume Run A approval (Important Negative Assertion)
    expect(attackResult.ok).toBe(false);
    if (!attackResult.ok) {
      expect(attackResult.failure.handlerFailureCode).toBe("INVALID_APPROVAL_CONTEXT");
    }
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
    // Crucial invariant: Run B must NEVER consume an Approval intended for Run A
    expect(proof.approvalVerifier.getConsumptionState(approvalIdA)).toBe("AVAILABLE");

    // 5. Spoofed Tool Execution ID from untrusted caller fails closed
    const spoofedResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: deriveToolExecutionId("run.eval.s24d.runA", "create_draft"), // attacker recomputed Run A's ID
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_OPERATIONAL_REQUEST.requestId,
          accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
          operation: "account.update_display_name",
          proposedChanges: { displayName: "Acme Data Solutions" },
          approvalBinding: {
            approvalId: approvalIdA,
            requestFingerprint: fingerprintA,
            runId: "run.eval.s24d.runA",
          },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(spoofedResult.ok).toBe(false);
    if (!spoofedResult.ok) {
      expect(spoofedResult.failure.handlerFailureCode).toBe("UNTRUSTED_EXECUTION_ORIGIN");
    }
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);

    // 6. Trusted Workflow-origin identity: Run A legitimate continuation succeeds
    const resumedA = await proof.continue(initialA.execution!);
    expect(resumedA.ok).toBe(true);
    expect(resumedA.execution?.run.status).toBe("COMPLETED");
    expect(proof.draftRepository.getAllDrafts().length).toBe(1);
    expect(proof.approvalVerifier.getConsumptionState(approvalIdA)).toBe("COMMITTED");

    // 7. Idempotent replay under identical execution identity returns existing draft
    const canonicalToolExecA = deriveToolExecutionId("run.eval.s24d.runA", "create_draft");
    const replayResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: canonicalToolExecA,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_OPERATIONAL_REQUEST.requestId,
          accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
          operation: "account.update_display_name",
          proposedChanges: { displayName: "Acme Data Solutions" },
          approvalBinding: {
            approvalId: approvalIdA,
            requestFingerprint: fingerprintA,
            runId: "run.eval.s24d.runA",
          },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(replayResult.ok).toBe(true);
    expect(proof.draftRepository.getAllDrafts().length).toBe(1);

    // 8. Different-payload replay fails with IDEMPOTENCY_CONFLICT
    const conflictResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: canonicalToolExecA,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_OPERATIONAL_REQUEST.requestId,
          accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
          operation: "account.update_display_name",
          proposedChanges: { displayName: "Tampered Display Name" },
          approvalBinding: {
            approvalId: approvalIdA,
            requestFingerprint: fingerprintA,
            runId: "run.eval.s24d.runA",
          },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(conflictResult.ok).toBe(false);
    if (!conflictResult.ok) {
      expect(conflictResult.failure.handlerFailureCode).toBe("IDEMPOTENCY_CONFLICT");
    }
    expect(proof.draftRepository.getAllDrafts().length).toBe(1);

    // 9. Persistence failure is safely recoverable (uncommitted save throws, reservation released)
    const baseFailRepo = createInMemoryDraftRepository();
    let throwOnce = true;
    const failRepo = {
      ...baseFailRepo,
      async saveDraft(execId: string, draft: OperationalChangeDraft) {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("Simulated storage write error");
        }
        return baseFailRepo.saveDraft(execId, draft);
      },
    };

    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock: fixedClock() });
    const subjectB: OperationalApprovalSubject = {
      schemaVersion: 1,
      requestId: "req-recovery",
      operation: "account.update_display_name",
      accountId: "ACME-001",
      proposedChanges: { displayName: "Acme Data Solutions" },
      executionMode: "draft_only",
    };
    const fpRec = fingerprintApprovalSubject("run.eval.recovery", "require_approval", 0, subjectB);
    const appRec = approvalIdForFingerprint("run.eval.recovery", "require_approval", fpRec);
    engine.requestApproval({
      approvalId: appRec,
      runId: "run.eval.recovery",
      nodeId: "require_approval",
      requestFingerprint: fpRec,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(appRec, manager);

    const recVerifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
    const recExecId = deriveToolExecutionId("run.eval.recovery", "create_draft");
    recVerifier.attestExecutionOrigin("run.eval.recovery", recExecId);

    const recTool = createOperationalDraftTool({
      repository: failRepo,
      approvalVerifier: recVerifier,
    });
    const recTools = registryWithTool(recTool);

    // First attempt throws before write
    const failAttempt = await executeTool({
      tools: recTools,
      request: {
        schemaVersion: 1,
        toolExecutionId: recExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: subjectB.requestId,
          accountId: subjectB.accountId,
          operation: subjectB.operation,
          proposedChanges: subjectB.proposedChanges,
          approvalBinding: { approvalId: appRec, requestFingerprint: fpRec, runId: "run.eval.recovery" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(failAttempt.ok).toBe(false);
    expect(failRepo.getAllDrafts().length).toBe(0);
    expect(recVerifier.getConsumptionState(appRec)).toBe("AVAILABLE");

    // Second attempt recovers and commits
    const recoverAttempt = await executeTool({
      tools: recTools,
      request: {
        schemaVersion: 1,
        toolExecutionId: recExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: subjectB.requestId,
          accountId: subjectB.accountId,
          operation: subjectB.operation,
          proposedChanges: subjectB.proposedChanges,
          approvalBinding: { approvalId: appRec, requestFingerprint: fpRec, runId: "run.eval.recovery" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(recoverAttempt.ok).toBe(true);
    expect(failRepo.getAllDrafts().length).toBe(1);
    expect(recVerifier.getConsumptionState(appRec)).toBe("COMMITTED");

    // 10. Ambiguous persistence (save writes then throws): reconciled and committed
    const baseAmbigRepo = createInMemoryDraftRepository();
    const ambigRepo = {
      ...baseAmbigRepo,
      async saveDraft(execId: string, draft: OperationalChangeDraft) {
        await baseAmbigRepo.saveDraft(execId, draft);
        throw new Error("Storage network connection dropped after write");
      },
    };

    const fpAmbig = fingerprintApprovalSubject("run.eval.ambig", "require_approval", 0, subjectB);
    const appAmbig = approvalIdForFingerprint("run.eval.ambig", "require_approval", fpAmbig);
    engine.requestApproval({
      approvalId: appAmbig,
      runId: "run.eval.ambig",
      nodeId: "require_approval",
      requestFingerprint: fpAmbig,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(appAmbig, manager);

    const ambigVerifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
    const ambigExecId = deriveToolExecutionId("run.eval.ambig", "create_draft");
    ambigVerifier.attestExecutionOrigin("run.eval.ambig", ambigExecId);

    const ambigTool = createOperationalDraftTool({
      repository: ambigRepo,
      approvalVerifier: ambigVerifier,
    });
    const ambigTools = registryWithTool(ambigTool);

    const ambigResult = await executeTool({
      tools: ambigTools,
      request: {
        schemaVersion: 1,
        toolExecutionId: ambigExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: subjectB.requestId,
          accountId: subjectB.accountId,
          operation: subjectB.operation,
          proposedChanges: subjectB.proposedChanges,
          approvalBinding: { approvalId: appAmbig, requestFingerprint: fpAmbig, runId: "run.eval.ambig" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(ambigResult.ok).toBe(true);
    expect(ambigRepo.getAllDrafts().length).toBe(1);
    expect(ambigVerifier.getConsumptionState(appAmbig)).toBe("COMMITTED");

    // 11. Concurrent consumption: only 1 execution succeeds
    const concRepo = createInMemoryDraftRepository();
    const fpConc = fingerprintApprovalSubject("run.eval.conc", "require_approval", 0, subjectB);
    const appConc = approvalIdForFingerprint("run.eval.conc", "require_approval", fpConc);
    engine.requestApproval({
      approvalId: appConc,
      runId: "run.eval.conc",
      nodeId: "require_approval",
      requestFingerprint: fpConc,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(appConc, manager);

    const concVerifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
    const concExecId = deriveToolExecutionId("run.eval.conc", "create_draft");
    concVerifier.attestExecutionOrigin("run.eval.conc", concExecId);

    const concTool = createOperationalDraftTool({
      repository: concRepo,
      approvalVerifier: concVerifier,
    });
    const concTools = registryWithTool(concTool);

    const call1 = executeTool({
      tools: concTools,
      request: {
        schemaVersion: 1,
        toolExecutionId: concExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: subjectB.requestId,
          accountId: subjectB.accountId,
          operation: subjectB.operation,
          proposedChanges: subjectB.proposedChanges,
          approvalBinding: { approvalId: appConc, requestFingerprint: fpConc, runId: "run.eval.conc" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    const call2 = executeTool({
      tools: concTools,
      request: {
        schemaVersion: 1,
        toolExecutionId: concExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: subjectB.requestId,
          accountId: subjectB.accountId,
          operation: subjectB.operation,
          proposedChanges: subjectB.proposedChanges,
          approvalBinding: { approvalId: appConc, requestFingerprint: fpConc, runId: "run.eval.conc" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    const [res1, res2] = await Promise.all([call1, call2]);
    expect(res1.ok || res2.ok).toBe(true);
    expect(concRepo.getAllDrafts().length).toBe(1);

    // 12. External effect refusal: tools with external_side_effect are rejected
    let extRefused = false;
    try {
      const extTool = defineTool({
        spec: {
          schemaVersion: 1,
          id: "external.crm_mutation",
          version: "1.0.0",
          name: "External CRM",
          description: "External mutation tool",
          permissionClasses: ["external_side_effect"],
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        handler: { async execute() { return { ok: true, output: {} }; } },
      });
      const extWorkflow = defineWorkflow({
        schemaVersion: 1,
        id: "ext.eval.workflow",
        version: "1.0.0",
        name: "Ext",
        description: "Ext",
        entryNodeId: "ext_node",
        nodes: [{ id: "ext_node", kind: "tool", config: { toolRef: { id: extTool.spec.id, version: extTool.spec.version }, inputStateKey: "in", resultStateKey: "out" } }],
        edges: [],
      });
      proof.app.prepareWorkflow(extWorkflow);
    } catch {
      extRefused = true;
    }
    expect(extRefused).toBe(true);

    // 13. Graded Evaluation via runEvalDataset
    const traceEventsA = await store.getRunTrace("run.eval.s24d.runA");
    const evalDataset: EvalDataset = {
      schemaVersion: 2,
      id: "dataset.ops-request.sprint24d",
      version: "1.0.0",
      name: "Sprint 24D Targeted Security & Persistence Dataset",
      cases: [
        {
          id: "case.s24d.run-a-outcome",
          name: "run-a-outcome",
          evalRef: { id: "def.s24d.outcome", version: "1.0.0" },
          mode: "RUNTIME",
          evidenceRef: "run://runA",
          expected: { status: "passed" },
        },
        {
          id: "case.s24d.run-a-approval",
          name: "run-a-approval",
          evalRef: { id: "def.s24d.approval", version: "1.0.0" },
          mode: "RUNTIME",
          evidenceRef: "run://runA",
          expected: { status: "passed" },
        },
        {
          id: "case.s24d.run-a-state-draft",
          name: "run-a-state-draft",
          evalRef: { id: "def.s24d.state-draft", version: "1.0.0" },
          mode: "RUNTIME",
          evidenceRef: "run://runA",
          expected: { status: "passed" },
        },
      ],
    };

    const evalDefs: EvalDefinition[] = [
      {
        schemaVersion: 2,
        id: "def.s24d.outcome",
        version: "1.0.0",
        name: "Outcome completed",
        categories: ["capability"],
        supportedModes: ["RUNTIME"],
        targetType: "run",
        graderRef: { id: "aao.run-outcome", version: "1.0.0" },
        config: { expectedStatus: "COMPLETED" },
      },
      {
        schemaVersion: 2,
        id: "def.s24d.approval",
        version: "1.0.0",
        name: "Approval compliance",
        categories: ["approval"],
        supportedModes: ["RUNTIME"],
        targetType: "approval",
        graderRef: { id: "aao.approval-compliance", version: "2.0.0" },
        config: {
          approvalRequired: true,
          expectedResolution: "approved",
          guardApprovalNodeId: "require_approval",
          noToolBeforeApproval: true,
          guardedTools: [{ id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version }],
        },
      },
      {
        schemaVersion: 2,
        id: "def.s24d.state-draft",
        version: "1.0.0",
        name: "Draft state verification",
        categories: ["capability"],
        supportedModes: ["RUNTIME"],
        targetType: "state",
        graderRef: { id: "aao.state-assertion", version: "1.0.0" },
        config: {
          checks: [
            { id: "draftStatus", op: "path_equals", path: "/draftToolResult/output/status", value: "approved_draft" },
            { id: "externalExecution", op: "path_equals", path: "/draftToolResult/output/externalExecution", value: "not_executed" },
          ],
        },
      },
    ];

    const evalResult = await runEvalDataset({
      dataset: evalDataset,
      definitions: evalDefs,
      registry: createEvaluatorRegistry(deterministicGraders()),
      evidenceResolver: {
        resolve: () => ({
          origin: "live_run",
          runId: "run.eval.s24d.runA",
          trace: traceEventsA,
          execution: resumedA.execution,
        }),
      },
    });

    expect(evalResult.ok).toBe(true);
    if (!evalResult.ok) throw new Error("Eval dataset run failed");
    for (const c of evalResult.run.cases) {
      expect(c.matchesExpectation).toBe(true);
    }

    // 14. Verify SECRET_DO_NOT_PERSIST does not leak
    const serializedEval = JSON.stringify(evalResult);
    expect(serializedEval).not.toContain(SECRET_DO_NOT_PERSIST);
    const serializedTrace = JSON.stringify(traceEventsA);
    expect(serializedTrace).not.toContain(SECRET_DO_NOT_PERSIST);
  });
});
