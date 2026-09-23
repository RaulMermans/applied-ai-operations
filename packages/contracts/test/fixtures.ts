// Representative fixtures used across tests. Kept small and deliberately not
// an enormous fake-company dataset — enough to exercise real shapes without
// vendor-specific SDK types anywhere in this file.
import type { AgentSpec } from "../src/agent.js";
import type { ApprovalRecord } from "../src/approval.js";
import type { CapabilityPackRef } from "../src/capability-pack.js";
import type { CapabilitySpec } from "../src/capability.js";
import type { CompanyConfig } from "../src/deployment.js";
import type { RunRecord } from "../src/run.js";
import type { ToolSpec } from "../src/tool.js";
import type { Workflow } from "../src/workflow.js";

/** intake -> deterministic node -> final output */
export const minimalWorkflowFixture: Workflow = {
  schemaVersion: 1,
  id: "intake.minimal-example",
  version: "1.0.0",
  name: "Minimal intake example",
  description: "The smallest workflow shape: intake, a deterministic node, and a final output.",
  entryNodeId: "intake",
  nodes: [
    { id: "intake", kind: "deterministic", name: "Intake", config: { operation: "normalize" } },
    { id: "final", kind: "final_output", name: "Final output", config: {} },
  ],
  edges: [{ sourceNodeId: "intake", targetNodeId: "final" }],
};

/** A governed operational workflow definition referencing a tool and a capability, without executing them. */
export const governedOperationalWorkflowFixture: Workflow = {
  schemaVersion: 1,
  id: "sales.lead-qualification",
  version: "1.0.0",
  name: "Lead qualification",
  description: "Classifies an inbound lead, proposes a CRM update, and requires approval before it is applied.",
  entryNodeId: "classify",
  nodes: [
    { id: "classify", kind: "model", name: "Classify lead", config: {} },
    {
      id: "propose-update",
      kind: "tool",
      name: "Propose CRM update",
      config: { toolRef: "crm.accounts.update", capabilityRef: "crm.accounts.search" },
    },
    { id: "require-approval", kind: "approval", name: "Require approval", config: { permissionClasses: ["external_side_effect"] } },
    { id: "final", kind: "final_output", name: "Final output", config: {} },
  ],
  edges: [
    { sourceNodeId: "classify", targetNodeId: "propose-update" },
    { sourceNodeId: "propose-update", targetNodeId: "require-approval" },
    { sourceNodeId: "require-approval", targetNodeId: "final" },
  ],
  requiredCapabilities: ["crm.accounts.search", "crm.accounts.update"],
};

export const toolSpecFixture: ToolSpec = {
  schemaVersion: 1,
  id: "crm.accounts.update",
  version: "1.0.0",
  name: "Update CRM account",
  description: "Applies an approved field change to a CRM account.",
  inputSchema: { type: "object", properties: { accountId: { type: "string" }, fields: { type: "object" } } },
  outputSchema: { type: "object", properties: { accountId: { type: "string" }, updated: { type: "boolean" } } },
  permissionClasses: ["external_side_effect"],
  capabilityRef: "crm.accounts.update",
};

export const capabilitySpecFixture: CapabilitySpec = {
  schemaVersion: 1,
  id: "crm.accounts.search",
  version: "1.0.0",
  name: "Search CRM accounts",
  description: "Provider-neutral account search across whatever CRM is bound for this company.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  outputSchema: { type: "array", items: { type: "object" } },
  permissionClasses: ["read_only"],
};

export const approvalRecordFixture: ApprovalRecord = {
  schemaVersion: 1,
  approvalId: "approval-0001",
  runId: "run-0001",
  nodeId: "require-approval",
  status: "pending",
  requestedAt: "2026-09-23T12:00:00Z",
  permissionClasses: ["external_side_effect"],
};

export const agentSpecFixture: AgentSpec = {
  schemaVersion: 1,
  id: "sales.lead-qualifier-agent",
  version: "1.0.0",
  name: "Lead qualifier",
  description: "Bounded reasoning component that classifies inbound leads.",
  modelPolicyRef: "default.reasoning-model",
  skillRefs: ["sales.qualify-lead"],
  toolRefs: ["crm.accounts.update"],
  permissionClasses: ["read_only"],
};

export const runRecordFixture: RunRecord = {
  schemaVersion: 1,
  runId: "run-0001",
  workflowId: "sales.lead-qualification",
  workflowVersion: "1.0.0",
  status: "WAITING_FOR_APPROVAL",
  createdAt: "2026-09-23T12:00:00Z",
  updatedAt: "2026-09-23T12:05:00Z",
  currentNodeId: "require-approval",
};

export const capabilityPackRefFixture: CapabilityPackRef = {
  capabilityPackId: "sales-operations-pack",
  version: "1.0.0",
};

/** A company configuration showing provider-neutral references only. */
export const companyConfigFixture: CompanyConfig = {
  schemaVersion: 1,
  companyId: "acme-corp",
  displayName: "Acme Corp",
  workflowRefs: ["sales.lead-qualification"],
  policyRefs: ["default.approval-policy"],
  capabilityPackRefs: [capabilityPackRefFixture],
  capabilityBindingRefs: ["acme-corp.crm-binding"],
  fieldMappingRefs: ["acme-corp.account-field-mapping"],
};
