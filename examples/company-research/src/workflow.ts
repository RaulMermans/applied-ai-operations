import { defineWorkflow, type Workflow } from "@aao/framework";
import { PUBLIC_WEB_FETCH_TOOL_REF, PUBLIC_WEB_SEARCH_TOOL_REF } from "@aao/integration-public-web";
import { EXECUTOR_VERSION, STATE_KEYS as K } from "./executors.js";
import { PLANNING_POLICY_REF, SYNTHESIS_POLICY_REF } from "./model-requests.js";

const exec = (id: string) => ({ executorRef: { id: `company_research.${id}`, version: EXECUTOR_VERSION } });
const tool = (toolRef: { id: string; version: string }, inputStateKey: string, resultStateKey: string) => ({ toolRef: { id: toolRef.id, version: toolRef.version }, inputStateKey, resultStateKey });
const model = (modelPolicyRef: string, requestStateKey: string, resultStateKey: string) => ({ modelPolicyRef, requestStateKey, resultStateKey });

/** Exact Toolbox refs the Workflow uses. */
export const DEDUPE_TOOL_REF = Object.freeze({ id: "records.dedupe", version: "1.0.0" });
export const PROJECT_TOOL_REF = Object.freeze({ id: "records.project", version: "1.0.0" });

/** Node ids in execution order. The graph is a straight chain: no branch, loop, or Agent. */
export const COMPANY_RESEARCH_NODE_ORDER = Object.freeze([
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
] as const);

const NODES = {
  intake: { kind: "deterministic", config: exec("intake") },
  plan: { kind: "model", config: model(PLANNING_POLICY_REF, K.planModelRequest, K.planResult) },
  validate_plan: { kind: "deterministic", config: exec("validate_plan") },
  prepare_search: { kind: "deterministic", config: exec("prepare_search") },
  search: { kind: "tool", config: tool(PUBLIC_WEB_SEARCH_TOOL_REF, K.searchInput, K.searchResult) },
  prepare_dedupe: { kind: "deterministic", config: exec("prepare_dedupe") },
  dedupe: { kind: "tool", config: tool(DEDUPE_TOOL_REF, K.dedupeInput, K.dedupeResult) },
  prepare_fetch: { kind: "deterministic", config: exec("prepare_fetch") },
  fetch: { kind: "tool", config: tool(PUBLIC_WEB_FETCH_TOOL_REF, K.fetchInput, K.fetchResult) },
  prepare_project: { kind: "deterministic", config: exec("prepare_project") },
  project: { kind: "tool", config: tool(PROJECT_TOOL_REF, K.projectInput, K.projectResult) },
  build_source_packet: { kind: "deterministic", config: exec("build_source_packet") },
  synthesize: { kind: "model", config: model(SYNTHESIS_POLICY_REF, K.synthesisModelRequest, K.synthesisResult) },
  validate_grounding: { kind: "deterministic", config: exec("validate_grounding") },
  render: { kind: "deterministic", config: exec("render") },
  final: { kind: "final_output", config: {} },
} as const;

/**
 * The Company Research Workflow (`company_research.proof@1.0.0`). It names
 * only canonical references: two Model Policies, four exact Tool refs, and
 * exact deterministic executor refs. No model vendor, search provider, SDK,
 * credential, or company-specific Tool appears in it. Provider binding is
 * host configuration, outside the Workflow.
 */
export const companyResearchWorkflow: Workflow = defineWorkflow({
  schemaVersion: 1,
  id: "company_research.proof",
  version: "1.0.0",
  name: "Company research (grounded public-web research)",
  description: "Plan bounded searches, collect public-web evidence through governed Tools, deduplicate and project it with Toolbox Tools, synthesize a structured draft, validate every citation deterministically, and render a report.",
  entryNodeId: COMPANY_RESEARCH_NODE_ORDER[0],
  nodes: COMPANY_RESEARCH_NODE_ORDER.map((id) => ({ id, ...NODES[id], config: { ...NODES[id].config } })),
  edges: COMPANY_RESEARCH_NODE_ORDER.slice(1).map((target, index) => ({ sourceNodeId: COMPANY_RESEARCH_NODE_ORDER[index]!, targetNodeId: target })),
});
