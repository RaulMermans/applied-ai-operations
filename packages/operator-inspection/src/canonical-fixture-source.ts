import type { ApprovalRecord, JsonObject, RunRecord, TraceEvent, Workflow } from "@aao/contracts";

const cap = (capability: string, support: "supported" | "unsupported") => ({ capability, support });
import {
  CANONICAL_CAPABILITY_PACKS,
  COMPANY_RESEARCH_PACK,
  DOCUMENT_INTELLIGENCE_PACK,
  OPERATIONAL_REQUEST_PACK,
  type ExactToolRef,
  type VerifiedModelAdapter,
  type VerifiedModelBinding,
} from "@aao/capability-packs";

export {
  CANONICAL_CAPABILITY_PACKS,
  COMPANY_RESEARCH_PACK,
  DOCUMENT_INTELLIGENCE_PACK,
  OPERATIONAL_REQUEST_PACK,
};
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import type { OperatorSourceProvenance } from "./contracts.js";
import type {
  KnownRunEvidence,
  RawEvaluationEvidence,
  TrustedProofRegistrationEvidence,
} from "./projections.js";
import {
  createEvidenceBackedInspectionSource,
  type OperatorInspectionSource,
} from "./service.js";

// --- 1. Canonical Company Manifests (Northstar Commerce & Arbor Consulting) ---

export const CANONICAL_NORTHSTAR_MANIFEST: Readonly<Record<string, unknown>> = Object.freeze({
  schemaVersion: 1,
  companyId: "northstar-commerce",
  displayName: "Northstar Commerce",
  enabledProofs: [
    "company_research",
    "document_intelligence",
    "operational_request",
  ],
  models: {
    bindingRefs: ["northstar.model.native"],
  },
  integrations: {
    publicWebProviderRef: "northstar.web-provider",
    documentSourceProviderRef: "northstar.doc-provider",
    draftRepositoryRef: "northstar.draft-repository",
  },
  governance: {
    actors: [
      { id: "user.northstar.analyst", type: "user" },
      { id: "user.northstar.requester", type: "user" },
      { id: "user.northstar.manager", type: "user" },
    ],
    roles: [
      {
        id: "research.analyst",
        version: "1.0.0",
        description: "Northstar Research Analyst",
        permissionClasses: ["read_only"],
      },
      {
        id: "operations.requester",
        version: "1.0.0",
        description: "Northstar Operations Requester",
        permissionClasses: ["read_only", "write_draft"],
      },
      {
        id: "operations.approver",
        version: "1.0.0",
        description: "Northstar Operations Approver",
        permissionClasses: ["read_only"],
      },
    ],
    bindings: [
      {
        id: "rb.northstar.analyst",
        actorId: "user.northstar.analyst",
        roleId: "research.analyst",
        status: "active",
      },
      {
        id: "rb.northstar.requester",
        actorId: "user.northstar.requester",
        roleId: "operations.requester",
        status: "active",
      },
      {
        id: "rb.northstar.manager",
        actorId: "user.northstar.manager",
        roleId: "operations.approver",
        status: "active",
      },
    ],
    policies: [],
  },
  reliability: {
    company_research: {
      search: { maxAttempts: 2, attemptTimeoutMs: 10000 },
    },
  },
});

export const CANONICAL_ARBOR_MANIFEST: Readonly<Record<string, unknown>> = Object.freeze({
  schemaVersion: 1,
  companyId: "arbor-consulting",
  displayName: "Arbor Consulting",
  enabledProofs: [
    "company_research",
    "document_intelligence",
    "operational_request",
  ],
  models: {
    bindingRefs: ["arbor.model.vercel"],
  },
  integrations: {
    publicWebProviderRef: "arbor.web-provider",
    documentSourceProviderRef: "arbor.doc-provider",
    draftRepositoryRef: "arbor.draft-repository",
  },
  governance: {
    actors: [
      { id: "user.arbor.researcher", type: "user" },
      { id: "user.arbor.requester", type: "user" },
      { id: "user.arbor.manager", type: "user" },
    ],
    roles: [
      {
        id: "consulting.researcher",
        version: "1.0.0",
        description: "Arbor Consulting Researcher",
        permissionClasses: ["read_only"],
      },
      {
        id: "client.operations",
        version: "1.0.0",
        description: "Arbor Client Operations",
        permissionClasses: ["read_only", "write_draft"],
      },
      {
        id: "operations.approver",
        version: "1.0.0",
        description: "Arbor Engagement Manager",
        permissionClasses: ["read_only"],
      },
    ],
    bindings: [
      {
        id: "rb.arbor.researcher",
        actorId: "user.arbor.researcher",
        roleId: "consulting.researcher",
        status: "active",
      },
      {
        id: "rb.arbor.requester",
        actorId: "user.arbor.requester",
        roleId: "client.operations",
        status: "active",
      },
      {
        id: "rb.arbor.manager",
        actorId: "user.arbor.manager",
        roleId: "operations.approver",
        status: "active",
      },
    ],
    policies: [],
  },
  reliability: {
    document_intelligence: {
      extract_document: { maxAttempts: 2, attemptTimeoutMs: 15000 },
    },
  },
});

// --- 2. Canonical Workflows ---

const CR_ORDER = [
  "intake",
  "plan",
  "validate_plan",
  "prepare_search",
  "search",
  "prepare_dedupe",
  "dedupe",
  "prepare_fetch",
  "fetch",
  "prepare_project",
  "project",
  "build_source_packet",
  "synthesize",
  "validate_grounding",
  "render",
  "final",
] as const;

const CR_NODES: Record<(typeof CR_ORDER)[number], { kind: Workflow["nodes"][number]["kind"]; config: JsonObject }> = {
  intake: { kind: "deterministic", config: { executorRef: { id: "company_research.intake", version: "1.0.0" } } },
  plan: { kind: "model", config: { modelPolicyRef: "company_research.planning", requestStateKey: "planModelRequest", resultStateKey: "planResult" } },
  validate_plan: { kind: "deterministic", config: { executorRef: { id: "company_research.validate_plan", version: "1.0.0" } } },
  prepare_search: { kind: "deterministic", config: { executorRef: { id: "company_research.prepare_search", version: "1.0.0" } } },
  search: { kind: "tool", config: { toolRef: { id: "public_web.search", version: "1.0.0" }, inputStateKey: "searchInput", resultStateKey: "searchResult" } },
  prepare_dedupe: { kind: "deterministic", config: { executorRef: { id: "company_research.prepare_dedupe", version: "1.0.0" } } },
  dedupe: { kind: "tool", config: { toolRef: { id: "records.dedupe", version: "1.0.0" }, inputStateKey: "dedupeInput", resultStateKey: "dedupeResult" } },
  prepare_fetch: { kind: "deterministic", config: { executorRef: { id: "company_research.prepare_fetch", version: "1.0.0" } } },
  fetch: { kind: "tool", config: { toolRef: { id: "public_web.fetch_pages", version: "1.0.0" }, inputStateKey: "fetchInput", resultStateKey: "fetchResult" } },
  prepare_project: { kind: "deterministic", config: { executorRef: { id: "company_research.prepare_project", version: "1.0.0" } } },
  project: { kind: "tool", config: { toolRef: { id: "records.project", version: "1.0.0" }, inputStateKey: "projectInput", resultStateKey: "projectResult" } },
  build_source_packet: { kind: "deterministic", config: { executorRef: { id: "company_research.build_source_packet", version: "1.0.0" } } },
  synthesize: { kind: "model", config: { modelPolicyRef: "company_research.synthesis", requestStateKey: "synthesisModelRequest", resultStateKey: "synthesisResult" } },
  validate_grounding: { kind: "deterministic", config: { executorRef: { id: "company_research.validate_grounding", version: "1.0.0" } } },
  render: { kind: "deterministic", config: { executorRef: { id: "company_research.render", version: "1.0.0" } } },
  final: { kind: "final_output", config: {} },
};

export const CANONICAL_COMPANY_RESEARCH_WORKFLOW: Workflow = Object.freeze({
  schemaVersion: 1,
  id: "company_research.proof",
  version: "1.0.0",
  name: "Company research (grounded public-web research)",
  description:
    "Plan bounded searches, collect public-web evidence through governed Tools, deduplicate and project it with Toolbox Tools, synthesize a structured draft, validate every citation deterministically, and render a report.",
  entryNodeId: CR_ORDER[0],
  nodes: CR_ORDER.map((id) => ({ id, kind: CR_NODES[id].kind, config: { ...CR_NODES[id].config } })),
  edges: CR_ORDER.slice(1).map((target, idx) => ({
    sourceNodeId: CR_ORDER[idx]!,
    targetNodeId: target,
  })),
});

const DI_ORDER = [
  "intake",
  "extract_document",
  "validate_document",
  "segment_document",
  "admit_evidence",
  "synthesize",
  "validate_grounding",
  "render",
  "final",
] as const;

const DI_NODES: Record<(typeof DI_ORDER)[number], { kind: Workflow["nodes"][number]["kind"]; config: JsonObject }> = {
  intake: { kind: "deterministic", config: { executorRef: { id: "document_intelligence.intake", version: "1.0.0" } } },
  extract_document: { kind: "tool", config: { toolRef: { id: "document.extract_text", version: "1.0.0" }, inputStateKey: "extractInput", resultStateKey: "extractResult" } },
  validate_document: { kind: "deterministic", config: { executorRef: { id: "document_intelligence.validate_document", version: "1.0.0" } } },
  segment_document: { kind: "deterministic", config: { executorRef: { id: "document_intelligence.segment_document", version: "1.0.0" } } },
  admit_evidence: { kind: "deterministic", config: { executorRef: { id: "document_intelligence.admit_evidence", version: "1.0.0" } } },
  synthesize: { kind: "model", config: { modelPolicyRef: "document_intelligence.synthesis", requestStateKey: "synthesisModelRequest", resultStateKey: "synthesisResult" } },
  validate_grounding: { kind: "deterministic", config: { executorRef: { id: "document_intelligence.validate_grounding", version: "1.0.0" } } },
  render: { kind: "deterministic", config: { executorRef: { id: "document_intelligence.render", version: "1.0.0" } } },
  final: { kind: "final_output", config: {} },
};

export const CANONICAL_DOCUMENT_INTELLIGENCE_WORKFLOW: Workflow = Object.freeze({
  schemaVersion: 1,
  id: "document_intelligence.proof",
  version: "1.0.0",
  name: "Document intelligence (evidence-anchored document extraction)",
  description:
    "Ingest bounded documents through governed Tools, segment into deterministic evidence spans, synthesize structured findings, validate every citation against exact document spans, and render an evidence-anchored result.",
  entryNodeId: DI_ORDER[0],
  nodes: DI_ORDER.map((id) => ({ id, kind: DI_NODES[id].kind, config: { ...DI_NODES[id].config } })),
  edges: DI_ORDER.slice(1).map((target, idx) => ({
    sourceNodeId: DI_ORDER[idx]!,
    targetNodeId: target,
  })),
});

const OR_ORDER = [
  "intake",
  "interpret",
  "validate_proposal",
  "build_approval_subject",
  "require_approval",
  "prepare_draft",
  "create_draft",
  "render_result",
  "final",
] as const;

const OR_NODES: Record<(typeof OR_ORDER)[number], { kind: Workflow["nodes"][number]["kind"]; config: JsonObject }> = {
  intake: { kind: "deterministic", config: { executorRef: { id: "operational_request.intake", version: "1.0.0" } } },
  interpret: { kind: "model", config: { modelPolicyRef: "operational_request.interpret", requestStateKey: "interpretModelRequest", resultStateKey: "interpretResult" } },
  validate_proposal: { kind: "deterministic", config: { executorRef: { id: "operational_request.validate_proposal", version: "1.0.0" } } },
  build_approval_subject: { kind: "deterministic", config: { executorRef: { id: "operational_request.build_approval_subject", version: "1.0.0" } } },
  require_approval: {
    kind: "approval",
    config: {
      subjectStateKey: "approvalSubject",
      permissionClasses: ["write_draft"],
      requiredApproverRoleIds: ["operations.approver"],
      allowSelfApproval: false,
    },
  },
  prepare_draft: { kind: "deterministic", config: { executorRef: { id: "operational_request.prepare_draft", version: "1.0.0" } } },
  create_draft: { kind: "tool", config: { toolRef: { id: "operations.create_change_draft", version: "1.0.0" }, inputStateKey: "draftToolInput", resultStateKey: "draftToolResult" } },
  render_result: { kind: "deterministic", config: { executorRef: { id: "operational_request.render_result", version: "1.0.0" } } },
  final: { kind: "final_output", config: {} },
};

export const CANONICAL_OPERATIONAL_REQUEST_WORKFLOW: Workflow = Object.freeze({
  schemaVersion: 1,
  id: "operational_request.proof",
  version: "1.0.0",
  name: "Operational request (governed action proposals, human approval, and safe draft execution)",
  description:
    "Receive an operational request, interpret intent with a bounded model call, validate proposal deterministically, require eligible human approval, and execute local draft creation through Tool Runtime.",
  entryNodeId: OR_ORDER[0],
  nodes: OR_ORDER.map((id) => ({ id, kind: OR_NODES[id].kind, config: { ...OR_NODES[id].config } })),
  edges: OR_ORDER.slice(1).map((target, idx) => ({
    sourceNodeId: OR_ORDER[idx]!,
    targetNodeId: target,
  })),
});

export const CANONICAL_WORKFLOWS: readonly Workflow[] = Object.freeze([
  CANONICAL_COMPANY_RESEARCH_WORKFLOW,
  CANONICAL_DOCUMENT_INTELLIGENCE_WORKFLOW,
  CANONICAL_OPERATIONAL_REQUEST_WORKFLOW,
]);

// --- 3. Verified Registration Evidence Snapshots ---

const NATIVE_ADAPTER_EVIDENCE: VerifiedModelAdapter = Object.freeze({
  id: "aao.native-model",
  version: "1.0.0",
  capabilities: [
    cap("model.text_generation", "supported"),
    cap("model.structured_output", "supported"),
    cap("model.usage", "supported"),
    cap("model.cancellation", "supported"),
    cap("model.tool_call_response", "unsupported"),
  ],
});

const VERCEL_ADAPTER_EVIDENCE: VerifiedModelAdapter = Object.freeze({
  id: "aao.vercel-ai-sdk",
  version: "1.0.0",
  capabilities: [
    cap("model.text_generation", "supported"),
    cap("model.structured_output", "supported"),
    cap("model.usage", "supported"),
    cap("model.cancellation", "supported"),
    cap("model.tool_call_response", "unsupported"),
  ],
});

const NORTHSTAR_BINDING_EVIDENCE: VerifiedModelBinding = Object.freeze({
  id: "northstar.model.native",
  capabilities: [
    "model.text_generation",
    "model.structured_output",
    "model.usage",
  ],
  adapterRef: { id: "aao.native-model", version: "1.0.0" },
});

const ARBOR_BINDING_EVIDENCE: VerifiedModelBinding = Object.freeze({
  id: "arbor.model.vercel",
  capabilities: [
    "model.text_generation",
    "model.structured_output",
    "model.usage",
  ],
  adapterRef: { id: "aao.vercel-ai-sdk", version: "1.0.0" },
});

const REGISTERED_EVAL_PROFILES = Object.freeze([
  "aao.company-research.evals@1.0.0",
  "aao.document-intelligence.evals@1.0.0",
  "aao.operational-request.evals@1.0.0",
]);

const CANONICAL_CR_TOOLS: readonly ExactToolRef[] = Object.freeze([
  Object.freeze({ id: "public_web.search", version: "1.0.0" }),
  Object.freeze({ id: "records.dedupe", version: "1.0.0" }),
  Object.freeze({ id: "public_web.fetch_pages", version: "1.0.0" }),
  Object.freeze({ id: "records.project", version: "1.0.0" }),
]);

const CANONICAL_CR_POLICIES: readonly string[] = Object.freeze([
  "company_research.planning",
  "company_research.synthesis",
]);

const CANONICAL_DI_TOOLS: readonly ExactToolRef[] = Object.freeze([
  Object.freeze({ id: "document.extract_text", version: "1.0.0" }),
]);

const CANONICAL_DI_POLICIES: readonly string[] = Object.freeze([
  "document_intelligence.synthesis",
]);

const CANONICAL_OR_TOOLS: readonly ExactToolRef[] = Object.freeze([
  Object.freeze({ id: "operations.create_change_draft", version: "1.0.0" }),
]);

const CANONICAL_OR_POLICIES: readonly string[] = Object.freeze([
  "operational_request.interpret",
]);

export interface RegistrationEvidenceOverrides {
  readonly company_research?: {
    readonly tools?: readonly ExactToolRef[];
    readonly modelPolicies?: readonly string[];
  };
  readonly document_intelligence?: {
    readonly tools?: readonly ExactToolRef[];
    readonly modelPolicies?: readonly string[];
  };
  readonly operational_request?: {
    readonly tools?: readonly ExactToolRef[];
    readonly modelPolicies?: readonly string[];
  };
}

export function createVerifiedRegistrationEvidenceForCompany(
  companyId: "northstar-commerce" | "arbor-consulting",
  overrides?: RegistrationEvidenceOverrides
): Readonly<Record<string, TrustedProofRegistrationEvidence>> {
  const bindings =
    companyId === "northstar-commerce"
      ? [NORTHSTAR_BINDING_EVIDENCE]
      : [ARBOR_BINDING_EVIDENCE];
  const adapters =
    companyId === "northstar-commerce"
      ? [NATIVE_ADAPTER_EVIDENCE]
      : [VERCEL_ADAPTER_EVIDENCE];

  return Object.freeze({
    company_research: {
      workflow: {
        id: CANONICAL_COMPANY_RESEARCH_WORKFLOW.id,
        version: CANONICAL_COMPANY_RESEARCH_WORKFLOW.version,
        planFingerprint: CANONICAL_COMPANY_RESEARCH_WORKFLOW.id ? COMPANY_RESEARCH_PACK.manifest.workflow.planFingerprint : "",
      },
      registeredTools: overrides?.company_research?.tools ?? CANONICAL_CR_TOOLS,
      registeredModelPolicies: overrides?.company_research?.modelPolicies ?? CANONICAL_CR_POLICIES,
      registeredModelBindings: bindings,
      registeredModelAdapters: adapters,
      registeredEvalProfiles: REGISTERED_EVAL_PROFILES,
    },
    document_intelligence: {
      workflow: {
        id: CANONICAL_DOCUMENT_INTELLIGENCE_WORKFLOW.id,
        version: CANONICAL_DOCUMENT_INTELLIGENCE_WORKFLOW.version,
        planFingerprint: DOCUMENT_INTELLIGENCE_PACK.manifest.workflow.planFingerprint,
      },
      registeredTools: overrides?.document_intelligence?.tools ?? CANONICAL_DI_TOOLS,
      registeredModelPolicies: overrides?.document_intelligence?.modelPolicies ?? CANONICAL_DI_POLICIES,
      registeredModelBindings: bindings,
      registeredModelAdapters: adapters,
      registeredEvalProfiles: REGISTERED_EVAL_PROFILES,
    },
    operational_request: {
      workflow: {
        id: CANONICAL_OPERATIONAL_REQUEST_WORKFLOW.id,
        version: CANONICAL_OPERATIONAL_REQUEST_WORKFLOW.version,
        planFingerprint: OPERATIONAL_REQUEST_PACK.manifest.workflow.planFingerprint,
      },
      registeredTools: overrides?.operational_request?.tools ?? CANONICAL_OR_TOOLS,
      registeredModelPolicies: overrides?.operational_request?.modelPolicies ?? CANONICAL_OR_POLICIES,
      registeredModelBindings: bindings,
      registeredModelAdapters: adapters,
      registeredEvalProfiles: REGISTERED_EVAL_PROFILES,
    },
  });
}

// --- 4. Deterministic Trace & Run Fixture Generation ---

function createDeterministicClock(startMs = Date.parse("2026-02-01T10:00:00.000Z")): { now(): string } {
  let current = startMs;
  return {
    now: () => {
      const iso = new Date(current).toISOString();
      current += 1000;
      return iso;
    },
  };
}

export async function buildCanonicalTraceFixtures(): Promise<{
  readonly tracesByRunId: Readonly<Record<string, readonly TraceEvent[]>>;
}> {
  const store = createInMemoryTraceStore();
  const recorder = createTraceRecorder({
    store,
    clock: createDeterministicClock(),
  });

  // 1. run.northstar.cr.001 (COMPLETED Company Research)
  const crRunId = "run.northstar.cr.001";
  const crWfId = "company_research.proof";
  await recorder.emit({
    type: "run.started",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: crRunId },
    payload: {
      entryNodeId: "intake",
      initialStateRevision: 0,
      nodeCount: 16,
      reliabilityPolicies: [],
    },
  });
  await recorder.emit({
    type: "node.started",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "plan",
    span: { kind: "node", nodeId: "plan", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      kind: "model",
      step: 1,
      attempt: 1,
      maxAttempts: 1,
      stateRevision: 1,
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "model.call.started",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "plan",
    span: { kind: "model", invocationId: "inv.ns.cr.plan", attempt: 1 },
    parentSpan: { kind: "node", nodeId: "plan", step: 1, attempt: 1 },
    key: { invocationId: "inv.ns.cr.plan", attempt: 1 },
    payload: {
      invocationId: "inv.ns.cr.plan",
      attempt: 1,
      modelPolicyRef: "company_research.planning",
      modelBindingId: "northstar.model.native",
      outputKind: "structured",
      requiredCapabilityIds: ["model.structured_output"],
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "model.call.completed",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "plan",
    span: { kind: "model", invocationId: "inv.ns.cr.plan", attempt: 1 },
    parentSpan: { kind: "node", nodeId: "plan", step: 1, attempt: 1 },
    key: { invocationId: "inv.ns.cr.plan", attempt: 1 },
    payload: {
      invocationId: "inv.ns.cr.plan",
      attempt: 1,
      modelBindingId: "northstar.model.native",
      outputKind: "structured",
      finishReason: "stop",
      usage: { inputTokens: 120, outputTokens: 64, totalTokens: 184 },
    },
  });
  await recorder.emit({
    type: "node.completed",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "plan",
    span: { kind: "node", nodeId: "plan", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      kind: "model",
      step: 1,
      attemptCount: 1,
      stateRevisionBefore: 1,
      stateRevisionAfter: 2,
      outcomeSource: "executor",
    },
  });
  await recorder.emit({
    type: "node.started",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "search",
    span: { kind: "node", nodeId: "search", step: 2, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 2, attempt: 1 },
    payload: {
      kind: "tool",
      step: 2,
      attempt: 1,
      maxAttempts: 2,
      stateRevision: 2,
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "tool.call.started",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "search",
    span: { kind: "tool", toolExecutionId: "tex.ns.cr.search", attempt: 1 },
    parentSpan: { kind: "node", nodeId: "search", step: 2, attempt: 1 },
    key: { toolExecutionId: "tex.ns.cr.search", attempt: 1 },
    payload: {
      toolRef: { id: "public_web.search", version: "1.0.0" },
      toolExecutionId: "tex.ns.cr.search",
      attempt: 1,
      permissionClasses: ["read_only"],
      access: {
        decision: "allow",
        principalId: "user.northstar.analyst",
        agentCeilingApplied: false,
      },
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "tool.call.completed",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "search",
    span: { kind: "tool", toolExecutionId: "tex.ns.cr.search", attempt: 1 },
    parentSpan: { kind: "node", nodeId: "search", step: 2, attempt: 1 },
    key: { toolExecutionId: "tex.ns.cr.search", attempt: 1 },
    payload: {
      toolRef: { id: "public_web.search", version: "1.0.0" },
      toolExecutionId: "tex.ns.cr.search",
      attempt: 1,
      permissionClasses: ["read_only"],
      result: "success",
    },
  });
  await recorder.emit({
    type: "node.completed",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "search",
    span: { kind: "node", nodeId: "search", step: 2, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 2, attempt: 1 },
    payload: {
      kind: "tool",
      step: 2,
      attemptCount: 1,
      stateRevisionBefore: 2,
      stateRevisionAfter: 3,
      outcomeSource: "executor",
    },
  });
  await recorder.emit({
    type: "run.completed",
    runId: crRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: crRunId },
    payload: {
      finalNodeId: "final",
      stateRevision: 16,
      steps: 16,
    },
  });

  // 2. run.arbor.di.001 (COMPLETED Document Intelligence)
  const diRunId = "run.arbor.di.001";
  const diWfId = "document_intelligence.proof";
  await recorder.emit({
    type: "run.started",
    runId: diRunId,
    workflowId: diWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: diRunId },
    payload: {
      entryNodeId: "intake",
      initialStateRevision: 0,
      nodeCount: 9,
      reliabilityPolicies: [],
    },
  });
  await recorder.emit({
    type: "node.started",
    runId: diRunId,
    workflowId: diWfId,
    workflowVersion: "1.0.0",
    nodeId: "extract_document",
    span: { kind: "node", nodeId: "extract_document", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      kind: "tool",
      step: 1,
      attempt: 1,
      maxAttempts: 2,
      stateRevision: 1,
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "tool.call.started",
    runId: diRunId,
    workflowId: diWfId,
    workflowVersion: "1.0.0",
    nodeId: "extract_document",
    span: { kind: "tool", toolExecutionId: "tex.arbor.di.extract", attempt: 1 },
    parentSpan: { kind: "node", nodeId: "extract_document", step: 1, attempt: 1 },
    key: { toolExecutionId: "tex.arbor.di.extract", attempt: 1 },
    payload: {
      toolRef: { id: "document.extract_text", version: "1.0.0" },
      toolExecutionId: "tex.arbor.di.extract",
      attempt: 1,
      permissionClasses: ["read_only"],
      access: {
        decision: "allow",
        principalId: "user.arbor.researcher",
        agentCeilingApplied: false,
      },
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "tool.call.completed",
    runId: diRunId,
    workflowId: diWfId,
    workflowVersion: "1.0.0",
    nodeId: "extract_document",
    span: { kind: "tool", toolExecutionId: "tex.arbor.di.extract", attempt: 1 },
    parentSpan: { kind: "node", nodeId: "extract_document", step: 1, attempt: 1 },
    key: { toolExecutionId: "tex.arbor.di.extract", attempt: 1 },
    payload: {
      toolRef: { id: "document.extract_text", version: "1.0.0" },
      toolExecutionId: "tex.arbor.di.extract",
      attempt: 1,
      permissionClasses: ["read_only"],
      result: "success",
    },
  });
  await recorder.emit({
    type: "node.completed",
    runId: diRunId,
    workflowId: diWfId,
    workflowVersion: "1.0.0",
    nodeId: "extract_document",
    span: { kind: "node", nodeId: "extract_document", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      kind: "tool",
      step: 1,
      attemptCount: 1,
      stateRevisionBefore: 1,
      stateRevisionAfter: 2,
      outcomeSource: "executor",
    },
  });
  await recorder.emit({
    type: "run.completed",
    runId: diRunId,
    workflowId: diWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: diRunId },
    payload: {
      finalNodeId: "final",
      stateRevision: 9,
      steps: 9,
    },
  });

  // 3. run.northstar.ops.001 (COMPLETED Operational Request after Approval)
  const opsRunId = "run.northstar.ops.001";
  const opsWfId = "operational_request.proof";
  await recorder.emit({
    type: "run.started",
    runId: opsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: opsRunId },
    payload: {
      entryNodeId: "intake",
      initialStateRevision: 0,
      nodeCount: 9,
      reliabilityPolicies: [],
    },
  });
  await recorder.emit({
    type: "node.started",
    runId: opsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "require_approval",
    span: { kind: "node", nodeId: "require_approval", step: 5, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 5, attempt: 1 },
    payload: {
      kind: "approval",
      step: 5,
      attempt: 1,
      maxAttempts: 1,
      stateRevision: 4,
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "approval.requested",
    runId: opsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "require_approval",
    span: { kind: "node", nodeId: "require_approval", step: 5, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { approvalId: "approval.northstar.ops.001" },
    payload: {
      approvalId: "approval.northstar.ops.001",
      step: 5,
      requestedBy: { id: "user.northstar.requester", type: "user" },
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
      requestFingerprint: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    },
  });
  await recorder.emit({
    type: "node.waiting",
    runId: opsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "require_approval",
    span: { kind: "node", nodeId: "require_approval", step: 5, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 5, wait: "approval" },
    payload: {
      kind: "approval",
      step: 5,
      waitKind: "approval",
      referenceId: "approval.northstar.ops.001",
    },
  });
  await recorder.emit({
    type: "approval.resolved",
    runId: opsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "require_approval",
    span: { kind: "node", nodeId: "require_approval", step: 5, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { approvalId: "approval.northstar.ops.001" },
    payload: {
      approvalId: "approval.northstar.ops.001",
      status: "approved",
      resolvedBy: { id: "user.northstar.manager", type: "user" },
      resolvedAt: "2026-02-01T10:00:30.000Z",
    },
  });
  await recorder.emit({
    type: "node.completed",
    runId: opsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "require_approval",
    span: { kind: "node", nodeId: "require_approval", step: 5, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 5, attempt: 1 },
    payload: {
      kind: "approval",
      step: 5,
      attemptCount: 1,
      stateRevisionBefore: 4,
      stateRevisionAfter: 5,
      outcomeSource: "approval_resolution",
    },
  });
  await recorder.emit({
    type: "run.completed",
    runId: opsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: opsRunId },
    payload: {
      finalNodeId: "final",
      stateRevision: 9,
      steps: 9,
    },
  });

  // 4. run.arbor.ops.002 (WAITING_FOR_APPROVAL Operational Request)
  const arbOpsRunId = "run.arbor.ops.002";
  await recorder.emit({
    type: "run.started",
    runId: arbOpsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: arbOpsRunId },
    payload: {
      entryNodeId: "intake",
      initialStateRevision: 0,
      nodeCount: 9,
      reliabilityPolicies: [],
    },
  });
  await recorder.emit({
    type: "node.started",
    runId: arbOpsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "require_approval",
    span: { kind: "node", nodeId: "require_approval", step: 5, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 5, attempt: 1 },
    payload: {
      kind: "approval",
      step: 5,
      attempt: 1,
      maxAttempts: 1,
      stateRevision: 4,
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "approval.requested",
    runId: arbOpsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "require_approval",
    span: { kind: "node", nodeId: "require_approval", step: 5, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { approvalId: "approval.arbor.ops.002" },
    payload: {
      approvalId: "approval.arbor.ops.002",
      step: 5,
      requestedBy: { id: "user.arbor.requester", type: "user" },
      requiredApproverRoleIds: ["operations.approver"],
      permissionClasses: ["write_draft"],
      allowSelfApproval: false,
      requestFingerprint: "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1",
    },
  });
  await recorder.emit({
    type: "node.waiting",
    runId: arbOpsRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "require_approval",
    span: { kind: "node", nodeId: "require_approval", step: 5, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 5, wait: "approval" },
    payload: {
      kind: "approval",
      step: 5,
      waitKind: "approval",
      referenceId: "approval.arbor.ops.002",
    },
  });

  // 5. run.northstar.cr.003 (FAILED Company Research)
  const failedRunId = "run.northstar.cr.003";
  await recorder.emit({
    type: "run.started",
    runId: failedRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: failedRunId },
    payload: {
      entryNodeId: "intake",
      initialStateRevision: 0,
      nodeCount: 16,
      reliabilityPolicies: [],
    },
  });
  await recorder.emit({
    type: "node.started",
    runId: failedRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "search",
    span: { kind: "node", nodeId: "search", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      kind: "tool",
      step: 1,
      attempt: 1,
      maxAttempts: 1,
      stateRevision: 1,
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "tool.call.started",
    runId: failedRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "search",
    span: { kind: "tool", toolExecutionId: "tex.ns.cr.fail", attempt: 1 },
    parentSpan: { kind: "node", nodeId: "search", step: 1, attempt: 1 },
    key: { toolExecutionId: "tex.ns.cr.fail", attempt: 1 },
    payload: {
      toolRef: { id: "public_web.search", version: "1.0.0" },
      toolExecutionId: "tex.ns.cr.fail",
      attempt: 1,
      permissionClasses: ["read_only"],
      access: {
        decision: "allow",
        principalId: "user.northstar.analyst",
        agentCeilingApplied: false,
      },
      recoveryReplay: false,
    },
  });
  await recorder.emit({
    type: "tool.call.failed",
    runId: failedRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "search",
    span: { kind: "tool", toolExecutionId: "tex.ns.cr.fail", attempt: 1 },
    parentSpan: { kind: "node", nodeId: "search", step: 1, attempt: 1 },
    key: { toolExecutionId: "tex.ns.cr.fail", attempt: 1 },
    payload: {
      toolRef: { id: "public_web.search", version: "1.0.0" },
      toolExecutionId: "tex.ns.cr.fail",
      attempt: 1,
      code: "TOOL_HANDLER_FAILED",
      retryable: false,
      category: "EXECUTION",
    },
  });
  await recorder.emit({
    type: "node.failed",
    runId: failedRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "search",
    span: { kind: "node", nodeId: "search", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      kind: "tool",
      step: 1,
      attemptCount: 1,
      code: "NODE_EXECUTION_FAILED",
      category: "EXECUTION",
      retryable: false,
    },
  });
  await recorder.emit({
    type: "run.failed",
    runId: failedRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: failedRunId },
    payload: {
      code: "NODE_EXECUTION_FAILED",
      category: "EXECUTION",
      nodeId: "search",
      stateRevision: 1,
      steps: 1,
    },
  });

  // 6. run.arbor.cr.incomplete (Partial trace without terminal event, and NO authoritative RunRecord -> UNKNOWN)
  const incompleteRunId = "run.arbor.cr.incomplete";
  await recorder.emit({
    type: "run.started",
    runId: incompleteRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: incompleteRunId },
    payload: {
      entryNodeId: "intake",
      initialStateRevision: 0,
      nodeCount: 16,
      reliabilityPolicies: [],
    },
  });
  await recorder.emit({
    type: "node.started",
    runId: incompleteRunId,
    workflowId: crWfId,
    workflowVersion: "1.0.0",
    nodeId: "intake",
    span: { kind: "node", nodeId: "intake", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      kind: "deterministic",
      step: 1,
      attempt: 1,
      maxAttempts: 1,
      stateRevision: 0,
      recoveryReplay: false,
    },
  });

  // 7. run.northstar.cr.retry (Multi-attempt Tool scenario)
  const retryRunId = "run.northstar.cr.retry";
  // Canonical Runtime retry shape (packages/runtime/src/reliability.ts): attempt 1 fails,
  // retry.scheduled on the attempt-1 span, attempt 2 opens its own span and completes.
  const at = (runId: string) => ({ runId, workflowId: crWfId, workflowVersion: "1.0.0" });
  const nodeSpan = (nodeId: string, step: number, attempt: number) => ({ kind: "node" as const, nodeId, step, attempt });
  const toolRefSearch = { id: "public_web.search", version: "1.0.0" };
  const toolAccess = { decision: "allow" as const, principalId: "user.northstar.analyst", agentCeilingApplied: false };
  await recorder.emit({ type: "run.started", ...at(retryRunId), span: { kind: "run" }, key: { run: retryRunId }, payload: { entryNodeId: "intake", initialStateRevision: 0, nodeCount: 16, reliabilityPolicies: [] } });
  for (const attempt of [1, 2]) {
    const tex = `tex.ns.cr.retry.${attempt}`;
    const toolSpan = { kind: "tool" as const, toolExecutionId: tex, attempt };
    await recorder.emit({ type: "node.started", ...at(retryRunId), nodeId: "search", span: nodeSpan("search", 1, attempt), parentSpan: { kind: "run" }, key: { step: 1, attempt }, payload: { kind: "tool", step: 1, attempt, maxAttempts: 2, stateRevision: 0, recoveryReplay: false } });
    await recorder.emit({ type: "tool.call.started", ...at(retryRunId), nodeId: "search", span: toolSpan, parentSpan: nodeSpan("search", 1, attempt), key: { toolExecutionId: tex, attempt }, payload: { toolRef: toolRefSearch, toolExecutionId: tex, attempt, permissionClasses: ["read_only"], access: toolAccess, recoveryReplay: false } });
    if (attempt === 1) {
      await recorder.emit({ type: "tool.call.failed", ...at(retryRunId), nodeId: "search", span: toolSpan, parentSpan: nodeSpan("search", 1, 1), key: { toolExecutionId: tex, attempt }, payload: { toolRef: toolRefSearch, toolExecutionId: tex, attempt, code: "PROVIDER_TIMEOUT", retryable: true, category: "EXECUTION" } });
      await recorder.emit({ type: "retry.scheduled", ...at(retryRunId), nodeId: "search", span: nodeSpan("search", 1, 1), key: { step: 1, attempt: 1 }, payload: { step: 1, failedAttempt: 1, nextAttempt: 2, maxAttempts: 2, category: "EXECUTION", causeCode: "PROVIDER_TIMEOUT", delayMs: 0 } });
    } else {
      await recorder.emit({ type: "tool.call.completed", ...at(retryRunId), nodeId: "search", span: toolSpan, parentSpan: nodeSpan("search", 1, 2), key: { toolExecutionId: tex, attempt }, payload: { toolRef: toolRefSearch, toolExecutionId: tex, attempt, permissionClasses: ["read_only"], result: "success" } });
    }
  }
  await recorder.emit({ type: "node.completed", ...at(retryRunId), nodeId: "search", span: nodeSpan("search", 1, 2), parentSpan: { kind: "run" }, key: { step: 1 }, payload: { kind: "tool", step: 1, attemptCount: 2, stateRevisionBefore: 0, stateRevisionAfter: 1, outcomeSource: "executor" } });
  await recorder.emit({ type: "run.completed", ...at(retryRunId), span: { kind: "run" }, key: { run: retryRunId }, payload: { finalNodeId: "final", stateRevision: 1, steps: 1 } });

  // 7b. run.northstar.cr.repeat: node 'plan' executes at step 1 and again at step 3
  // (a repeat, not a retry). The first model call reports usage; the second does not,
  // so run-level token accounting is PARTIAL.
  const repeatRunId = "run.northstar.cr.repeat";
  await recorder.emit({ type: "run.started", ...at(repeatRunId), span: { kind: "run" }, key: { run: repeatRunId }, payload: { entryNodeId: "plan", initialStateRevision: 0, nodeCount: 16, reliabilityPolicies: [] } });
  const repeatSteps: ReadonlyArray<{ nodeId: "plan" | "search"; step: number }> = [{ nodeId: "plan", step: 1 }, { nodeId: "search", step: 2 }, { nodeId: "plan", step: 3 }];
  for (const { nodeId, step } of repeatSteps) {
    const kind = nodeId === "plan" ? "model" : "tool";
    await recorder.emit({ type: "node.started", ...at(repeatRunId), nodeId, span: nodeSpan(nodeId, step, 1), parentSpan: { kind: "run" }, key: { step, attempt: 1 }, payload: { kind, step, attempt: 1, maxAttempts: 1, stateRevision: step - 1, recoveryReplay: false } });
    if (kind === "model") {
      const inv = `inv.ns.cr.repeat.${step}`;
      const modelSpan = { kind: "model" as const, invocationId: inv, attempt: 1 };
      await recorder.emit({ type: "model.call.started", ...at(repeatRunId), nodeId, span: modelSpan, parentSpan: nodeSpan(nodeId, step, 1), key: { invocationId: inv, attempt: 1 }, payload: { invocationId: inv, attempt: 1, modelPolicyRef: "company_research.planning", modelBindingId: "northstar.model.native", outputKind: "structured", requiredCapabilityIds: ["model.structured_output"], recoveryReplay: false } });
      await recorder.emit({ type: "model.call.completed", ...at(repeatRunId), nodeId, span: modelSpan, parentSpan: nodeSpan(nodeId, step, 1), key: { invocationId: inv, attempt: 1 }, payload: { invocationId: inv, attempt: 1, modelBindingId: "northstar.model.native", outputKind: "structured", finishReason: "stop", ...(step === 1 ? { usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 } } : {}) } });
    } else {
      const tex = "tex.ns.cr.repeat.search";
      const toolSpan = { kind: "tool" as const, toolExecutionId: tex, attempt: 1 };
      await recorder.emit({ type: "tool.call.started", ...at(repeatRunId), nodeId, span: toolSpan, parentSpan: nodeSpan(nodeId, step, 1), key: { toolExecutionId: tex, attempt: 1 }, payload: { toolRef: toolRefSearch, toolExecutionId: tex, attempt: 1, permissionClasses: ["read_only"], access: toolAccess, recoveryReplay: false } });
      await recorder.emit({ type: "tool.call.completed", ...at(repeatRunId), nodeId, span: toolSpan, parentSpan: nodeSpan(nodeId, step, 1), key: { toolExecutionId: tex, attempt: 1 }, payload: { toolRef: toolRefSearch, toolExecutionId: tex, attempt: 1, permissionClasses: ["read_only"], result: "success" } });
    }
    await recorder.emit({ type: "node.completed", ...at(repeatRunId), nodeId, span: nodeSpan(nodeId, step, 1), parentSpan: { kind: "run" }, key: { step }, payload: { kind, step, attemptCount: 1, stateRevisionBefore: step - 1, stateRevisionAfter: step, outcomeSource: "executor" } });
  }
  await recorder.emit({ type: "run.completed", ...at(repeatRunId), span: { kind: "run" }, key: { run: repeatRunId }, payload: { finalNodeId: "final", stateRevision: 3, steps: 3 } });

  // 8. run.northstar.ops.recovery (Recovery/Replay scenario)
  const recoveryRunId = "run.northstar.ops.recovery";
  await recorder.emit({
    type: "run.started",
    runId: recoveryRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: recoveryRunId },
    payload: { entryNodeId: "intake", initialStateRevision: 0, nodeCount: 9, reliabilityPolicies: [] },
  });
  await recorder.emit({
    type: "recovery.started",
    runId: recoveryRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { recovery: recoveryRunId },
    payload: {
      checkpointId: "chk.ns.ops.001",
      checkpointSequence: 0,
      runStatus: "RUNNING",
      stateRevision: 0,
      currentNodeId: "intake",
    },
  });
  await recorder.emit({
    type: "recovery.replayed",
    runId: recoveryRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "intake",
    span: { kind: "node", nodeId: "intake", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      operationId: "op.replayed.intake",
      step: 1,
      attempt: 1,
      recoveryReplayCount: 1,
    },
  });
  await recorder.emit({
    type: "node.started",
    runId: recoveryRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "intake",
    span: { kind: "node", nodeId: "intake", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      kind: "deterministic",
      step: 1,
      attempt: 1,
      maxAttempts: 1,
      stateRevision: 0,
      recoveryReplay: true,
    },
  });
  await recorder.emit({
    type: "node.completed",
    runId: recoveryRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    nodeId: "intake",
    span: { kind: "node", nodeId: "intake", step: 1, attempt: 1 },
    parentSpan: { kind: "run" },
    key: { step: 1, attempt: 1 },
    payload: {
      kind: "deterministic",
      step: 1,
      attemptCount: 1,
      stateRevisionBefore: 0,
      stateRevisionAfter: 1,
      outcomeSource: "recovered",
    },
  });
  await recorder.emit({
    type: "recovery.completed",
    runId: recoveryRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { recovery: recoveryRunId },
    payload: {
      fromCheckpointSequence: 0,
      toCheckpointSequence: 0,
    },
  });
  await recorder.emit({
    type: "run.completed",
    runId: recoveryRunId,
    workflowId: opsWfId,
    workflowVersion: "1.0.0",
    span: { kind: "run" },
    key: { run: recoveryRunId },
    payload: { finalNodeId: "final", stateRevision: 1, steps: 1 },
  });

  const tracesByRunId: Record<string, readonly TraceEvent[]> = {
    [crRunId]: await store.getRunTrace(crRunId),
    [diRunId]: await store.getRunTrace(diRunId),
    [opsRunId]: await store.getRunTrace(opsRunId),
    [arbOpsRunId]: await store.getRunTrace(arbOpsRunId),
    [failedRunId]: await store.getRunTrace(failedRunId),
    [incompleteRunId]: await store.getRunTrace(incompleteRunId),
    [retryRunId]: await store.getRunTrace(retryRunId),
    [repeatRunId]: await store.getRunTrace(repeatRunId),
    [recoveryRunId]: await store.getRunTrace(recoveryRunId),
  };

  return { tracesByRunId };
}

export const CANONICAL_APPROVAL_RECORDS: readonly ApprovalRecord[] = Object.freeze([
  {
    schemaVersion: 2,
    approvalId: "approval.northstar.ops.001",
    runId: "run.northstar.ops.001",
    nodeId: "require_approval",
    requestFingerprint: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    requestedBy: { id: "user.northstar.requester", type: "user" },
    requiredApproverRoleIds: ["operations.approver"],
    allowSelfApproval: false,
    status: "approved",
    requestedAt: "2026-02-01T10:00:15.000Z",
    resolvedAt: "2026-02-01T10:00:30.000Z",
    resolvedBy: { id: "user.northstar.manager", type: "user" },
    permissionClasses: ["write_draft"],
  },
  {
    schemaVersion: 2,
    approvalId: "approval.arbor.ops.002",
    runId: "run.arbor.ops.002",
    nodeId: "require_approval",
    requestFingerprint: "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1",
    requestedBy: { id: "user.arbor.requester", type: "user" },
    requiredApproverRoleIds: ["operations.approver"],
    allowSelfApproval: false,
    status: "pending",
    requestedAt: "2026-02-01T10:00:40.000Z",
    permissionClasses: ["write_draft"],
  },
]);

export const CANONICAL_EVALUATION_RESULTS: readonly RawEvaluationEvidence[] = Object.freeze([
  {
    evalProfileRef: "aao.company-research.evals@1.0.0",
    packIdentity: "aao.company-research@1.0.0",
    workflowId: "company_research.proof",
    companyId: "northstar-commerce",
    runId: "run.northstar.cr.001",
    datasetRef: "dataset.company-research.canonical@1.0.0",
    graderRefs: [
      "grader.trace.node-sequence@1.0.0",
      "grader.grounding.citation-integrity@1.0.0",
    ],
    executed: true,
    executedAt: "2026-02-01T10:05:00.000Z",
    totalCases: 5,
    passedCases: 5,
    failedCases: 0,
    allMatched: true,
    failureCodes: [],
    baselineComparisonStatus: "MATCHED",
  },
  {
    evalProfileRef: "aao.document-intelligence.evals@1.0.0",
    packIdentity: "aao.document-intelligence@1.0.0",
    workflowId: "document_intelligence.proof",
    companyId: "arbor-consulting",
    runId: "run.arbor.di.001",
    datasetRef: "dataset.document-intelligence.canonical@1.0.0",
    graderRefs: [
      "grader.trace.node-sequence@1.0.0",
      "grader.document.span-provenance@1.0.0",
    ],
    executed: true,
    executedAt: "2026-02-01T10:06:00.000Z",
    totalCases: 5,
    passedCases: 5,
    failedCases: 0,
    allMatched: true,
    failureCodes: [],
    baselineComparisonStatus: "MATCHED",
  },
  {
    evalProfileRef: "aao.operational-request.evals@1.0.0",
    packIdentity: "aao.operational-request@1.0.0",
    workflowId: "operational_request.proof",
    companyId: "northstar-commerce",
    runId: "run.northstar.ops.001",
    datasetRef: "dataset.operational-request.canonical@1.0.0",
    graderRefs: [
      "grader.approval.gate-enforced@1.0.0",
      "grader.operations.draft-only@1.0.0",
    ],
    executed: true,
    executedAt: "2026-02-01T10:07:00.000Z",
    totalCases: 5,
    passedCases: 5,
    failedCases: 0,
    allMatched: true,
    failureCodes: [],
    baselineComparisonStatus: "MATCHED",
  },
  {
    evalProfileRef: "aao.arbor-portability.evals@1.0.0",
    packIdentity: "aao.operational-request@1.0.0",
    workflowId: "operational_request.proof",
    companyId: "arbor-consulting",
    datasetRef: "dataset.arbor.operational-request@1.0.0",
    graderRefs: ["grader.approval.gate-enforced@1.0.0"],
    executed: false,
    failureCodes: [],
  },
]);

export const CANONICAL_RUN_RECORDS: Readonly<Record<string, RunRecord>> = Object.freeze({
  "run.northstar.cr.001": {
    schemaVersion: 1,
    runId: "run.northstar.cr.001",
    workflowId: "company_research.proof",
    workflowVersion: "1.0.0",
    status: "COMPLETED",
    createdAt: "2026-02-01T10:00:00.000Z",
    updatedAt: "2026-02-01T10:00:09.000Z",
  },
  "run.arbor.di.001": {
    schemaVersion: 1,
    runId: "run.arbor.di.001",
    workflowId: "document_intelligence.proof",
    workflowVersion: "1.0.0",
    status: "COMPLETED",
    createdAt: "2026-02-01T10:00:10.000Z",
    updatedAt: "2026-02-01T10:00:15.000Z",
  },
  "run.northstar.ops.001": {
    schemaVersion: 1,
    runId: "run.northstar.ops.001",
    workflowId: "operational_request.proof",
    workflowVersion: "1.0.0",
    status: "COMPLETED",
    createdAt: "2026-02-01T10:00:16.000Z",
    updatedAt: "2026-02-01T10:00:32.000Z",
  },
  "run.arbor.ops.002": {
    schemaVersion: 1,
    runId: "run.arbor.ops.002",
    workflowId: "operational_request.proof",
    workflowVersion: "1.0.0",
    status: "WAITING_FOR_APPROVAL",
    createdAt: "2026-02-01T10:00:35.000Z",
    updatedAt: "2026-02-01T10:00:41.000Z",
    currentNodeId: "require_approval",
  },
  "run.northstar.cr.003": {
    schemaVersion: 1,
    runId: "run.northstar.cr.003",
    workflowId: "company_research.proof",
    workflowVersion: "1.0.0",
    status: "FAILED",
    createdAt: "2026-02-01T10:00:45.000Z",
    updatedAt: "2026-02-01T10:00:50.000Z",
    currentNodeId: "search",
  },
  "run.northstar.cr.retry": {
    schemaVersion: 1,
    runId: "run.northstar.cr.retry",
    workflowId: "company_research.proof",
    workflowVersion: "1.0.0",
    status: "COMPLETED",
    createdAt: "2026-02-01T10:01:00.000Z",
    updatedAt: "2026-02-01T10:01:10.000Z",
    currentNodeId: "search",
  },
  "run.northstar.cr.repeat": {
    schemaVersion: 1,
    runId: "run.northstar.cr.repeat",
    workflowId: "company_research.proof",
    workflowVersion: "1.0.0",
    status: "COMPLETED",
    createdAt: "2026-02-01T10:01:11.000Z",
    updatedAt: "2026-02-01T10:01:14.000Z",
    currentNodeId: "plan",
  },
  "run.northstar.ops.recovery": {
    schemaVersion: 1,
    runId: "run.northstar.ops.recovery",
    workflowId: "operational_request.proof",
    workflowVersion: "1.0.0",
    status: "COMPLETED",
    createdAt: "2026-02-01T10:01:15.000Z",
    updatedAt: "2026-02-01T10:01:25.000Z",
    currentNodeId: "intake",
  },
});

export const CANONICAL_DEMO_PROVENANCE: OperatorSourceProvenance = Object.freeze({
  mode: "demo",
  label: "DEMO DATA — NOT LIVE OPERATIONS",
  description: "Canonical AAO demonstration fixtures",
});

export interface CanonicalDemoInspectionSourceOptions {
  /**
   * Optional authoritative or test registration evidence.
   * When omitted (default), companies have no proof registration snapshot,
   * so compatibility truthfully reports NOT_VERIFIED.
   */
  readonly registrationEvidenceByCompany?: Readonly<
    Record<string, Readonly<Record<string, TrustedProofRegistrationEvidence | undefined>>>
  >;
  readonly provenance?: OperatorSourceProvenance;
  readonly includeExtendedRuns?: boolean;
}

export async function createCanonicalDemoInspectionSource(
  options: CanonicalDemoInspectionSourceOptions = {}
): Promise<OperatorInspectionSource> {
  const { tracesByRunId } = await buildCanonicalTraceFixtures();

  const allPackRefs = CANONICAL_CAPABILITY_PACKS.map((p) => ({
    id: p.ref.id,
    version: p.ref.version,
  }));

  const knownRuns: KnownRunEvidence[] = [
    {
      runId: "run.northstar.cr.001",
      companyId: "northstar-commerce",
      packIdentity: "aao.company-research@1.0.0",
      authoritativeRun: CANONICAL_RUN_RECORDS["run.northstar.cr.001"],
      traceEvents: tracesByRunId["run.northstar.cr.001"],
      workflow: CANONICAL_COMPANY_RESEARCH_WORKFLOW,
    },
    {
      runId: "run.arbor.di.001",
      companyId: "arbor-consulting",
      packIdentity: "aao.document-intelligence@1.0.0",
      authoritativeRun: CANONICAL_RUN_RECORDS["run.arbor.di.001"],
      traceEvents: tracesByRunId["run.arbor.di.001"],
      workflow: CANONICAL_DOCUMENT_INTELLIGENCE_WORKFLOW,
    },
    {
      runId: "run.northstar.ops.001",
      companyId: "northstar-commerce",
      packIdentity: "aao.operational-request@1.0.0",
      authoritativeRun: CANONICAL_RUN_RECORDS["run.northstar.ops.001"],
      traceEvents: tracesByRunId["run.northstar.ops.001"],
      workflow: CANONICAL_OPERATIONAL_REQUEST_WORKFLOW,
    },
    {
      runId: "run.arbor.ops.002",
      companyId: "arbor-consulting",
      packIdentity: "aao.operational-request@1.0.0",
      authoritativeRun: CANONICAL_RUN_RECORDS["run.arbor.ops.002"],
      traceEvents: tracesByRunId["run.arbor.ops.002"],
      workflow: CANONICAL_OPERATIONAL_REQUEST_WORKFLOW,
    },
    {
      runId: "run.northstar.cr.003",
      companyId: "northstar-commerce",
      packIdentity: "aao.company-research@1.0.0",
      authoritativeRun: CANONICAL_RUN_RECORDS["run.northstar.cr.003"],
      traceEvents: tracesByRunId["run.northstar.cr.003"],
      workflow: CANONICAL_COMPANY_RESEARCH_WORKFLOW,
    },
    {
      // Partial trace without terminal event and NO authoritativeRun -> must display UNKNOWN
      runId: "run.arbor.cr.incomplete",
      companyId: "arbor-consulting",
      packIdentity: "aao.company-research@1.0.0",
      authoritativeRun: undefined,
      traceEvents: tracesByRunId["run.arbor.cr.incomplete"],
      workflow: CANONICAL_COMPANY_RESEARCH_WORKFLOW,
    },
    ...(options.includeExtendedRuns
      ? [
          {
            runId: "run.northstar.cr.retry",
            companyId: "northstar-commerce",
            packIdentity: "aao.company-research@1.0.0",
            authoritativeRun: CANONICAL_RUN_RECORDS["run.northstar.cr.retry"],
            traceEvents: tracesByRunId["run.northstar.cr.retry"],
            workflow: CANONICAL_COMPANY_RESEARCH_WORKFLOW,
          },
          {
            runId: "run.northstar.cr.repeat",
            companyId: "northstar-commerce",
            packIdentity: "aao.company-research@1.0.0",
            authoritativeRun: CANONICAL_RUN_RECORDS["run.northstar.cr.repeat"],
            traceEvents: tracesByRunId["run.northstar.cr.repeat"],
            workflow: CANONICAL_COMPANY_RESEARCH_WORKFLOW,
          },
          {
            runId: "run.northstar.ops.recovery",
            companyId: "northstar-commerce",
            packIdentity: "aao.operational-request@1.0.0",
            authoritativeRun: CANONICAL_RUN_RECORDS["run.northstar.ops.recovery"],
            traceEvents: tracesByRunId["run.northstar.ops.recovery"],
            workflow: CANONICAL_OPERATIONAL_REQUEST_WORKFLOW,
          },
        ]
      : []),
  ];

  return createEvidenceBackedInspectionSource({
    provenance: options.provenance ?? CANONICAL_DEMO_PROVENANCE,
    companies: [
      {
        manifest: CANONICAL_NORTHSTAR_MANIFEST,
        selectedPackRefs: allPackRefs,
        registrationEvidenceByPack:
          options.registrationEvidenceByCompany?.["northstar-commerce"],
      },
      {
        manifest: CANONICAL_ARBOR_MANIFEST,
        selectedPackRefs: allPackRefs,
        registrationEvidenceByPack:
          options.registrationEvidenceByCompany?.["arbor-consulting"],
      },
    ],
    capabilityPacks: CANONICAL_CAPABILITY_PACKS,
    workflows: CANONICAL_WORKFLOWS,
    knownRuns,
    approvalRecords: CANONICAL_APPROVAL_RECORDS,
    evaluationResults: CANONICAL_EVALUATION_RESULTS,
  });
}
