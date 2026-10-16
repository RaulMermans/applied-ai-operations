import { defineWorkflow, type Workflow } from "@aao/framework";
import { DOCUMENT_EXTRACT_TEXT_TOOL_REF } from "@aao/integration-documents";
import { EXECUTOR_VERSION, STATE_KEYS as K } from "./executors.js";
import { SYNTHESIS_POLICY_REF } from "./model-requests.js";

const exec = (id: string) => ({ executorRef: { id: `document_intelligence.${id}`, version: EXECUTOR_VERSION } });
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

/** Node ids in exact execution order. Linear 9-node chain: no branching, loop, or autonomous agent. */
export const DOCUMENT_INTELLIGENCE_NODE_ORDER = Object.freeze([
  "intake",
  "extract_document",
  "validate_document",
  "segment_document",
  "admit_evidence",
  "synthesize",
  "validate_grounding",
  "render",
  "final",
] as const);

const NODES = {
  intake: { kind: "deterministic", config: exec("intake") },
  extract_document: { kind: "tool", config: tool(DOCUMENT_EXTRACT_TEXT_TOOL_REF, K.extractInput, K.extractResult) },
  validate_document: { kind: "deterministic", config: exec("validate_document") },
  segment_document: { kind: "deterministic", config: exec("segment_document") },
  admit_evidence: { kind: "deterministic", config: exec("admit_evidence") },
  synthesize: { kind: "model", config: model(SYNTHESIS_POLICY_REF, K.synthesisModelRequest, K.synthesisResult) },
  validate_grounding: { kind: "deterministic", config: exec("validate_grounding") },
  render: { kind: "deterministic", config: exec("render") },
  final: { kind: "final_output", config: {} },
} as const;

/**
 * The Document Intelligence Workflow (`document_intelligence.proof@1.0.0`).
 * Connects intake, governed document text extraction, page validation, deterministic span segmentation,
 * bounded context admission, structured model synthesis, exact citation validation, and deterministic rendering.
 */
export const documentIntelligenceWorkflow: Workflow = defineWorkflow({
  schemaVersion: 1,
  id: "document_intelligence.proof",
  version: "1.0.0",
  name: "Document intelligence (evidence-anchored document extraction)",
  description: "Ingest bounded documents through governed Tools, segment into deterministic evidence spans, synthesize structured findings, validate every citation against exact document spans, and render an evidence-anchored result.",
  entryNodeId: DOCUMENT_INTELLIGENCE_NODE_ORDER[0],
  nodes: DOCUMENT_INTELLIGENCE_NODE_ORDER.map((id) => ({ id, ...NODES[id], config: { ...NODES[id].config } })),
  edges: DOCUMENT_INTELLIGENCE_NODE_ORDER.slice(1).map((target, index) => ({
    sourceNodeId: DOCUMENT_INTELLIGENCE_NODE_ORDER[index]!,
    targetNodeId: target,
  })),
});
