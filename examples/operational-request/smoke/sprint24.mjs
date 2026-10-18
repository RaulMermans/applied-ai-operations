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
  createInMemoryDraftRepository,
  createOperationalDraftTool,
  createOperationalApprovalVerifier,
  renderOperationalMarkdown,
} from '@aao/example-operational-request';
import { deriveToolExecutionId } from '@aao/tool-runtime';
import {
  VALID_OPERATIONAL_REQUEST,
  SECOND_OPERATIONAL_REQUEST,
  REQUEST_WITH_SEEDED_SECRET,
  REQUEST_WITH_SECRET_DO_NOT_PERSIST,
  SECRET_TOKEN,
  SECRET_DO_NOT_PERSIST,
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

// 9. Resolve Approval with eligible human (Point 2: Manager approves Run A)
const record = proof.approvals.approve(approvalId, manager);
assert(record.status === "approved" && record.resolvedBy?.id === manager.id, "Step 9 / Point 2: Approval resolution failed");

// --- SPRINT 24D VERIFICATION POINTS 3, 4, 5, 6 ---
// 3. Run B attempts use of Run A Approval.
const runBToolExecutionId = deriveToolExecutionId("run.smoke.attack-B", "create_draft");
const draftTool = createOperationalDraftTool({
  repository: proof.draftRepository,
  approvalVerifier: proof.approvalVerifier,
});
const attackResult = await draftTool.handler.execute({
  input: {
    requestId: VALID_OPERATIONAL_REQUEST.requestId,
    accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
    operation: "account.update_display_name",
    proposedChanges: { displayName: "Acme Data Solutions" },
    approvalBinding: {
      approvalId,
      requestFingerprint,
      runId: "run.smoke.sprint24", // caller supplies Run A's runId
    },
  },
  runId: "run.smoke.attack-B",
  toolExecutionId: runBToolExecutionId,
  grantedPermissionClasses: ["write_draft"],
});
// 4. Run B is denied.
assert(!attackResult.ok, "Point 4: Run B attack was not denied!");
assert(attackResult.code === "INVALID_APPROVAL_CONTEXT", `Point 4: Expected INVALID_APPROVAL_CONTEXT, got ${attackResult.code}`);
// 5. Run B creates zero drafts.
assert(proof.draftRepository.getAllDrafts().length === 0, "Point 5: Run B created drafts!");
// 6. Run A Approval remains usable.
assert(proof.approvalVerifier.getConsumptionState(approvalId) === "AVAILABLE", "Point 6: Run A approval was consumed by Run B attack!");

// 10. Continue same Run (Point 7: Run A continues)
const resumed = await proof.continue(initial.execution);
assert(resumed.ok, `Step 10 / Point 7: Continuation failed: ${JSON.stringify(resumed.failure)}`);
assert(resumed.execution?.run.status === "COMPLETED", "Step 10 / Point 7: Run did not reach COMPLETED");

// 11. Execute write_draft Tool once (Point 8: Exact draft is created once)
const drafts = proof.draftRepository.getAllDrafts();
assert(drafts.length === 1, `Step 11 / Point 8: Expected exactly 1 draft, got ${drafts.length}`);

// 12. Inspect local draft artifact
const draft = drafts[0];
assert(draft.draftId.startsWith("draft."), "Step 12: Invalid draftId format");
assert(draft.status === "approved_draft", "Step 12: Draft status is not approved_draft");

// 13. Verify artifact matches approved subject (Point 8 continued)
const subject = resumed.execution?.state.values[STATE_KEYS.approvalSubject];
assert(draft.accountId === subject?.accountId, "Step 13 / Point 8: Draft accountId does not match approved subject");
assert(draft.proposedChanges.displayName === subject?.proposedChanges.displayName, "Step 13 / Point 8: Draft changes do not match approved subject");

// --- SPRINT 24D VERIFICATION POINT 9: Repository replay is idempotent ---
const canonicalToolExecutionIdA = deriveToolExecutionId("run.smoke.sprint24", "create_draft");
const replayResult = await draftTool.handler.execute({
  input: {
    requestId: VALID_OPERATIONAL_REQUEST.requestId,
    accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
    operation: "account.update_display_name",
    proposedChanges: { displayName: "Acme Data Solutions" },
    approvalBinding: {
      approvalId,
      requestFingerprint,
      runId: "run.smoke.sprint24",
    },
  },
  runId: "run.smoke.sprint24",
  toolExecutionId: canonicalToolExecutionIdA,
  grantedPermissionClasses: ["write_draft"],
});
assert(replayResult.ok, "Point 9: Idempotent replay failed");
assert(proof.draftRepository.getAllDrafts().length === 1, "Point 9: Idempotent replay created duplicate drafts!");

// --- SPRINT 24D VERIFICATION POINTS 10 & 11: Persistence safety & consumption commit ---
// 10. Persistence failure does not permanently consume a definitely uncommitted Approval.
const baseFailRepo = createInMemoryDraftRepository();
let throwBeforeSave = true;
const failRepo = {
  ...baseFailRepo,
  async saveDraft(execId, d) {
    if (throwBeforeSave) {
      throwBeforeSave = false;
      throw new Error("Simulated storage failure before write");
    }
    return baseFailRepo.saveDraft(execId, d);
  },
};
const recProof = createOperationalRequestProof({
  modelAdapters: [nativeAdapter],
  modelBindings: [binding],
  governance: fixtureGovernance,
  principalForRun: () => operator,
  clock,
});
const recInit = await recProof.execute({
  runId: "run.smoke.recovery",
  request: VALID_OPERATIONAL_REQUEST,
});
const recAppId = recInit.execution?.wait?.referenceId;
const recFp = recInit.execution?.wait?.requestFingerprint;
recProof.approvals.approve(recAppId, manager);

const recVerifier = createOperationalApprovalVerifier({ getApproval: (id) => recProof.approvals.get(id) });
const recExecId = deriveToolExecutionId("run.smoke.recovery", "create_draft");
recVerifier.attestExecutionOrigin("run.smoke.recovery", recExecId);

const recTool = createOperationalDraftTool({
  repository: failRepo,
  approvalVerifier: recVerifier,
});
const failCall = await recTool.handler.execute({
  input: {
    requestId: VALID_OPERATIONAL_REQUEST.requestId,
    accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
    operation: "account.update_display_name",
    proposedChanges: { displayName: "Acme Data Solutions" },
    approvalBinding: { approvalId: recAppId, requestFingerprint: recFp, runId: "run.smoke.recovery" },
  },
  runId: "run.smoke.recovery",
  toolExecutionId: recExecId,
  grantedPermissionClasses: ["write_draft"],
});
assert(!failCall.ok, "Point 10: Expected failure on uncommitted save error");
assert(failRepo.getAllDrafts().length === 0, "Point 10: Draft was saved despite error");
assert(recVerifier.getConsumptionState(recAppId) === "AVAILABLE", "Point 10: Approval was prematurely consumed on save failure!");

// 11. Successful persistence commits consumption.
const successCall = await recTool.handler.execute({
  input: {
    requestId: VALID_OPERATIONAL_REQUEST.requestId,
    accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
    operation: "account.update_display_name",
    proposedChanges: { displayName: "Acme Data Solutions" },
    approvalBinding: { approvalId: recAppId, requestFingerprint: recFp, runId: "run.smoke.recovery" },
  },
  runId: "run.smoke.recovery",
  toolExecutionId: recExecId,
  grantedPermissionClasses: ["write_draft"],
});
assert(successCall.ok, "Point 11: Recovery invocation failed");
assert(failRepo.getAllDrafts().length === 1, "Point 11: Draft was not persisted on recovery");
assert(recVerifier.getConsumptionState(recAppId) === "COMMITTED", "Point 11: Approval was not committed on successful persistence!");

// 14. Verify externalExecution = not_executed (Point 13: Final result confirms no external modification)
assert(draft.externalExecution === "not_executed", "Step 14 / Point 13: Draft externalExecution must be 'not_executed'");
const finalResult = resumed.execution?.state.values[STATE_KEYS.finalResult];
assert(finalResult?.externalExecution === "not_executed", "Step 14 / Point 13: Final result externalExecution must be 'not_executed'");
assert(finalResult?.renderedMarkdown.includes("The draft was prepared. The external account was not modified."), "Step 14 / Point 13: Final markdown missing required non-modification notice");

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

// Also verify SECRET_DO_NOT_PERSIST does not leak in failure paths
const secretStoreDnp = createInMemoryTraceStore();
const secretProofDnp = createOperationalRequestProof({
  modelAdapters: [nativeAdapter],
  modelBindings: [binding],
  governance: fixtureGovernance,
  principalForRun: () => operator,
  trace: createTraceRecorder({ store: secretStoreDnp, clock }),
  clock,
});
const secretInitDnp = await secretProofDnp.execute({
  runId: "run.smoke.secret-dnp",
  request: REQUEST_WITH_SECRET_DO_NOT_PERSIST,
});
const secretAppIdDnp = secretInitDnp.execution?.wait?.referenceId;
secretProofDnp.approvals.approve(secretAppIdDnp, manager);
const secretResumedDnp = await secretProofDnp.continue(secretInitDnp.execution);
const secretEventsDnp = await secretStoreDnp.getRunTrace("run.smoke.secret-dnp");
assert(!JSON.stringify(secretEventsDnp).includes(SECRET_DO_NOT_PERSIST), "Step 22: SECRET_DO_NOT_PERSIST leaked into trace!");
const secretFinalDnp = secretResumedDnp.execution?.state.values[STATE_KEYS.finalResult];
assert(!secretFinalDnp?.renderedMarkdown.includes(SECRET_DO_NOT_PERSIST), "Step 22: SECRET_DO_NOT_PERSIST leaked into rendered markdown!");

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

// 24. Cross-state request ID mutation cannot alter the draft
const tamperProof = createOperationalRequestProof({
  modelAdapters: [nativeAdapter],
  modelBindings: [binding],
  governance: fixtureGovernance,
  principalForRun: () => operator,
  clock,
});
const tamperInit = await tamperProof.execute({
  runId: "run.smoke.tamper",
  request: VALID_OPERATIONAL_REQUEST,
});
const tamperApprovalId = tamperInit.execution?.wait?.referenceId;
tamperProof.approvals.approve(tamperApprovalId, manager);
tamperInit.execution.state.values[STATE_KEYS.normalizedRequest] = {
  ...tamperInit.execution.state.values[STATE_KEYS.normalizedRequest],
  requestId: "tampered-request-id",
  accountId: "ACME-TAMPERED",
};
const tamperResumed = await tamperProof.continue(tamperInit.execution);
assert(tamperResumed.ok, "Step 24: Tamper execution failed to continue");
const tamperedDrafts = tamperProof.draftRepository.getAllDrafts();
assert(tamperedDrafts.length === 1, "Step 24: Tamper test expected exactly 1 draft");
assert(tamperedDrafts[0].requestId === VALID_OPERATIONAL_REQUEST.requestId, "Step 24: Tampered requestId influenced draft!");
assert(tamperedDrafts[0].accountId === VALID_OPERATIONAL_REQUEST.accountContext.accountId, "Step 24: Tampered accountId influenced draft!");

// 25. Forged Approval cannot create a draft
const forgedProof = createOperationalRequestProof({
  modelAdapters: [nativeAdapter],
  modelBindings: [binding],
  governance: fixtureGovernance,
  principalForRun: () => operator,
});
const forgedTool = createOperationalDraftTool({
  repository: forgedProof.draftRepository,
  approvalVerifier: createOperationalApprovalVerifier({
    getApproval: (id) => forgedProof.approvals.get(id),
  }),
});
const forgedResult = await forgedTool.handler.execute({
  input: {
    requestId: "REQ-FORGED",
    accountId: "ACME-001",
    operation: "account.update_display_name",
    proposedChanges: { displayName: "Forged Name" },
    approvalBinding: {
      approvalId: "approval:forged-id",
      requestFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      runId: "run.smoke.forged",
    },
  },
  runId: "run.smoke.forged",
  toolExecutionId: "exec.forged",
  grantedPermissionClasses: ["write_draft"],
});
assert(!forgedResult.ok, "Step 25: Forged approval was not rejected!");
assert(forgedResult.code === "APPROVAL_NOT_FOUND" || forgedResult.code === "APPROVAL_VERIFICATION_FAILED", `Step 25: Unexpected code ${forgedResult.code}`);
assert(forgedProof.draftRepository.getAllDrafts().length === 0, "Step 25: Draft created with forged approval!");

// 26. Alternate workflow invocation cannot assert approved status
const altDraftRepo = createInMemoryDraftRepository();
const altTool = createOperationalDraftTool({
  repository: altDraftRepo,
  approvalVerifier: createOperationalApprovalVerifier({
    getApproval: (id) => proof.approvals.get(id),
  }),
});
const altWorkflow = defineWorkflow({
  schemaVersion: 1,
  id: "alt.workflow",
  version: "1.0.0",
  name: "Alternate Workflow Without Approval Guard",
  description: "Attempts draft creation without approval guard",
  entryNodeId: "draft_node",
  nodes: [
    {
      id: "draft_node",
      kind: "tool",
      config: {
        toolRef: { id: altTool.spec.id, version: altTool.spec.version },
        inputStateKey: "draftInput",
        resultStateKey: "draftResult",
      },
    },
    {
      id: "final_node",
      kind: "final_output",
      config: {},
    },
  ],
  edges: [{ sourceNodeId: "draft_node", targetNodeId: "final_node" }],
});

const altProof = createOperationalRequestProof({
  modelAdapters: [nativeAdapter],
  modelBindings: [binding],
  governance: fixtureGovernance,
  principalForRun: () => operator,
  tools: [altTool],
});
const preparedAlt = altProof.app.prepareWorkflow(altWorkflow);
const altExecResult = await preparedAlt.execute({
  runId: "run.smoke.alt",
  initialState: {
    runId: "run.smoke.alt",
    revision: 0,
    values: {
      draftInput: {
        requestId: "REQ-ALT",
        accountId: "ACME-001",
        operation: "account.update_display_name",
        proposedChanges: { displayName: "Unapproved Name" },
        approvalBinding: {
          approvalId: "approval:forged",
          requestFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          runId: "run.smoke.alt",
        },
      },
    },
  },
});
assert(!altExecResult.ok || altExecResult.execution?.run.status === "FAILED", "Step 26: Alternate workflow without approval guard should fail");
assert(altDraftRepo.getAllDrafts().length === 0, "Step 26: Alternate workflow created a draft!");

// 27. Replayed continuation cannot duplicate a draft
await proof.continue(resumed.execution);
assert(proof.draftRepository.getAllDrafts().length === 1, "Step 27: Replaying continuation duplicated drafts!");

// 28. Rendered Markdown escapes injected headings, links, HTML, backticks, table pipes, and control characters
const dangerousInput = "# Heading\n<script>alert(1)</script>\n| Pipe | Column |\n`code_span`\n[Link](https://evil.com)\x00\x08";
const renderedMarkdown = renderOperationalMarkdown({
  requestId: "req.injection",
  operation: "account.update_display_name",
  accountId: "ACME-001",
  displayName: dangerousInput,
  draftId: "draft.test",
  approvalId: "approval:test",
  draftStatus: "approved_draft",
  externalExecution: "not_executed",
});
assert(!renderedMarkdown.includes("<script>"), "Step 28: Raw script tag found in markdown");
assert(renderedMarkdown.includes("&lt;script&gt;"), "Step 28: HTML escaping missing in markdown");
assert(!renderedMarkdown.includes("\x00") && !renderedMarkdown.includes("\x08"), "Step 28: Control characters not stripped");
assert(renderedMarkdown.includes("\\# Heading"), "Step 28: Heading marker '#' not escaped");
assert(renderedMarkdown.includes("\\| Pipe \\|"), "Step 28: Table pipe '|' not escaped");
assert(renderedMarkdown.includes("\\[Link\\]"), "Step 28: Link bracket '[' not escaped");
assert(renderedMarkdown.includes("\\`code\\_span\\`"), "Step 28: Code backtick or underscore not escaped");

process.stdout.write("All 28 Smoke Acceptance Criteria Verified Successfully!\n");
process.stdout.write("SPRINT_24_OPERATIONAL_REQUEST_PROOF_SMOKE_OK\n");
