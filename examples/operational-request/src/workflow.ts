import { defineWorkflow, type Workflow } from "@aao/framework";
import { EXECUTOR_VERSION, STATE_KEYS as K } from "./executors.js";
import { INTERPRET_POLICY_REF } from "./model-requests.js";
import { CREATE_CHANGE_DRAFT_TOOL_REF } from "./tool.js";

const exec = (id: string) => ({ executorRef: { id: `operational_request.${id}`, version: EXECUTOR_VERSION } });
const tool = (toolRef: { id: string; version: string }, inputStateKey: string, resultStateKey: string) => ({
  toolRef: { id: toolRef.id, version: toolRef.version },
  inputStateKey,
  resultStateKey,
});
const model = (modelPolicyRef: string, requestStateKey: string, resultStateKey: string) => ({
  modelPolicyRef,
  requestStateKey,
  resultStateKey,
});
const approval = (
  subjectStateKey: string,
  requiredApproverRoleIds: string[],
  permissionClasses: ("read_only" | "write_draft")[] = ["write_draft"]
) => ({
  subjectStateKey,
  permissionClasses,
  requiredApproverRoleIds,
  allowSelfApproval: false,
});

/** Node ids in exact execution order. Linear 9-node chain: no branching, loop, or autonomous agent. */
export const OPERATIONAL_REQUEST_NODE_ORDER = Object.freeze([
  "intake",
  "interpret",
  "validate_proposal",
  "build_approval_subject",
  "require_approval",
  "prepare_draft",
  "create_draft",
  "render_result",
  "final",
] as const);

export const APPROVER_ROLE_ID = "operations.approver";

const NODES = {
  intake: { kind: "deterministic", config: exec("intake") },
  interpret: { kind: "model", config: model(INTERPRET_POLICY_REF, K.interpretModelRequest, K.interpretResult) },
  validate_proposal: { kind: "deterministic", config: exec("validate_proposal") },
  build_approval_subject: { kind: "deterministic", config: exec("build_approval_subject") },
  require_approval: {
    kind: "approval",
    config: approval(K.approvalSubject, [APPROVER_ROLE_ID], ["write_draft"]),
  },
  prepare_draft: { kind: "deterministic", config: exec("prepare_draft") },
  create_draft: { kind: "tool", config: tool(CREATE_CHANGE_DRAFT_TOOL_REF, K.draftToolInput, K.draftToolResult) },
  render_result: { kind: "deterministic", config: exec("render_result") },
  final: { kind: "final_output", config: {} },
} as const;

/**
 * The Operational Request Workflow (`operational_request.proof@1.0.0`).
 * Connects intake, bounded model interpretation, strict proposal validation,
 * draft-only approval subject construction, human approval waitpoint,
 * authority revalidation, governed draft creation, and deterministic rendering.
 */
export const operationalRequestWorkflow: Workflow = defineWorkflow({
  schemaVersion: 1,
  id: "operational_request.proof",
  version: "1.0.0",
  name: "Operational request (governed action proposals, human approval, and safe draft execution)",
  description:
    "Receive an operational request, interpret intent with a bounded model call, validate proposal deterministically, require eligible human approval, and execute local draft creation through Tool Runtime.",
  entryNodeId: OPERATIONAL_REQUEST_NODE_ORDER[0],
  nodes: OPERATIONAL_REQUEST_NODE_ORDER.map((id) => ({ id, ...NODES[id], config: { ...NODES[id].config } })),
  edges: OPERATIONAL_REQUEST_NODE_ORDER.slice(1).map((target, index) => ({
    sourceNodeId: OPERATIONAL_REQUEST_NODE_ORDER[index]!,
    targetNodeId: target,
  })),
});
