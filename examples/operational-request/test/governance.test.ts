import { describe, expect, it } from "vitest";
import {
  serviceActor,
  createFixtureProof,
  governanceWithRevokedApprover,
  governanceWithRevokedRequester,
  manager,
  operator,
  unauthorizedRequester,
  VALID_OPERATIONAL_REQUEST,
  viewer,
  fixedClock,
} from "../fixtures/index.js";
import type { Principal } from "@aao/framework";
import { createOperationalRequestProof } from "../src/proof.js";
import { fixtureBinding, nativeModelAdapter } from "../fixtures/models.js";
import { fixtureGovernance } from "../fixtures/governance.js";
import { failureCode, failureNodeId } from "./support.js";
import { continueApprovedWorkflow, createApprovalEngine } from "@aao/approval";
import { createGovernanceRegistry } from "@aao/governance";
import { compileWorkflow } from "@aao/workflow-dsl";
import { operationalRequestWorkflow } from "../src/workflow.js";

describe("Separation of Duties & Governance Enforcement", () => {
  it("eligible human manager in operations.approver role successfully approves", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.gov.eligible",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    const record = proof.approvals.approve(approvalId, manager);
    expect(record.status).toBe("approved");
    expect(record.resolvedBy?.id).toBe(manager.id);
  });

  it("prohibits requester self-approval (APPROVAL_SELF_APPROVAL_FORBIDDEN)", async () => {
    // A user who holds BOTH requester and approver roles
    const dualRoleGov = {
      ...fixtureGovernance,
      bindings: [
        ...fixtureGovernance.bindings,
        { id: "operator.approver", actorId: operator.id, roleId: "operations.approver", status: "active" as const },
      ],
    };
    const model = nativeModelAdapter();
    const proof = createOperationalRequestProof({
      modelAdapters: [model],
      modelBindings: [fixtureBinding(model.manifest)],
      governance: dualRoleGov,
      principalForRun: () => operator,
    });
    const initial = await proof.execute({
      runId: "run.gov.self-approval",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");

    expect(() => {
      proof.approvals.approve(approvalId, operator);
    }).toThrowError(/APPROVAL_SELF_APPROVAL_FORBIDDEN/);

    const record = proof.approvals.get(approvalId);
    expect(record?.status).toBe("pending");
  });

  it("prohibits machine/agent actor from approving (APPROVAL_HUMAN_REQUIRED)", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.gov.agent-approval",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");

    // 1. Service principal (non-human)
    expect(() => {
      proof.approvals.approve(approvalId, serviceActor);
    }).toThrowError(/APPROVAL_HUMAN_REQUIRED/);

    // 2. Synthetic agent principal
    expect(() => {
      proof.approvals.approve(approvalId, { id: "agent.bot", type: "agent" } as unknown as Principal);
    }).toThrowError(/APPROVAL_HUMAN_REQUIRED/);
  });

  it("prohibits unregistered human actor from approving (APPROVAL_RESOLVER_NOT_ELIGIBLE)", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.gov.unregistered-approval",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");

    const unknownUser = { id: "user.stranger", type: "user" as const };
    expect(() => {
      proof.approvals.approve(approvalId, unknownUser);
    }).toThrowError(/APPROVAL_RESOLVER_NOT_ELIGIBLE/);
  });

  it("prohibits registered human without operations.approver role from approving", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.gov.wrong-role-approval",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");

    expect(() => {
      proof.approvals.approve(approvalId, viewer);
    }).toThrowError(/APPROVAL_RESOLVER_NOT_ELIGIBLE/);
  });

  it("rejects duplicate resolution attempts on an already resolved approval", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.gov.duplicate-resolution",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");

    proof.approvals.approve(approvalId, manager);

    // Second resolution attempt fails closed
    expect(() => {
      proof.approvals.approve(approvalId, manager);
    }).toThrowError(/APPROVAL_ALREADY_RESOLVED/);

    expect(() => {
      proof.approvals.reject(approvalId, manager);
    }).toThrowError(/APPROVAL_ALREADY_RESOLVED/);
  });

  it("fails closed when requester lacks write_draft authority", async () => {
    const model = nativeModelAdapter();
    const proof = createOperationalRequestProof({
      modelAdapters: [model],
      modelBindings: [fixtureBinding(model.manifest)],
      governance: fixtureGovernance,
      principalForRun: () => unauthorizedRequester, // unauthorized requester has no write_draft
    });

    const initial = await proof.execute({
      runId: "run.gov.unauthorized-requester",
      request: VALID_OPERATIONAL_REQUEST,
    });

    expect(initial.ok).toBe(false);
    expect(failureCode(initial)).toBe("NODE_EXECUTION_FAILED");
    expect(failureNodeId(initial)).toBe("require_approval");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("revalidates and refuses continuation if requester authority was revoked before continuation", async () => {
    // 1. Initial run under valid governance reaches WAITING_FOR_APPROVAL
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.gov.revoked-requester-continuation",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    const approvedRecord = proof.approvals.approve(approvalId, manager);
    expect(approvedRecord.status).toBe("approved");

    // 2. Revalidation under revoked requester governance halts continuation
    const revokedGovRegistry = createGovernanceRegistry(governanceWithRevokedRequester());
    const revokedEngine = createApprovalEngine({
      governance: revokedGovRegistry,
      clock: fixedClock(),
      repository: {
        get: (id) => (id === approvedRecord.approvalId ? approvedRecord : undefined),
        create: (r) => r,
        compareAndSetResolution: () => true,
      },
    });

    expect(revokedEngine.revalidateApproved(approvedRecord)).toBe("APPROVAL_REQUESTER_NOT_AUTHORIZED");
    const compiled = compileWorkflow(operationalRequestWorkflow);
    if (!compiled.ok) throw new Error("Workflow compilation failed");

    const continuationResult = await continueApprovedWorkflow(revokedEngine, {
      plan: compiled.plan,
      registry: { get: () => undefined } as never,
      execution: initial.execution!,
      options: { clock: fixedClock() },
    });

    expect(continuationResult.ok).toBe(false);
    expect(failureCode(continuationResult)).toBe("APPROVAL_REQUESTER_NOT_AUTHORIZED");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("revalidates and refuses continuation if approver role was revoked before continuation", async () => {
    // 1. Initial run under valid governance reaches WAITING_FOR_APPROVAL
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.gov.revoked-approver-continuation",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    const approvedRecord = proof.approvals.approve(approvalId, manager);
    expect(approvedRecord.status).toBe("approved");

    // 2. Revalidation under revoked approver governance halts continuation
    const revokedGovRegistry = createGovernanceRegistry(governanceWithRevokedApprover());
    const revokedEngine = createApprovalEngine({
      governance: revokedGovRegistry,
      clock: fixedClock(),
      repository: {
        get: (id) => (id === approvedRecord.approvalId ? approvedRecord : undefined),
        create: (r) => r,
        compareAndSetResolution: () => true,
      },
    });

    expect(revokedEngine.revalidateApproved(approvedRecord)).toBe("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    const compiled = compileWorkflow(operationalRequestWorkflow);
    if (!compiled.ok) throw new Error("Workflow compilation failed");

    const continuationResult = await continueApprovedWorkflow(revokedEngine, {
      plan: compiled.plan,
      registry: { get: () => undefined } as never,
      execution: initial.execution!,
      options: { clock: fixedClock() },
    });

    expect(continuationResult.ok).toBe(false);
    expect(failureCode(continuationResult)).toBe("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when approver role is revoked prior to approval (attempting approval or continuation)", async () => {
    // 1. Setup proof with revoked approver role
    const model = nativeModelAdapter();
    const proof = createOperationalRequestProof({
      modelAdapters: [model],
      modelBindings: [fixtureBinding(model.manifest)],
      governance: governanceWithRevokedApprover(),
      principalForRun: () => operator,
    });

    // 2. Start request -> reaches WAITING_FOR_APPROVAL
    const initial = await proof.execute({
      runId: "run.gov.revoked-approver-pre-approval",
      request: VALID_OPERATIONAL_REQUEST,
    });
    expect(initial.execution?.run.status).toBe("WAITING_FOR_APPROVAL");
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");

    // 3. Attempting approval by manager with revoked role throws APPROVAL_RESOLVER_NOT_ELIGIBLE
    expect(() => {
      proof.approvals.approve(approvalId, manager);
    }).toThrowError(/APPROVAL_RESOLVER_NOT_ELIGIBLE/);

    // 4. Attempting continuation fails because approval remains pending
    const resumed = await proof.continue(initial.execution!);
    expect(resumed.ok).toBe(false);
    expect(failureCode(resumed)).toBe("APPROVAL_STILL_PENDING");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);
  });
});
