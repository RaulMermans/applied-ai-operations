import {
  createAAO,
  defineEval,
  defineGovernance,
  defineTool,
  defineWorkflow,
  type Principal,
  type WorkflowExecutionResult,
} from "@aao/framework";
import { createEvaluatorRegistry, deterministicGraders, runEvalDataset } from "@aao/evaluation";
import { createInMemoryTraceStore, createTraceRecorder, deriveRunMetrics, validateTrace } from "@aao/observability";
import { projectRunInspection } from "@aao/operator-inspection";

export const ana: Principal = { id: "user.ana", type: "user" };
export const ben: Principal = { id: "user.ben", type: "user" };
export const viewer: Principal = { id: "user.viewer", type: "user" };
export const outsider: Principal = { id: "user.outsider", type: "user" };

export const calls = { lookup: 0, draft: 0 };

const lookupTool = defineTool({
  spec: {
    schemaVersion: 1,
    id: "accounts.lookup",
    version: "1.0.0",
    name: "Look up accounts",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    outputSchema: { type: "object", properties: { matches: { type: "array", items: { type: "string" } } }, required: ["matches"], additionalProperties: false },
    permissionClasses: ["read_only"],
  },
  handler: {
    async execute({ input }) {
      calls.lookup += 1;
      const { query } = input as { query: string };
      return { ok: true, output: { matches: [`${query} Ltd`] } };
    },
  },
});

const draftTool = defineTool({
  spec: {
    schemaVersion: 1,
    id: "accounts.draft-update",
    version: "1.0.0",
    name: "Draft an account update",
    inputSchema: { type: "object", properties: { account: { type: "string" }, change: { type: "string" } }, required: ["account", "change"], additionalProperties: false },
    outputSchema: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"], additionalProperties: false },
    permissionClasses: ["write_draft"],
  },
  handler: {
    async execute({ input }) {
      calls.draft += 1;
      const { account } = input as { account: string };
      return { ok: true, output: { draftId: `draft-${account}` } };
    },
  },
});

const governance = defineGovernance({
  actors: [ana, ben, viewer, outsider],
  roles: [
    { id: "analyst", version: "1.0.0", permissionClasses: ["read_only"] },
    { id: "operator", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
    { id: "manager", version: "1.0.0", permissionClasses: ["read_only", "write_draft"] },
  ],
  bindings: [
    { id: "ana.operator", actorId: ana.id, roleId: "operator", status: "active" },
    { id: "ben.manager", actorId: ben.id, roleId: "manager", status: "active" },
    { id: "viewer.analyst", actorId: viewer.id, roleId: "analyst", status: "active" },
  ],
  policies: [],
});

export const lookupWorkflow = defineWorkflow({
  schemaVersion: 1,
  id: "release.accounts-lookup",
  version: "1.0.0",
  name: "Account lookup",
  entryNodeId: "search",
  nodes: [
    { id: "search", kind: "tool", config: { toolRef: { id: "accounts.lookup", version: "1.0.0" }, inputStateKey: "request", resultStateKey: "accounts" } },
    { id: "done", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "search", targetNodeId: "done" }],
});

export const approvedUpdateWorkflow = defineWorkflow({
  schemaVersion: 1,
  id: "release.approved-update",
  version: "1.0.0",
  name: "Approved account update",
  entryNodeId: "approve",
  nodes: [
    { id: "approve", kind: "approval", config: { subjectStateKey: "proposal", permissionClasses: ["write_draft"], requiredApproverRoleIds: ["manager"] } },
    { id: "draft", kind: "tool", config: { toolRef: { id: "accounts.draft-update", version: "1.0.0" }, inputStateKey: "proposal", resultStateKey: "draft" } },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [
    { sourceNodeId: "approve", targetNodeId: "draft" },
    { sourceNodeId: "draft", targetNodeId: "final" },
  ],
});

const sessions = new Map<string, Principal>();
let tick = 0;

export function createGoldenPathApp(options: { trace?: ReturnType<typeof createTraceRecorder> } = {}) {
  return createAAO({
    governance,
    principalForRun: ({ runId }) => {
      const principal = sessions.get(runId);
      if (principal === undefined) throw new Error(`no authenticated session for ${runId}`);
      return principal;
    },
    tools: [lookupTool, draftTool],
    clock: { now: () => new Date(Date.UTC(2026, 10, 20, 12, 0, tick++)).toISOString() },
    ...(options.trace ? { trace: options.trace } : {}),
  });
}

export function resetGoldenPathCounters(): void {
  calls.lookup = 0;
  calls.draft = 0;
  sessions.clear();
  tick = 0;
}

export function bindSession(runId: string, principal: Principal): void {
  sessions.set(runId, principal);
}

function failureCode(result: WorkflowExecutionResult): string | undefined {
  return result.ok ? undefined : result.failure.code;
}

function executorCode(result: WorkflowExecutionResult): string | undefined {
  return result.ok ? undefined : result.failure.executorFailure?.code;
}

export async function runGoldenPath() {
  resetGoldenPathCounters();
  const store = createInMemoryTraceStore();
  const trace = createTraceRecorder({ store, clock: { now: () => new Date(Date.UTC(2026, 10, 20, 12, 0, tick++)).toISOString() } });
  const app = createGoldenPathApp({ trace });
  const lookup = app.prepareWorkflow(lookupWorkflow);
  const update = app.prepareWorkflow(approvedUpdateWorkflow);

  sessions.set("run.lookup", ana);
  const authorized = await lookup.execute({
    runId: "run.lookup",
    initialState: { runId: "run.lookup", revision: 0, values: { request: { query: "Acme" } } },
  });
  const lookupCallsAfterAuthorized = calls.lookup;

  sessions.set("run.denied", outsider);
  const denied = await lookup.execute({
    runId: "run.denied",
    initialState: { runId: "run.denied", revision: 0, values: { request: { query: "Acme" } } },
  });
  const lookupCallsAfterDenied = calls.lookup;

  sessions.set("run.approved", ana);
  const waiting = await update.execute({
    runId: "run.approved",
    initialState: { runId: "run.approved", revision: 0, values: { proposal: { account: "acme", change: "update billing contact" } } },
  });
  const draftCallsWhileWaiting = calls.draft;
  const approvalId = waiting.execution?.wait?.referenceId ?? "";
  const pendingContinue = await update.continue(waiting.execution!);
  app.approvals.approve(approvalId, ben);
  const completed = await update.continue(waiting.execution!);
  const duplicate = await update.continue(waiting.execution!);

  const runTrace = await store.getRunTrace("run.lookup");
  const traceValid = validateTrace(runTrace).valid;
  const metrics = deriveRunMetrics({ trace: runTrace });
  const inspection = projectRunInspection({
    runId: "run.lookup",
    authoritativeRun: authorized.execution?.run,
    workflow: lookupWorkflow,
    traceEvents: runTrace,
  });
  const missingInspection = projectRunInspection({ runId: "run.missing" });

  const judged = await runEvalDataset({
    dataset: {
      schemaVersion: 2,
      id: "release.golden-path",
      version: "1.0.0",
      name: "golden path",
      cases: [
        {
          id: "completed.001",
          evalRef: { id: "release.completed", version: "1.0.0" },
          mode: "RUNTIME",
          evidenceRef: "run://lookup",
          expected: { status: "passed" },
        },
      ],
    },
    definitions: [
      defineEval({
        schemaVersion: 2,
        id: "release.completed",
        version: "1.0.0",
        name: "completed",
        categories: ["capability"],
        supportedModes: ["RUNTIME"],
        targetType: "run",
        graderRef: { id: "aao.run-outcome", version: "1.0.0" },
        config: { expectedStatus: "COMPLETED" },
      }),
    ],
    registry: createEvaluatorRegistry(deterministicGraders()),
    evidenceResolver: {
      resolve: (ref) =>
        ref === "run://lookup" && authorized.execution
          ? { origin: "live_run", runId: "run.lookup", trace: runTrace, execution: authorized.execution }
          : undefined,
    },
  });

  return {
    planFingerprints: { lookup: lookup.planFingerprint, update: update.planFingerprint },
    authorized: {
      ok: authorized.ok,
      status: authorized.execution?.run.status,
      lookupCalls: lookupCallsAfterAuthorized,
      matches: authorized.ok ? (authorized.execution.state.values.accounts as { output: { matches: string[] } }).output.matches : [],
    },
    denied: {
      failure: failureCode(denied),
      executorFailure: executorCode(denied),
      lookupCalls: lookupCallsAfterDenied - lookupCallsAfterAuthorized,
    },
    approval: {
      waitingStatus: waiting.execution?.run.status,
      draftCallsWhileWaiting,
      pendingFailure: failureCode(pendingContinue),
      completedStatus: completed.execution?.run.status,
      draftCalls: calls.draft,
      draftId: completed.ok ? (completed.execution.state.values.draft as { output: { draftId: string } }).output.draftId : undefined,
      duplicateOk: duplicate.ok,
    },
    evidence: {
      traceValid,
      metricsOk: metrics.ok,
      inspectionStatus: inspection.summary.status,
      inspectionStatusSource: inspection.summary.statusSource,
      missingStatus: missingInspection.summary.status,
      missingReason: missingInspection.summary.statusReason,
    },
    evaluation: {
      ok: judged.ok,
      statuses: judged.ok ? judged.run.cases.map((entry) => entry.result.status) : [],
    },
  };
}
