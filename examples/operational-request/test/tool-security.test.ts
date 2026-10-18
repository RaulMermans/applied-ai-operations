import { describe, expect, it } from "vitest";
import {
  createAAO,
  defineWorkflow,
  type ToolDefinition,
} from "@aao/framework";
import {
  createToolRegistry,
  deriveToolExecutionId,
  executeTool,
  type ExecuteToolParams,
} from "@aao/tool-runtime";

type AuthorizationContext = ExecuteToolParams["authorizationContext"];
import {
  approvalIdForFingerprint,
  createApprovalEngine,
  fingerprintApprovalSubject,
} from "@aao/approval";
import { createGovernanceRegistry } from "@aao/governance";
import {
  CREATE_CHANGE_DRAFT_TOOL_REF,
  createInMemoryDraftRepository,
  createOperationalApprovalVerifier,
  createOperationalDraftTool,
  createOperationalRequestProof,
  type CreateChangeDraftToolInput,
  type OperationalApprovalSubject,
  type OperationalChangeDraft,
} from "../src/index.js";
import {
  fixtureGovernance,
  fixedClock,
  manager,
  operator,
  VALID_OPERATIONAL_REQUEST,
  nativeModelAdapter,
  fixtureBinding,
} from "../fixtures/index.js";

const VALID_SUBJECT: OperationalApprovalSubject = {
  schemaVersion: 1,
  requestId: VALID_OPERATIONAL_REQUEST.requestId,
  operation: "account.update_display_name",
  accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
  proposedChanges: {
    displayName: "Acme Data Solutions",
  },
  executionMode: "draft_only",
};

const WRITE_DRAFT_AUTH: AuthorizationContext = {
  schemaVersion: 1,
  principal: { id: "user.operator", type: "user" },
  grantedPermissionClasses: ["write_draft"],
};

const READ_ONLY_AUTH: AuthorizationContext = {
  schemaVersion: 1,
  principal: { id: "user.viewer", type: "user" },
  grantedPermissionClasses: ["read_only"],
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

describe("Draft Tool Approval Attestation & Boundary Security", () => {
  it("protects against alternate workflow invocation without approval guard", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: createOperationalApprovalVerifier({
        getApproval: (id) => engine.getApproval(id),
      }),
    });

    // An alternative workflow that invokes the draft tool directly without an approval node
    const altWorkflow = defineWorkflow({
      schemaVersion: 1,
      id: "alt.direct_draft",
      version: "1.0.0",
      name: "Direct Draft Without Approval Guard",
      description: "Alternative workflow that attempts to bypass human approval",
      entryNodeId: "direct_draft_node",
      nodes: [
        {
          id: "direct_draft_node",
          kind: "tool",
          config: {
            toolRef: { id: draftTool.spec.id, version: draftTool.spec.version },
            inputStateKey: "input",
            resultStateKey: "output",
          },
        },
        {
          id: "final",
          kind: "final_output",
          config: {},
        },
      ],
      edges: [
        {
          sourceNodeId: "direct_draft_node",
          targetNodeId: "final",
        },
      ],
    });

    const app = createAAO({
      governance: fixtureGovernance,
      principalForRun: () => operator,
      tools: [draftTool],
      clock,
    });

    const prepared = app.prepareWorkflow(altWorkflow);

    // Caller attempts to forge approval binding in input
    const forgedInput: CreateChangeDraftToolInput = {
      requestId: VALID_OPERATIONAL_REQUEST.requestId,
      accountId: VALID_OPERATIONAL_REQUEST.accountContext.accountId,
      operation: "account.update_display_name",
      proposedChanges: {
        displayName: "Acme Data Solutions",
      },
      approvalBinding: {
        approvalId: "approval:forged",
        requestFingerprint: "forged",
      },
    };

    const runResult = await prepared.execute({
      runId: "run.alt.forged",
      initialState: {
        runId: "run.alt.forged",
        revision: 0,
        values: {
          input: forgedInput as never,
        },
      },
    });

    // Verification must fail closed: no drafts written
    expect(runResult.ok).toBe(false);
    if (!runResult.ok) {
      expect(runResult.failure.code).toBe("NODE_EXECUTION_FAILED");
      expect(runResult.failure.nodeId).toBe("direct_draft_node");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when draft tool is instantiated without an approval verifier", async () => {
    const repository = createInMemoryDraftRepository();
    const draftTool = createOperationalDraftTool({ repository });
    const tools = registryWithTool(draftTool);

    const input: CreateChangeDraftToolInput = {
      requestId: "req-001",
      accountId: "ACME-001",
      operation: "account.update_display_name",
      proposedChanges: { displayName: "Acme Data Solutions" },
      approvalBinding: {
        approvalId: "approval:any",
        requestFingerprint: "any",
      },
    };

    const result = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: "exec.no-verifier",
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input,
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("TOOL_EXECUTION_FAILED");
      expect(result.failure.handlerFailureCode).toBe("APPROVAL_VERIFICATION_FAILED");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when approval does not exist (APPROVAL_NOT_FOUND)", async () => {
    const repository = createInMemoryDraftRepository();
    const verifier = createOperationalApprovalVerifier({
      getApproval: () => undefined,
    });
    const draftTool = createOperationalDraftTool({ repository, approvalVerifier: verifier });
    const tools = registryWithTool(draftTool);

    const result = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: "exec.not-found",
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: {
            approvalId: "approval:non-existent",
            requestFingerprint: "a".repeat(64),
          },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.handlerFailureCode).toBe("APPROVAL_NOT_FOUND");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when approval remains pending (APPROVAL_STILL_PENDING)", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const fingerprint = fingerprintApprovalSubject("run.pending", "require_approval", 0, VALID_SUBJECT);
    const approvalId = approvalIdForFingerprint("run.pending", "require_approval", fingerprint);
    engine.requestApproval({
      approvalId,
      runId: "run.pending",
      nodeId: "require_approval",
      requestFingerprint: fingerprint,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });

    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) }),
    });
    const tools = registryWithTool(draftTool);

    const result = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: "exec.pending",
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.pending" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.handlerFailureCode).toBe("APPROVAL_STILL_PENDING");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when approval was rejected (APPROVAL_REJECTED)", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const fingerprint = fingerprintApprovalSubject("run.rejected", "require_approval", 0, VALID_SUBJECT);
    const approvalId = approvalIdForFingerprint("run.rejected", "require_approval", fingerprint);
    engine.requestApproval({
      approvalId,
      runId: "run.rejected",
      nodeId: "require_approval",
      requestFingerprint: fingerprint,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.reject(approvalId, manager);

    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) }),
    });
    const tools = registryWithTool(draftTool);

    const result = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: "exec.rejected",
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.rejected" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.handlerFailureCode).toBe("APPROVAL_REJECTED");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when approval belongs to another Run (INVALID_APPROVAL_CONTEXT)", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const fingerprint = fingerprintApprovalSubject("run.original", "require_approval", 0, VALID_SUBJECT);
    const approvalId = approvalIdForFingerprint("run.original", "require_approval", fingerprint);
    engine.requestApproval({
      approvalId,
      runId: "run.original",
      nodeId: "require_approval",
      requestFingerprint: fingerprint,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(approvalId, manager);

    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) }),
    });
    const tools = registryWithTool(draftTool);

    // Caller attempts to use run.original approval under run.different
    const result = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: "exec.run-mismatch",
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.different" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.handlerFailureCode).toBe("INVALID_APPROVAL_CONTEXT");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when approval belongs to another node (INVALID_APPROVAL_CONTEXT)", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const fingerprint = fingerprintApprovalSubject("run.node-mismatch", "other_approval_node", 0, VALID_SUBJECT);
    const approvalId = approvalIdForFingerprint("run.node-mismatch", "other_approval_node", fingerprint);
    engine.requestApproval({
      approvalId,
      runId: "run.node-mismatch",
      nodeId: "other_approval_node",
      requestFingerprint: fingerprint,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(approvalId, manager);

    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) }),
    });
    const tools = registryWithTool(draftTool);

    const result = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: "exec.node-mismatch",
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.node-mismatch" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.handlerFailureCode).toBe("INVALID_APPROVAL_CONTEXT");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when approval references a different account (APPROVAL_REQUEST_MISMATCH)", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const fingerprint = fingerprintApprovalSubject("run.acct-mismatch", "require_approval", 0, VALID_SUBJECT);
    const approvalId = approvalIdForFingerprint("run.acct-mismatch", "require_approval", fingerprint);
    engine.requestApproval({
      approvalId,
      runId: "run.acct-mismatch",
      nodeId: "require_approval",
      requestFingerprint: fingerprint,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(approvalId, manager);

    const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
    const runId = "run.acct-mismatch";
    const canonicalExecId = deriveToolExecutionId(runId, "create_draft");
    verifier.attestExecutionOrigin(runId, canonicalExecId);

    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: verifier,
    });
    const tools = registryWithTool(draftTool);

    // Caller attempts to draft for ACME-DIFFERENT using ACME-001 approval
    const result = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: canonicalExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: "ACME-DIFFERENT",
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.acct-mismatch" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.handlerFailureCode).toBe("APPROVAL_REQUEST_MISMATCH");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when approval references a different proposed display name (APPROVAL_REQUEST_MISMATCH)", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const fingerprint = fingerprintApprovalSubject("run.name-mismatch", "require_approval", 0, VALID_SUBJECT);
    const approvalId = approvalIdForFingerprint("run.name-mismatch", "require_approval", fingerprint);
    engine.requestApproval({
      approvalId,
      runId: "run.name-mismatch",
      nodeId: "require_approval",
      requestFingerprint: fingerprint,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(approvalId, manager);

    const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
    const runId = "run.name-mismatch";
    const canonicalExecId = deriveToolExecutionId(runId, "create_draft");
    verifier.attestExecutionOrigin(runId, canonicalExecId);

    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: verifier,
    });
    const tools = registryWithTool(draftTool);

    // Caller attempts to draft unapproved display name
    const result = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: canonicalExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: { displayName: "Unapproved Tampered Name" },
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.name-mismatch" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.handlerFailureCode).toBe("APPROVAL_REQUEST_MISMATCH");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  it("fails closed when approval was previously consumed by a different tool execution (APPROVAL_ALREADY_CONSUMED)", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const fingerprint = fingerprintApprovalSubject("run.consumed", "require_approval", 0, VALID_SUBJECT);
    const approvalId = approvalIdForFingerprint("run.consumed", "require_approval", fingerprint);
    engine.requestApproval({
      approvalId,
      runId: "run.consumed",
      nodeId: "require_approval",
      requestFingerprint: fingerprint,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(approvalId, manager);

    const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: verifier,
    });
    const tools = registryWithTool(draftTool);

    const canonicalExecId = deriveToolExecutionId("run.consumed", "create_draft");
    verifier.attestExecutionOrigin("run.consumed", canonicalExecId);

    // First execution succeeds
    const firstResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: canonicalExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.consumed" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(firstResult.ok).toBe(true);
    expect(repository.getAllDrafts().length).toBe(1);

    // Second execution with DIFFERENT execution ID attempts to consume the same approval
    const secondExecId = deriveToolExecutionId("run.consumed.second", "create_draft");
    verifier.attestExecutionOrigin("run.consumed.second", secondExecId);
    const secondResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: secondExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.consumed" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect(secondResult.failure.handlerFailureCode).toBe("INVALID_APPROVAL_CONTEXT");
    }
    // Draft repository count must remain exactly 1
    expect(repository.getAllDrafts().length).toBe(1);
  });

  it("handles identical replay under same execution identity idempotently", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const fingerprint = fingerprintApprovalSubject("run.replay", "require_approval", 0, VALID_SUBJECT);
    const approvalId = approvalIdForFingerprint("run.replay", "require_approval", fingerprint);
    engine.requestApproval({
      approvalId,
      runId: "run.replay",
      nodeId: "require_approval",
      requestFingerprint: fingerprint,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(approvalId, manager);

    const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: verifier,
    });
    const tools = registryWithTool(draftTool);

    const canonicalExecId = deriveToolExecutionId("run.replay", "create_draft");
    verifier.attestExecutionOrigin("run.replay", canonicalExecId);

    // Initial execution
    const firstResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: canonicalExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.replay" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(firstResult.ok).toBe(true);
    expect(repository.getAllDrafts().length).toBe(1);

    // Replay with exact same execution ID and payload
    const replayResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: canonicalExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.replay" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(replayResult.ok).toBe(true);
    expect(repository.getAllDrafts().length).toBe(1);
  });

  it("fails with IDEMPOTENCY_CONFLICT when replaying same execution ID with conflicting payload", async () => {
    const repository = createInMemoryDraftRepository();
    const clock = fixedClock();
    const govRegistry = createGovernanceRegistry(fixtureGovernance);
    const engine = createApprovalEngine({ governance: govRegistry, clock });

    const fingerprint = fingerprintApprovalSubject("run.conflict", "require_approval", 0, VALID_SUBJECT);
    const approvalId = approvalIdForFingerprint("run.conflict", "require_approval", fingerprint);
    engine.requestApproval({
      approvalId,
      runId: "run.conflict",
      nodeId: "require_approval",
      requestFingerprint: fingerprint,
      requestedBy: operator,
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
    });
    engine.approve(approvalId, manager);

    const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
    const draftTool = createOperationalDraftTool({
      repository,
      approvalVerifier: verifier,
    });
    const tools = registryWithTool(draftTool);

    const canonicalExecId = deriveToolExecutionId("run.conflict", "create_draft");
    verifier.attestExecutionOrigin("run.conflict", canonicalExecId);

    // First execution
    const firstResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: canonicalExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.conflict" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });
    expect(firstResult.ok).toBe(true);

    // Conflict: same executionId but different displayName
    const conflictResult = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: canonicalExecId,
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: { displayName: "Altered In Conflict" },
          approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.conflict" },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    expect(conflictResult.ok).toBe(false);
    if (!conflictResult.ok) {
      expect(conflictResult.failure.handlerFailureCode).toBe("IDEMPOTENCY_CONFLICT");
    }
    expect(repository.getAllDrafts().length).toBe(1);
  });

  it("enforces Tool Runtime authorization: actor without write_draft is denied before handler", async () => {
    const repository = createInMemoryDraftRepository();
    const draftTool = createOperationalDraftTool({ repository });
    const tools = registryWithTool(draftTool);

    const result = await executeTool({
      tools,
      request: {
        schemaVersion: 1,
        toolExecutionId: "exec.unauthorized",
        toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
        input: {
          requestId: VALID_SUBJECT.requestId,
          accountId: VALID_SUBJECT.accountId,
          operation: VALID_SUBJECT.operation,
          proposedChanges: VALID_SUBJECT.proposedChanges,
          approvalBinding: { approvalId: "approval:any", requestFingerprint: "any" },
        },
      },
      authorizationContext: READ_ONLY_AUTH, // viewer has read_only, not write_draft
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("TOOL_AUTHORIZATION_DENIED");
      expect(result.failure.authorizationReasonCode).toBe("PERMISSION_NOT_GRANTED");
    }
    expect(repository.getAllDrafts().length).toBe(0);
  });

  // --- Two-Run Cross-Run Approval Isolation Regression (Section 6) ---
  it("two-run attack: genuine Approval A cannot authorize draft execution in Run B, and Run A recovers", async () => {
    const clock = fixedClock();
    const nativeAdapter = nativeModelAdapter();
    const binding = fixtureBinding(nativeAdapter.manifest);
    const proof = createOperationalRequestProof({
      modelAdapters: [nativeAdapter],
      modelBindings: [binding],
      governance: fixtureGovernance,
      principalForRun: () => operator,
      clock,
    });

    // Step A: Run A reaches approval waitpoint and is approved by manager
    const initialA = await proof.execute({
      runId: "run.operation-A",
      request: VALID_OPERATIONAL_REQUEST,
    });
    expect(initialA.ok).toBe(true);
    expect(initialA.execution?.run.status).toBe("WAITING_FOR_APPROVAL");
    const waitA = initialA.execution?.wait;
    if (!waitA) throw new Error("Expected approval waitpoint for Run A");
    const approvalIdA = waitA.referenceId;
    const fingerprintA = waitA.requestFingerprint;
    proof.approvals.approve(approvalIdA, manager);
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);

    // Step B: Run B attempts to execute draft Tool using Run A's genuine approval
    const runBToolExecutionId = deriveToolExecutionId("run.operation-B", "create_draft");
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
            runId: "run.operation-A", // caller supplies Run A's runId
          },
        },
      },
      authorizationContext: WRITE_DRAFT_AUTH,
    });

    // Run B execution MUST BE DENIED
    expect(attackResult.ok).toBe(false);
    if (!attackResult.ok) {
      expect(attackResult.failure.handlerFailureCode).toBe("INVALID_APPROVAL_CONTEXT");
    }
    // Zero draft repository writes; no approval consumed
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);

    // Step C: Run A continues legitimately using original approval
    const resumedA = await proof.continue(initialA.execution!);
    expect(resumedA.ok).toBe(true);
    expect(resumedA.execution?.run.status).toBe("COMPLETED");

    // Exactly 1 draft created
    const drafts = proof.draftRepository.getAllDrafts();
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.draftId.startsWith("draft.")).toBe(true);
    expect(drafts[0]!.approvalId).toBe(approvalIdA);
    expect(drafts[0]!.externalExecution).toBe("not_executed");
  });

  // --- Direct executeTool Invocation Boundary (4 Cases, Section 7) ---
  describe("Direct executeTool Invocation Boundary (4 Cases)", () => {
    it("Case 1: Forged Approval ID fails closed", async () => {
      const repository = createInMemoryDraftRepository();
      const clock = fixedClock();
      const govRegistry = createGovernanceRegistry(fixtureGovernance);
      const engine = createApprovalEngine({ governance: govRegistry, clock });
      const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
      const draftTool = createOperationalDraftTool({ repository, approvalVerifier: verifier });
      const tools = registryWithTool(draftTool);

      const result = await executeTool({
        tools,
        request: {
          schemaVersion: 1,
          toolExecutionId: deriveToolExecutionId("run.case1", "create_draft"),
          toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
          input: {
            requestId: VALID_SUBJECT.requestId,
            accountId: VALID_SUBJECT.accountId,
            operation: VALID_SUBJECT.operation,
            proposedChanges: VALID_SUBJECT.proposedChanges,
            approvalBinding: {
              approvalId: "approval:forged",
              requestFingerprint: "0".repeat(64),
              runId: "run.case1",
            },
          },
        },
        authorizationContext: WRITE_DRAFT_AUTH,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.handlerFailureCode).toBe("APPROVAL_NOT_FOUND");
      }
      expect(repository.getAllDrafts().length).toBe(0);
    });

    it("Case 2: Genuine Approval ID with unrelated Tool execution ID fails closed", async () => {
      const repository = createInMemoryDraftRepository();
      const clock = fixedClock();
      const govRegistry = createGovernanceRegistry(fixtureGovernance);
      const engine = createApprovalEngine({ governance: govRegistry, clock });
      const fingerprint = fingerprintApprovalSubject("run.case2", "require_approval", 0, VALID_SUBJECT);
      const approvalId = approvalIdForFingerprint("run.case2", "require_approval", fingerprint);
      engine.requestApproval({
        approvalId,
        runId: "run.case2",
        nodeId: "require_approval",
        requestFingerprint: fingerprint,
        requestedBy: operator,
        requiredApproverRoleIds: ["operations.approver"],
        permissionClasses: ["write_draft"],
        allowSelfApproval: false,
      });
      engine.approve(approvalId, manager);

      const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
      const draftTool = createOperationalDraftTool({ repository, approvalVerifier: verifier });
      const tools = registryWithTool(draftTool);

      const result = await executeTool({
        tools,
        request: {
          schemaVersion: 1,
          toolExecutionId: "exec.unrelated.arbitrary-id",
          toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
          input: {
            requestId: VALID_SUBJECT.requestId,
            accountId: VALID_SUBJECT.accountId,
            operation: VALID_SUBJECT.operation,
            proposedChanges: VALID_SUBJECT.proposedChanges,
            approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.case2" },
          },
        },
        authorizationContext: WRITE_DRAFT_AUTH,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.handlerFailureCode).toBe("INVALID_APPROVAL_CONTEXT");
      }
      expect(repository.getAllDrafts().length).toBe(0);
    });

    it("Case 3: Genuine Approval ID with Run B derived execution ID fails closed", async () => {
      const repository = createInMemoryDraftRepository();
      const clock = fixedClock();
      const govRegistry = createGovernanceRegistry(fixtureGovernance);
      const engine = createApprovalEngine({ governance: govRegistry, clock });
      const fingerprint = fingerprintApprovalSubject("run.case3.A", "require_approval", 0, VALID_SUBJECT);
      const approvalId = approvalIdForFingerprint("run.case3.A", "require_approval", fingerprint);
      engine.requestApproval({
        approvalId,
        runId: "run.case3.A",
        nodeId: "require_approval",
        requestFingerprint: fingerprint,
        requestedBy: operator,
        requiredApproverRoleIds: ["operations.approver"],
        permissionClasses: ["write_draft"],
        allowSelfApproval: false,
      });
      engine.approve(approvalId, manager);

      const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
      const draftTool = createOperationalDraftTool({ repository, approvalVerifier: verifier });
      const tools = registryWithTool(draftTool);

      const runBExecId = deriveToolExecutionId("run.case3.B", "create_draft");

      const result = await executeTool({
        tools,
        request: {
          schemaVersion: 1,
          toolExecutionId: runBExecId,
          toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
          input: {
            requestId: VALID_SUBJECT.requestId,
            accountId: VALID_SUBJECT.accountId,
            operation: VALID_SUBJECT.operation,
            proposedChanges: VALID_SUBJECT.proposedChanges,
            approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.case3.A" },
          },
        },
        authorizationContext: WRITE_DRAFT_AUTH,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.handlerFailureCode).toBe("INVALID_APPROVAL_CONTEXT");
      }
      expect(repository.getAllDrafts().length).toBe(0);
    });

    it("Case 4: Genuine Approval ID with deliberately spoofed Run A execution ID from untrusted caller fails closed", async () => {
      const repository = createInMemoryDraftRepository();
      const clock = fixedClock();
      const govRegistry = createGovernanceRegistry(fixtureGovernance);
      const engine = createApprovalEngine({ governance: govRegistry, clock });
      const fingerprint = fingerprintApprovalSubject("run.case4.A", "require_approval", 0, VALID_SUBJECT);
      const approvalId = approvalIdForFingerprint("run.case4.A", "require_approval", fingerprint);
      engine.requestApproval({
        approvalId,
        runId: "run.case4.A",
        nodeId: "require_approval",
        requestFingerprint: fingerprint,
        requestedBy: operator,
        requiredApproverRoleIds: ["operations.approver"],
        permissionClasses: ["write_draft"],
        allowSelfApproval: false,
      });
      engine.approve(approvalId, manager);

      const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
      const draftTool = createOperationalDraftTool({ repository, approvalVerifier: verifier });
      const tools = registryWithTool(draftTool);

      const spoofedExecId = deriveToolExecutionId("run.case4.A", "create_draft");

      const result = await executeTool({
        tools,
        request: {
          schemaVersion: 1,
          toolExecutionId: spoofedExecId,
          toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
          input: {
            requestId: VALID_SUBJECT.requestId,
            accountId: VALID_SUBJECT.accountId,
            operation: VALID_SUBJECT.operation,
            proposedChanges: VALID_SUBJECT.proposedChanges,
            approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.case4.A" },
          },
        },
        authorizationContext: WRITE_DRAFT_AUTH,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.handlerFailureCode).toBe("UNTRUSTED_EXECUTION_ORIGIN");
      }
      expect(repository.getAllDrafts().length).toBe(0);
    });

    it("Case 5: Trusted host-controlled invocation succeeds when origin is attested", async () => {
      const repository = createInMemoryDraftRepository();
      const clock = fixedClock();
      const govRegistry = createGovernanceRegistry(fixtureGovernance);
      const engine = createApprovalEngine({ governance: govRegistry, clock });
      const fingerprint = fingerprintApprovalSubject("run.case5.A", "require_approval", 0, VALID_SUBJECT);
      const approvalId = approvalIdForFingerprint("run.case5.A", "require_approval", fingerprint);
      engine.requestApproval({
        approvalId,
        runId: "run.case5.A",
        nodeId: "require_approval",
        requestFingerprint: fingerprint,
        requestedBy: operator,
        requiredApproverRoleIds: ["operations.approver"],
        permissionClasses: ["write_draft"],
        allowSelfApproval: false,
      });
      engine.approve(approvalId, manager);

      const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
      const draftTool = createOperationalDraftTool({ repository, approvalVerifier: verifier });
      const tools = registryWithTool(draftTool);

      const canonicalExecId = deriveToolExecutionId("run.case5.A", "create_draft");
      verifier.attestExecutionOrigin("run.case5.A", canonicalExecId);

      const result = await executeTool({
        tools,
        request: {
          schemaVersion: 1,
          toolExecutionId: canonicalExecId,
          toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
          input: {
            requestId: VALID_SUBJECT.requestId,
            accountId: VALID_SUBJECT.accountId,
            operation: VALID_SUBJECT.operation,
            proposedChanges: VALID_SUBJECT.proposedChanges,
            approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.case5.A" },
          },
        },
        authorizationContext: WRITE_DRAFT_AUTH,
      });

      expect(result.ok).toBe(true);
      expect(repository.getAllDrafts().length).toBe(1);
    });
  });

  // --- Atomic Draft Commitment & Persistence Safety Regressions (Section 12) ---
  describe("Atomic Draft Commitment & Persistence Safety", () => {
    it("save throws before write: approval reservation is released and safely recoverable", async () => {
      const baseRepo = createInMemoryDraftRepository();
      let shouldThrow = true;
      const failingRepo = {
        ...baseRepo,
        async saveDraft(toolExecutionId: string, draft: OperationalChangeDraft) {
          if (shouldThrow) {
            throw new Error("Disk full: write aborted before persistence");
          }
          return baseRepo.saveDraft(toolExecutionId, draft);
        },
      };

      const clock = fixedClock();
      const govRegistry = createGovernanceRegistry(fixtureGovernance);
      const engine = createApprovalEngine({ governance: govRegistry, clock });
      const fingerprint = fingerprintApprovalSubject("run.recoverable", "require_approval", 0, VALID_SUBJECT);
      const approvalId = approvalIdForFingerprint("run.recoverable", "require_approval", fingerprint);
      engine.requestApproval({
        approvalId,
        runId: "run.recoverable",
        nodeId: "require_approval",
        requestFingerprint: fingerprint,
        requestedBy: operator,
        requiredApproverRoleIds: ["operations.approver"],
        permissionClasses: ["write_draft"],
        allowSelfApproval: false,
      });
      engine.approve(approvalId, manager);

      const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
      const draftTool = createOperationalDraftTool({ repository: failingRepo, approvalVerifier: verifier });
      const tools = registryWithTool(draftTool);
      const canonicalExecId = deriveToolExecutionId("run.recoverable", "create_draft");
      verifier.attestExecutionOrigin("run.recoverable", canonicalExecId);

      // Attempt 1: fails because save throws before write
      const failResult = await executeTool({
        tools,
        request: {
          schemaVersion: 1,
          toolExecutionId: canonicalExecId,
          toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
          input: {
            requestId: VALID_SUBJECT.requestId,
            accountId: VALID_SUBJECT.accountId,
            operation: VALID_SUBJECT.operation,
            proposedChanges: VALID_SUBJECT.proposedChanges,
            approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.recoverable" },
          },
        },
        authorizationContext: WRITE_DRAFT_AUTH,
      });

      expect(failResult.ok).toBe(false);
      if (!failResult.ok) {
        expect(failResult.failure.handlerFailureCode).toBe("DRAFT_PERSISTENCE_FAILED");
      }
      expect(baseRepo.getAllDrafts().length).toBe(0);
      expect(verifier.getConsumptionState?.(approvalId)).toBe("AVAILABLE");

      // Attempt 2: retry after transient disk issue resolved
      shouldThrow = false;
      const retryResult = await executeTool({
        tools,
        request: {
          schemaVersion: 1,
          toolExecutionId: canonicalExecId,
          toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
          input: {
            requestId: VALID_SUBJECT.requestId,
            accountId: VALID_SUBJECT.accountId,
            operation: VALID_SUBJECT.operation,
            proposedChanges: VALID_SUBJECT.proposedChanges,
            approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.recoverable" },
          },
        },
        authorizationContext: WRITE_DRAFT_AUTH,
      });

      expect(retryResult.ok).toBe(true);
      expect(baseRepo.getAllDrafts().length).toBe(1);
      expect(verifier.getConsumptionState?.(approvalId)).toBe("COMMITTED");
    });

    it("save writes then throws: reconciles existing matching draft and commits consumption", async () => {
      const baseRepo = createInMemoryDraftRepository();
      const failingRepo = {
        ...baseRepo,
        async saveDraft(toolExecutionId: string, draft: OperationalChangeDraft) {
          await baseRepo.saveDraft(toolExecutionId, draft);
          throw new Error("Network timeout acknowledging write after commit");
        },
      };

      const clock = fixedClock();
      const govRegistry = createGovernanceRegistry(fixtureGovernance);
      const engine = createApprovalEngine({ governance: govRegistry, clock });
      const fingerprint = fingerprintApprovalSubject("run.reconciled", "require_approval", 0, VALID_SUBJECT);
      const approvalId = approvalIdForFingerprint("run.reconciled", "require_approval", fingerprint);
      engine.requestApproval({
        approvalId,
        runId: "run.reconciled",
        nodeId: "require_approval",
        requestFingerprint: fingerprint,
        requestedBy: operator,
        requiredApproverRoleIds: ["operations.approver"],
        permissionClasses: ["write_draft"],
        allowSelfApproval: false,
      });
      engine.approve(approvalId, manager);

      const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
      const draftTool = createOperationalDraftTool({ repository: failingRepo, approvalVerifier: verifier });
      const tools = registryWithTool(draftTool);
      const canonicalExecId = deriveToolExecutionId("run.reconciled", "create_draft");
      verifier.attestExecutionOrigin("run.reconciled", canonicalExecId);

      const result = await executeTool({
        tools,
        request: {
          schemaVersion: 1,
          toolExecutionId: canonicalExecId,
          toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
          input: {
            requestId: VALID_SUBJECT.requestId,
            accountId: VALID_SUBJECT.accountId,
            operation: VALID_SUBJECT.operation,
            proposedChanges: VALID_SUBJECT.proposedChanges,
            approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.reconciled" },
          },
        },
        authorizationContext: WRITE_DRAFT_AUTH,
      });

      // Reconciliation should prove the commit succeeded
      expect(result.ok).toBe(true);
      expect(baseRepo.getAllDrafts().length).toBe(1);
      expect(verifier.getConsumptionState?.(approvalId)).toBe("COMMITTED");
    });

    it("concurrency: simultaneous attempts for the same approval yield at most one draft", async () => {
      const repository = createInMemoryDraftRepository();
      const clock = fixedClock();
      const govRegistry = createGovernanceRegistry(fixtureGovernance);
      const engine = createApprovalEngine({ governance: govRegistry, clock });

      const fingerprint = fingerprintApprovalSubject("run.concurrent", "require_approval", 0, VALID_SUBJECT);
      const approvalId = approvalIdForFingerprint("run.concurrent", "require_approval", fingerprint);
      engine.requestApproval({
        approvalId,
        runId: "run.concurrent",
        nodeId: "require_approval",
        requestFingerprint: fingerprint,
        requestedBy: operator,
        requiredApproverRoleIds: ["operations.approver"],
        permissionClasses: ["write_draft"],
        allowSelfApproval: false,
      });
      engine.approve(approvalId, manager);

      const verifier = createOperationalApprovalVerifier({ getApproval: (id) => engine.getApproval(id) });
      const draftTool = createOperationalDraftTool({ repository, approvalVerifier: verifier });
      const tools = registryWithTool(draftTool);

      const execId1 = deriveToolExecutionId("run.concurrent", "create_draft");
      verifier.attestExecutionOrigin("run.concurrent", execId1);

      const execId2 = deriveToolExecutionId("run.concurrent-2", "create_draft");
      verifier.attestExecutionOrigin("run.concurrent-2", execId2);

      const [result1, result2] = await Promise.all([
        executeTool({
          tools,
          request: {
            schemaVersion: 1,
            toolExecutionId: execId1,
            toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
            input: {
              requestId: VALID_SUBJECT.requestId,
              accountId: VALID_SUBJECT.accountId,
              operation: VALID_SUBJECT.operation,
              proposedChanges: VALID_SUBJECT.proposedChanges,
              approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.concurrent" },
            },
          },
          authorizationContext: WRITE_DRAFT_AUTH,
        }),
        executeTool({
          tools,
          request: {
            schemaVersion: 1,
            toolExecutionId: execId2,
            toolRef: { id: CREATE_CHANGE_DRAFT_TOOL_REF.id, version: CREATE_CHANGE_DRAFT_TOOL_REF.version },
            input: {
              requestId: VALID_SUBJECT.requestId,
              accountId: VALID_SUBJECT.accountId,
              operation: VALID_SUBJECT.operation,
              proposedChanges: VALID_SUBJECT.proposedChanges,
              approvalBinding: { approvalId, requestFingerprint: fingerprint, runId: "run.concurrent" },
            },
          },
          authorizationContext: WRITE_DRAFT_AUTH,
        }),
      ]);

      const successCount = (result1.ok ? 1 : 0) + (result2.ok ? 1 : 0);
      expect(successCount).toBe(1);
      expect(repository.getAllDrafts().length).toBe(1);
    });
  });
});
