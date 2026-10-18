import {
  manager,
  VALID_OPERATIONAL_REQUEST,
  SECOND_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";
import {
  createFixtureProof,
} from "../fixtures/index.js";
import { STATE_KEYS, type OperationalRequestResult } from "../src/index.js";

async function main() {
  console.log("=== AAO Sprint 24 — Governed Operational Request Demo ===\n");

  // ---------------------------------------------------------------------------
  // Case A: Approval Required (Waitpoint Reached)
  // ---------------------------------------------------------------------------
  console.log("--- Case A: Approval Required (Waitpoint Reached) ---");
  const { proof: proofA } = createFixtureProof();
  const runA = await proofA.execute({
    runId: "run.demo.case-a",
    request: VALID_OPERATIONAL_REQUEST,
  });

  console.log(`Run status: ${runA.execution?.run.status}`);
  console.log(`Wait kind: ${runA.execution?.wait?.kind}`);
  console.log(`Approval reference ID: ${runA.execution?.wait?.referenceId}`);
  console.log(`Request fingerprint: ${runA.execution?.wait?.requestFingerprint}`);
  console.log(`Drafts created in repository: ${proofA.draftRepository.getAllDrafts().length}`);
  if (runA.execution?.run.status !== "WAITING_FOR_APPROVAL") {
    throw new Error("Case A expected WAITING_FOR_APPROVAL");
  }
  if (proofA.draftRepository.getAllDrafts().length !== 0) {
    throw new Error("Case A draft repository must have 0 drafts");
  }
  console.log("✓ Case A demonstrated: workflow paused at human approval waitpoint; 0 drafts created.\n");

  // ---------------------------------------------------------------------------
  // Case B: Approved (Human Approves -> Draft Staged -> Result Rendered)
  // ---------------------------------------------------------------------------
  console.log("--- Case B: Approved (Eligible Human Approval & Draft Creation) ---");
  const { proof: proofB } = createFixtureProof();
  const runBInit = await proofB.execute({
    runId: "run.demo.case-b",
    request: VALID_OPERATIONAL_REQUEST,
  });

  const approvalIdB = runBInit.execution?.wait?.referenceId;
  if (!approvalIdB) throw new Error("Missing approvalId for Case B");

  console.log(`Initial execution status: ${runBInit.execution?.run.status}`);
  console.log(`Resolving approval with eligible approver: ${manager.id}`);
  const approvalRecordB = proofB.approvals.approve(approvalIdB, manager);
  console.log(`Approval record status: ${approvalRecordB.status} by ${approvalRecordB.resolvedBy?.id}`);

  console.log("Continuing workflow after approval...");
  const runBCont = await proofB.continue(runBInit.execution!);
  console.log(`Resumed run status: ${runBCont.execution?.run.status}`);

  const draftsB = proofB.draftRepository.getAllDrafts();
  console.log(`Drafts created in repository: ${draftsB.length}`);
  if (draftsB.length !== 1) throw new Error("Case B expected exactly 1 draft");

  const draftB = draftsB[0]!;
  console.log(`Created draft ID: ${draftB.draftId}`);
  console.log(`Draft status: ${draftB.status}`);
  console.log(`External execution: ${draftB.externalExecution}`);

  const finalResultB = runBCont.execution?.state.values[STATE_KEYS.finalResult] as unknown as OperationalRequestResult;
  console.log("\nRendered Markdown Output:");
  console.log(finalResultB.renderedMarkdown);
  if (finalResultB.externalExecution !== "not_executed") {
    throw new Error("Case B externalExecution must be 'not_executed'");
  }
  console.log("✓ Case B demonstrated: eligible approval resumes workflow; 1 local draft created; external account NOT modified.\n");

  // ---------------------------------------------------------------------------
  // Case C: Rejected (Human Rejection -> Terminal FAILED -> 0 Drafts)
  // ---------------------------------------------------------------------------
  console.log("--- Case C: Rejected (Eligible Human Rejection) ---");
  const { proof: proofC } = createFixtureProof();
  const runCInit = await proofC.execute({
    runId: "run.demo.case-c",
    request: SECOND_OPERATIONAL_REQUEST,
  });

  const approvalIdC = runCInit.execution?.wait?.referenceId;
  if (!approvalIdC) throw new Error("Missing approvalId for Case C");

  console.log(`Initial execution status: ${runCInit.execution?.run.status}`);
  console.log(`Resolving rejection with eligible approver: ${manager.id}`);
  const approvalRecordC = proofC.approvals.reject(approvalIdC, manager);
  console.log(`Approval record status: ${approvalRecordC.status} by ${approvalRecordC.resolvedBy?.id}`);

  console.log("Continuing workflow after rejection...");
  const runCCont = await proofC.continue(runCInit.execution!);
  console.log(`Resumed run status: ${runCCont.execution?.run.status}`);
  const failureCode = !runCCont.ok ? runCCont.failure?.code : undefined;
  console.log(`Failure code: ${failureCode}`);
  console.log(`Drafts created in repository: ${proofC.draftRepository.getAllDrafts().length}`);

  if (runCCont.ok || runCCont.execution?.run.status !== "FAILED" || runCCont.failure?.code !== "APPROVAL_REJECTED") {
    throw new Error("Case C expected FAILED with APPROVAL_REJECTED");
  }
  if (proofC.draftRepository.getAllDrafts().length !== 0) {
    throw new Error("Case C expected 0 drafts");
  }
  console.log("✓ Case C demonstrated: human rejection terminates workflow; 0 drafts created.\n");

  console.log("=== Demo Completed Successfully ===");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
