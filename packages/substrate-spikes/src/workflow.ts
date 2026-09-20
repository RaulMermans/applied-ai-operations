import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type {
  PrototypeEdge,
  PrototypeNode,
  PrototypeWorkflow,
  WorkflowRunState,
} from "@aao/substrate-contracts";

export class WorkflowValidationError extends Error {}

const GraphState = Annotation.Root({
  input: Annotation<string>,
  normalized: Annotation<string | undefined>,
  reasoning: Annotation<string | undefined>,
  route: Annotation<string | undefined>,
  output: Annotation<string | undefined>,
});

type DynamicCompiledGraph = {
  invoke(input: Pick<WorkflowRunState, "input">): Promise<WorkflowRunState>;
};

// AAO workflows are data-driven; their node identifiers are unknown at TypeScript
// compile time. This narrow internal bridge contains LangGraph's literal-node typing.
type DynamicGraph = {
  addNode(id: string, action: (state: WorkflowRunState) => Partial<WorkflowRunState>): void;
  addEdge(from: string, to: string): void;
  addConditionalEdges(
    source: string,
    route: (state: WorkflowRunState) => string,
    destinations: Record<string, string>,
  ): void;
  compile(): DynamicCompiledGraph;
};

function outgoing(edges: readonly PrototypeEdge[], id: string) {
  return edges.filter((edge) => edge.from === id);
}

function nodeById(workflow: PrototypeWorkflow, id: string): PrototypeNode {
  const node = workflow.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new WorkflowValidationError(`Unknown workflow node: ${id}`);
  return node;
}

/** Validates AAO data before the LangGraph adapter sees it. */
export function validateWorkflow(workflow: PrototypeWorkflow): void {
  if (!workflow.id) throw new WorkflowValidationError("Workflow requires an id");
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) throw new WorkflowValidationError(`Duplicate node: ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of workflow.edges) {
    nodeById(workflow, edge.from);
    nodeById(workflow, edge.to);
  }
  for (const node of workflow.nodes.filter((item) => item.kind === "branch")) {
    const routes = outgoing(workflow.edges, node.id).map((edge) => edge.route);
    for (const route of node.routes) {
      if (!routes.includes(route)) {
        throw new WorkflowValidationError(`Branch ${node.id} is missing route: ${route}`);
      }
    }
  }
}

function runNode(node: PrototypeNode, state: WorkflowRunState): Partial<WorkflowRunState> {
  switch (node.kind) {
    case "deterministic":
      return { normalized: state.input.trim().toLowerCase() };
    case "model": {
      const normalized = state.normalized ?? state.input;
      return {
        reasoning: `classified:${normalized}`,
        route: normalized.length > 5 ? "long" : "short",
      };
    }
    case "branch":
      return {};
    case "output":
      return { output: `${state.route}:${state.reasoning}` };
  }
}

/**
 * Translates the neutral AAO prototype into LangGraph internally. The function's
 * input/output deliberately expose only AAO contract types.
 */
export function compileToLangGraph(workflow: PrototypeWorkflow) {
  validateWorkflow(workflow);
  const graph = new StateGraph(GraphState) as unknown as DynamicGraph;
  const incoming = new Set(workflow.edges.map((edge) => edge.to));
  const roots = workflow.nodes.filter((node) => !incoming.has(node.id));
  if (roots.length !== 1) throw new WorkflowValidationError("Workflow needs exactly one root node");
  const root = roots[0];
  if (!root) throw new WorkflowValidationError("Workflow has no root node");

  for (const node of workflow.nodes) {
    graph.addNode(node.id, (state) => runNode(node, state));
  }
  graph.addEdge(START, root.id);

  for (const node of workflow.nodes) {
    if (node.kind === "branch") {
      const mapping = Object.fromEntries(
        outgoing(workflow.edges, node.id)
          .filter((edge): edge is PrototypeEdge & { route: string } => Boolean(edge.route))
          .map((edge) => [edge.route, edge.to]),
      );
      graph.addConditionalEdges(node.id, (state) => state.route ?? "", mapping);
      continue;
    }
    const next = outgoing(workflow.edges, node.id);
    if (next.length === 0) graph.addEdge(node.id, END);
    if (next.length === 1) graph.addEdge(node.id, next[0]!.to);
    if (next.length > 1) throw new WorkflowValidationError(`Only branch nodes may fan out: ${node.id}`);
  }
  return graph.compile();
}

export async function executeWorkflow(workflow: PrototypeWorkflow, input: string): Promise<WorkflowRunState> {
  return compileToLangGraph(workflow).invoke({ input });
}

export const sampleWorkflow: PrototypeWorkflow = {
  id: "classify-input",
  nodes: [
    { id: "normalize", kind: "deterministic", operation: "normalize" },
    { id: "reason", kind: "model", operation: "classify" },
    { id: "choose", kind: "branch", routes: ["short", "long"] },
    { id: "short-output", kind: "output", operation: "format" },
    { id: "long-output", kind: "output", operation: "format" },
  ],
  edges: [
    { from: "normalize", to: "reason" },
    { from: "reason", to: "choose" },
    { from: "choose", to: "short-output", route: "short" },
    { from: "choose", to: "long-output", route: "long" },
  ],
};
