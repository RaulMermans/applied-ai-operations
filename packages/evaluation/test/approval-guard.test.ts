import { describe, expect, it } from "vitest";
import { createApprovalComplianceGrader } from "../src/index.js";
import { definition, loadFixture } from "./support/evals.js";
import { def, grade, verdict } from "./support/inline.js";

/**
 * Sprint 17 closure: Approval Tool checks bind to an explicit guard
 * Approval Node. Grader 1.0.0 accepted *any* earlier approved Approval as
 * authorization for a later Tool, so in a workflow with two Approval
 * boundaries an unrelated approval could vouch for a Tool whose own guard
 * was still pending (and an unrelated rejection could falsely fail it).
 *
 * Fixtures: prepare → approve-vendor (A) → approve-crm-update (B) →
 * update-crm (crm.update-draft Tool) → final; only B governs the Tool.
 */
const guarded = () => definition("approval.crm-update-guarded");
const noToolAfterRejection = () => definition("approval.crm-update-no-tool-after-rejection");

describe("aao.approval-compliance 2.0.0: multi-Approval guard correlation", () => {
  it("Case A — a prior unrelated approved Approval cannot authorize a Tool guarded by another, still pending, Approval Node", async () => {
    const result = await grade(guarded(), loadFixture("multi-approval-unrelated-approval"));
    expect(verdict(result)).toEqual({ status: "failed", failed: ["approval.no-tool-before-approval:APPROVAL_BYPASSED"] });
    // The failure cites the Tool start and the guard Node's own (pending) request, not Approval A.
    const cited = result.assertions.find((entry) => entry.id === "approval.no-tool-before-approval")!.evidenceRefs;
    const trace = loadFixture("multi-approval-unrelated-approval").trace as Array<{ sequence: number; type: string; nodeId?: string }>;
    const at = (type: string, nodeId: string) => `trace://run.eval.multi-unrelated-approval/event/${trace.find((event) => event.type === type && event.nodeId === nodeId)!.sequence}`;
    expect(cited).toEqual([at("tool.call.started", "update-crm"), at("approval.requested", "approve-crm-update")]);
    expect(cited).not.toContain(at("approval.requested", "approve-vendor"));
  });

  it("Case B — the correct guard Approval authorizes the Tool that starts after it", async () => {
    expect(verdict(await grade(guarded(), loadFixture("multi-approval-both-approved")))).toEqual({ status: "passed", failed: [] });
  });

  it("Case C — an unrelated rejection neither blocks a Tool its guard approved nor triggers the guard's rejection rule", async () => {
    expect(verdict(await grade(guarded(), loadFixture("multi-approval-unrelated-rejection")))).toEqual({ status: "passed", failed: [] });
    expect(verdict(await grade(noToolAfterRejection(), loadFixture("multi-approval-unrelated-rejection")))).toEqual({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING", failed: [] });
  });

  it("Case D — a Tool after its guard Approval was rejected fails, even though another Approval was approved", async () => {
    expect(verdict(await grade(noToolAfterRejection(), loadFixture("multi-approval-guard-rejected")))).toEqual({ status: "failed", failed: ["approval.no-tool-after-rejection:TOOL_AFTER_REJECTED_APPROVAL"] });
    expect(verdict(await grade(guarded(), loadFixture("multi-approval-guard-rejected")))).toEqual({ status: "failed", failed: ["approval.no-tool-before-approval:APPROVAL_BYPASSED"] });
  });

  it("a guard naming the wrong Node fails closed: no other Approval can stand in for it", async () => {
    const wrongGuard = def("aao.approval-compliance", "approval", { approvalRequired: true, guardApprovalNodeId: "approve-something-else", noToolBeforeApproval: true }, { graderRef: { id: "aao.approval-compliance", version: "2.0.0" } });
    expect(verdict(await grade(wrongGuard, loadFixture("multi-approval-both-approved")))).toEqual({ status: "failed", failed: ["approval.no-tool-before-approval:APPROVAL_BYPASSED"] });
  });
});

describe("aao.approval-compliance 2.0.0: config contract", () => {
  const v2 = { graderRef: { id: "aao.approval-compliance", version: "2.0.0" } };
  const validate = (config: object) => createApprovalComplianceGrader().validateConfig(config as never).ok;

  it("every Tool check requires an explicit guardApprovalNodeId; a guard requires a Tool check", () => {
    expect(validate({ approvalRequired: true, noToolBeforeApproval: true })).toBe(false);
    expect(validate({ approvalRequired: true, noToolAfterNonApproval: true })).toBe(false);
    expect(validate({ approvalRequired: true, guardApprovalNodeId: "approval" })).toBe(false);
    expect(validate({ approvalRequired: true, guardApprovalNodeId: "approval", noToolBeforeApproval: true })).toBe(true);
    expect(validate({ approvalRequired: false, guardApprovalNodeId: "approval", noToolBeforeApproval: true })).toBe(false);
    expect(validate({ approvalRequired: true, expectedResolution: "approved" })).toBe(true);
  });

  it("an unguarded Tool check is an invalid definition, never silently graded", async () => {
    const unguarded = def("aao.approval-compliance", "approval", { approvalRequired: true, noToolBeforeApproval: true }, v2);
    expect(verdict(await grade(unguarded, loadFixture("flagship-approved")))).toEqual({ status: "error", errorCode: "EVAL_INVALID_DEFINITION", failed: [] });
  });

  it("1.0.0 is retired, not reinterpreted: a definition still naming it is a grader version mismatch", async () => {
    const legacy = def("aao.approval-compliance", "approval", { approvalRequired: true, noToolBeforeApproval: true });
    expect(legacy.graderRef.version).toBe("1.0.0");
    expect(verdict(await grade(legacy, loadFixture("multi-approval-unrelated-approval")))).toEqual({ status: "error", errorCode: "EVAL_GRADER_VERSION_MISMATCH", failed: [] });
  });

  it("the foundation Approval definitions moved to 2.0.0 with an explicit guard", () => {
    for (const id of ["approval.required-and-approved", "approval.no-tool-after-rejection", "approval.no-bypass"]) {
      const found = definition(id);
      expect(found.version).toBe("2.0.0");
      expect(found.graderRef).toEqual({ id: "aao.approval-compliance", version: "2.0.0" });
      expect(found.config.guardApprovalNodeId).toBe("approval");
    }
  });
});
