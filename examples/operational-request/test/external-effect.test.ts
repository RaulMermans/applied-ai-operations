import { describe, expect, it } from "vitest";
import {
  defineTool,
  defineWorkflow,
  type PermissionClass,
  type ToolHandler,
  type Workflow,
} from "@aao/framework";
import {
  createFixtureProof,
  fixtureBinding,
  fixtureGovernance,
  manager,
  nativeModelAdapter,
  operator,
  VALID_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";
import { createOperationalRequestProof } from "../src/proof.js";

describe("Preserve Permission Model — No External Execution Gate", () => {
  function createProhibitedTool(permission: PermissionClass) {
    let handlerCalls = 0;
    const handler: ToolHandler = {
      async execute() {
        handlerCalls += 1;
        return { ok: true, output: { success: true } };
      },
    };

    const tool = defineTool({
      spec: {
        schemaVersion: 1,
        id: `prohibited.${permission}`,
        version: "1.0.0",
        name: `Prohibited ${permission} Tool`,
        description: "Must never execute in AAO V1",
        permissionClasses: [permission],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      handler,
      retrySafety: "unsafe",
    });

    return { tool, getHandlerCalls: () => handlerCalls };
  }

  it("fails preflight and refuses execution for external_side_effect tool with zero handler calls", async () => {
    const { tool: externalTool, getHandlerCalls } = createProhibitedTool("external_side_effect");

    const workflowWithExternalTool: Workflow = defineWorkflow({
      schemaVersion: 1,
      id: "operational_request.external_attempt",
      version: "1.0.0",
      name: "External Attempt",
      description: "Workflow attempting external side effect",
      entryNodeId: "create_draft",
      nodes: [
        {
          id: "create_draft",
          kind: "tool",
          config: {
            toolRef: { id: externalTool.spec.id, version: externalTool.spec.version },
            inputStateKey: "draftToolInput",
            resultStateKey: "draftToolResult",
          },
        },
      ],
      edges: [],
    });

    const model = nativeModelAdapter();
    const proof = createOperationalRequestProof({
      modelAdapters: [model],
      modelBindings: [fixtureBinding(model.manifest)],
      governance: fixtureGovernance,
      principalForRun: () => operator,
      tools: [externalTool],
    });

    // Workflow preparation refuses unsupported tool permission class
    expect(() => {
      proof.app.prepareWorkflow(workflowWithExternalTool);
    }).toThrow();

    expect(getHandlerCalls()).toBe(0);
  });

  it("fails preflight for destructive and sensitive_data tools with zero handler calls", async () => {
    for (const permission of ["destructive", "sensitive_data"] as PermissionClass[]) {
      const { tool: prohibitedTool, getHandlerCalls } = createProhibitedTool(permission);

      const workflow: Workflow = defineWorkflow({
        schemaVersion: 1,
        id: `operational_request.${permission}_attempt`,
        version: "1.0.0",
        name: `${permission} Attempt`,
        description: `Workflow attempting ${permission}`,
        entryNodeId: "create_draft",
        nodes: [
          {
            id: "create_draft",
            kind: "tool",
            config: {
              toolRef: { id: prohibitedTool.spec.id, version: prohibitedTool.spec.version },
              inputStateKey: "draftToolInput",
              resultStateKey: "draftToolResult",
            },
          },
        ],
        edges: [],
      });

      const model = nativeModelAdapter();
      const proof = createOperationalRequestProof({
        modelAdapters: [model],
        modelBindings: [fixtureBinding(model.manifest)],
        governance: fixtureGovernance,
        principalForRun: () => operator,
        tools: [prohibitedTool],
      });

      expect(() => {
        proof.app.prepareWorkflow(workflow);
      }).toThrow();

      expect(getHandlerCalls()).toBe(0);
    }
  });

  it("proves that human approval cannot override the tool permission support gate", async () => {
    // Invariant: An approval is authorization for a proposal; it never expands the Tool Runtime support gate.
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.support-gate.cannot-override",
      request: VALID_OPERATIONAL_REQUEST,
    });
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    const record = proof.approvals.approve(approvalId, manager);

    // Approval record exists
    expect(record.status).toBe("approved");

    // The executed tool in the governed workflow is strictly write_draft
    const resumed = await proof.continue(initial.execution!);
    expect(resumed.ok).toBe(true);

    const drafts = proof.draftRepository.getAllDrafts();
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.externalExecution).toBe("not_executed");
  });
});
