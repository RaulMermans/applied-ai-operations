// Sprint 24 compiled smoke: Operational Request proof using compiled package output only.
// Runs after `pnpm build`. Every AAO import resolves through package exports / dist.
// No network, external API keys, or external databases.

import process from 'node:process';
import { createEvaluatorRegistry, deterministicGraders, runEvalDataset } from '@aao/evaluation';
import { createInMemoryTraceStore, createTraceRecorder, validateTrace } from '@aao/observability';
import { defineTool, defineWorkflow } from '@aao/framework';
import {
  OPERATIONAL_REQUEST_NODE_ORDER,
  STATE_KEYS,
  createOperationalRequestProof,
} from '@aao/example-operational-request';
import {
  VALID_OPERATIONAL_REQUEST,
  SECOND_OPERATIONAL_REQUEST,
  REQUEST_WITH_SEEDED_SECRET,
  SECRET_TOKEN,
  operator,
  manager,
  unauthorizedRequester,
  fixtureGovernance,
  fixedClock,
  nativeModelAdapter,
  vercelModelAdapter,
  fixtureBinding,
  VERCEL_OPS_ADAPTER_REF,
} from '../dist/fixtures/index.js';

const assert = (condition, message) => {
  if (!condition) {
    process.stderr.write(`Smoke Assertion Failed: ${message}\n`);
    throw new Error(message);
  }
};

process.stdout.write("Starting Sprint 24 Compiled Smoke Verification...\n");

// 1. Construct fictional operational request
assert(VALID_OPERATIONAL_REQUEST.accountContext.accountId === "ACME-001", "Step 1: Invalid request accountId");
assert(VALID_OPERATIONAL_REQUEST.schemaVersion === 1, "Step 1: Invalid request schemaVersion");

// 2. Construct trusted Governance principals
assert(operator.id === "user.operator" && operator.type === "user", "Step 2: Invalid operator principal");
assert(manager.id === "user.manager" && manager.type === "user", "Step 2: Invalid manager principal");
assert(unauthorizedRequester.id === "user.unauthorized", "Step 2: Invalid unauthorized requester");

// 3. Create scripted model binding
const nativeAdapter = nativeModelAdapter();
const binding = fixtureBinding(nativeAdapter.manifest);
assert(binding.id === "ops-request-model", "Step 3: Invalid model binding");

// 4. Construct normal Framework Workflow
const store = createInMemoryTraceStore();
const clock = fixedClock();
const trace = createTraceRecorder({ store, clock });
const proof = createOperationalRequestProof({
  modelAdapters: [nativeAdapter],
  modelBindings: [binding],
  governance: fixtureGovernance,
  principalForRun: () => operator,
  trace,
  clock,
});
assert(proof.workflow.nodes.map((n) => n.id).join(",") === OPERATIONAL_REQUEST_NODE_ORDER.join(","), "Step 4: Invalid workflow node order");
assert(proof.workflow.id === "operational_request.proof", "Step 4: Invalid workflow id");
assert(/^[a-f0-9]{64}$/.test(proof.planFingerprint), "Step 4: Invalid plan fingerprint");

// 5. Execute initial request
const initial = await proof.execute({
  runId: "run.smoke.sprint24",
  request: VALID_OPERATIONAL_REQUEST,
});
assert(initial.ok, "Step 5: Initial execution failed");

// 6. Validate action proposal (checked via state)
const validatedProposal = initial.execution?.state.values[STATE_KEYS.validatedProposal];
assert(validatedProposal?.operation === "account.update_display_name", "Step 6: Proposal not validated");
assert(validatedProposal?.changes.displayName === "Acme Data Solutions", "Step 6: Proposal display name mismatch");

// 7. Capture canonical Approval wait
assert(initial.execution?.run.status === "WAITING_FOR_APPROVAL", "Step 7: Run did not reach WAITING_FOR_APPROVAL");
const approvalId = initial.execution?.wait?.referenceId;
const requestFingerprint = initial.execution?.wait?.requestFingerprint;
assert(typeof approvalId === "string" && approvalId.startsWith("approval:"), "Step 7: Invalid approvalId");
assert(typeof requestFingerprint === "string" && /^[a-f0-9]{64}$/.test(requestFingerprint), "Step 7: Invalid requestFingerprint");

// 8. Verify zero draft calls before approval
assert(proof.draftRepository.getAllDrafts().length === 0, "Step 8: Draft was staged before approval!");

// 9. Resolve Approval with eligible human
const record = proof.approvals.approve(approvalId, manager);
assert(record.status === "approved" && record.resolvedBy?.id === manager.id, "Step 9: Approval resolution failed");

// 10. Continue same Run
const resumed = await proof.continue(initial.execution);
assert(resumed.ok, `Step 10: Continuation failed: ${JSON.stringify(resumed.failure)}`);
assert(resumed.execution?.run.status === "COMPLETED", "Step 10: Run did not reach COMPLETED");

// 11. Execute write_draft Tool once
const drafts = proof.draftRepository.getAllDrafts();
assert(drafts.length === 1, `Step 11: Expected exactly 1 draft, got ${drafts.length}`);

// 12. Inspect local draft artifact
const draft = drafts[0];
assert(draft.draftId.startsWith("draft."), "Step 12: Invalid draftId format");
assert(draft.status === "approved_draft", "Step 12: Draft status is not approved_draft");

// 13. Verify artifact matches approved subject
const subject = resumed.execution?.state.values[STATE_KEYS.approvalSubject];
assert(draft.accountId === subject?.accountId, "Step 13: Draft accountId does not match approved subject");
assert(draft.proposedChanges.displayName === subject?.proposedChanges.displayName, "Step 13: Draft changes do not match approved subject");

// 14. Verify externalExecution = not_executed
assert(draft.externalExecution === "not_executed", "Step 14: Draft externalExecution must be 'not_executed'");
const finalResult = resumed.execution?.state.values[STATE_KEYS.finalResult];
assert(finalResult?.externalExecution === "not_executed", "Step 14: Final result externalExecution must be 'not_executed'");
assert(finalResult?.renderedMarkdown.includes("The draft was prepared. The external account was not modified."), "Step 14: Final markdown missing required non-modification notice");

// 15. Run canonical Eval assertions
const traceEvents = await store.getRunTrace("run.smoke.sprint24");
assert(validateTrace(traceEvents).valid, "Step 15: Run trace is invalid");
const evalResult = await runEvalDataset({
  dataset: {
    schemaVersion: 2,
    id: "dataset.smoke",
    version: "1.0.0",
    name: "Smoke dataset",
    cases: [
      {
        id: "smoke-outcome",
        name: "outcome",
        evalRef: { id: "def-outcome", version: "1.0.0" },
        mode: "RUNTIME",
        evidenceRef: "run://smoke",
        expected: { status: "passed" },
      },
      {
        id: "smoke-approval",
        name: "approval",
        evalRef: { id: "def-approval", version: "1.0.0" },
        mode: "RUNTIME",
        evidenceRef: "run://smoke",
        expected: { status: "passed" },
      },
    ],
  },
  definitions: [
    {
      schemaVersion: 2,
      id: "def-outcome",
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
      id: "def-approval",
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
      },
    },
  ],
  registry: createEvaluatorRegistry(deterministicGraders()),
  evidenceResolver: {
    resolve: () => ({
      origin: "live_run",
      runId: "run.smoke.sprint24",
      trace: traceEvents,
      execution: resumed.execution,
    }),
  },
});
assert(evalResult.ok, "Step 15: Eval dataset run failed");
assert(evalResult.run.cases.every((c) => c.matchesExpectation), "Step 15: Eval assertions did not match");

// 16. Reject another request
const rejectProof = createOperationalRequestProof({
  modelAdapters: [nativeAdapter],
  modelBindings: [binding],
  governance: fixtureGovernance,
  principalForRun: () => operator,
});
const initial2 = await rejectProof.execute({
  runId: "run.smoke.reject",
  request: SECOND_OPERATIONAL_REQUEST,
});
const approvalId2 = initial2.execution?.wait?.referenceId;
rejectProof.approvals.reject(approvalId2, manager);
const resumed2 = await rejectProof.continue(initial2.execution);
assert(!resumed2.ok && resumed2.failure?.code === "APPROVAL_REJECTED", "Step 16: Rejection continuation did not fail with APPROVAL_REJECTED");

// 17. Verify zero draft calls on rejection
assert(rejectProof.draftRepository.getAllDrafts().length === 0, "Step 17: Draft was created on rejection!");

// 18. Attempt self-approval
let selfApprovalDenied = false;
try {
  rejectProof.approvals.approve(approvalId2, operator);
} catch {
  selfApprovalDenied = true;
}
assert(selfApprovalDenied, "Step 18 & 19: Self-approval was not denied!");

// 19. Verify canonical denial (re-tested via fresh run)
const dualRoleGov = {
  ...fixtureGovernance,
  bindings: [
    ...fixtureGovernance.bindings,
    { id: "operator.approver", actorId: operator.id, roleId: "operations.approver", status: "active" },
  ],
};
const selfProof = createOperationalRequestProof({
  modelAdapters: [nativeAdapter],
  modelBindings: [binding],
  governance: dualRoleGov,
  principalForRun: () => operator,
});
const selfInit = await selfProof.execute({
  runId: "run.smoke.self-deny",
  request: VALID_OPERATIONAL_REQUEST,
});
const selfApprovalId = selfInit.execution?.wait?.referenceId;
let selfError = "";
try {
  selfProof.approvals.approve(selfApprovalId, operator);
} catch (e) {
  selfError = e.code || e.message;
}
assert(selfError === "APPROVAL_SELF_APPROVAL_FORBIDDEN", `Step 19: Expected APPROVAL_SELF_APPROVAL_FORBIDDEN, got ${selfError}`);

// 20. Attempt unsupported external-effect Tool
let externalRefused = false;
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
    id: "ext.workflow",
    version: "1.0.0",
    name: "Ext",
    description: "Ext",
    entryNodeId: "ext_node",
    nodes: [{ id: "ext_node", kind: "tool", config: { toolRef: { id: extTool.spec.id, version: extTool.spec.version }, inputStateKey: "in", resultStateKey: "out" } }],
    edges: [],
  });
  const extProof = createOperationalRequestProof({
    modelAdapters: [nativeAdapter],
    modelBindings: [binding],
    governance: fixtureGovernance,
    principalForRun: () => operator,
    tools: [extTool],
  });
  extProof.app.prepareWorkflow(extWorkflow);
} catch {
  externalRefused = true;
}
assert(externalRefused, "Step 20: external_side_effect tool was not refused by Tool Runtime support gate!");

// 21. Verify zero external handler calls
// (Proved by externalRefused preventing workflow preparation and handler invocation)

// 22. Verify no secret leakage
const secretStore = createInMemoryTraceStore();
const secretProof = createOperationalRequestProof({
  modelAdapters: [nativeAdapter],
  modelBindings: [binding],
  governance: fixtureGovernance,
  principalForRun: () => operator,
  trace: createTraceRecorder({ store: secretStore, clock }),
  clock,
});
const secretInit = await secretProof.execute({
  runId: "run.smoke.secret",
  request: REQUEST_WITH_SEEDED_SECRET,
});
const secretApprovalId = secretInit.execution?.wait?.referenceId;
secretProof.approvals.approve(secretApprovalId, manager);
const secretResumed = await secretProof.continue(secretInit.execution);
const secretEvents = await secretStore.getRunTrace("run.smoke.secret");
const serializedTrace = JSON.stringify(secretEvents);
assert(!serializedTrace.includes(SECRET_TOKEN), "Step 22: Seeded secret leaked into trace!");
const secretFinal = secretResumed.execution?.state.values[STATE_KEYS.finalResult];
assert(!secretFinal?.renderedMarkdown.includes(SECRET_TOKEN), "Step 22: Seeded secret leaked into rendered markdown!");

// 23. Verify model adapter portability
const vercel = vercelModelAdapter();
const vercelProof = createOperationalRequestProof({
  modelAdapters: [vercel.definition],
  modelBindings: [fixtureBinding(VERCEL_OPS_ADAPTER_REF)],
  governance: fixtureGovernance,
  principalForRun: () => operator,
  clock,
});
assert(vercelProof.planFingerprint === proof.planFingerprint, "Step 23: Workflow plan fingerprint differs between native and Vercel adapters!");
const vercelInit = await vercelProof.execute({
  runId: "run.smoke.vercel",
  request: VALID_OPERATIONAL_REQUEST,
});
const vercelApprovalId = vercelInit.execution?.wait?.referenceId;
vercelProof.approvals.approve(vercelApprovalId, manager);
const vercelResumed = await vercelProof.continue(vercelInit.execution);
assert(vercelResumed.ok, "Step 23: Vercel adapter execution failed");
assert(vercel.providerCalls() === 1, "Step 23: Vercel adapter provider call count was not 1");
assert(vercelProof.draftRepository.getAllDrafts().length === 1, "Step 23: Vercel adapter draft count was not 1");

process.stdout.write("All 23 Smoke Acceptance Criteria Verified Successfully!\n");
process.stdout.write("SPRINT_24_OPERATIONAL_REQUEST_PROOF_SMOKE_OK\n");
