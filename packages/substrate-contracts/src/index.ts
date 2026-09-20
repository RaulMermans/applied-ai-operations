/** AAO-owned prototype contracts. No substrate framework types belong here. */
export type PrototypeNode =
  | { id: string; kind: "deterministic"; operation: "normalize" }
  | { id: string; kind: "model"; operation: "classify" }
  | { id: string; kind: "branch"; routes: readonly string[] }
  | { id: string; kind: "output"; operation: "format" };

export type PrototypeEdge = { from: string; to: string; route?: string };

export type PrototypeWorkflow = {
  id: string;
  nodes: readonly PrototypeNode[];
  edges: readonly PrototypeEdge[];
};

export type WorkflowRunState = {
  input: string;
  normalized?: string;
  reasoning?: string;
  route?: string;
  output?: string;
};

export type ModelRequest = { prompt: string; schemaName: string };
export type ModelResult = { data: unknown; provider: string };
export interface ModelExecutor {
  execute(request: ModelRequest): Promise<ModelResult>;
}

export type DurableRun = {
  runId: string;
  status: "running" | "interrupted" | "completed";
  currentStep: string;
  state: Record<string, unknown>;
  completedOperations: string[];
  checkpoint: number;
};

export interface DurableExecutor {
  start(runId: string): Promise<DurableRun>;
  resume(runId: string): Promise<DurableRun>;
  cancel(runId: string): Promise<DurableRun>;
  getRun(runId: string): Promise<DurableRun>;
}

export type Account = { id: string; name: string; score: number };
export interface CrmCapability {
  searchAccounts(query: string): Promise<Account[]>;
}
