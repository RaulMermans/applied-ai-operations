import { createAAO, defineGovernance, type JsonValue, type Principal, type ReliabilityPolicy, type ToolDefinition, type Workflow, type WorkflowExecutionResult } from "@aao/framework";
import type { ToolSpec, TraceEvent } from "@aao/contracts";
import { createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import { createToolRegistry, executeTool } from "@aao/tool-runtime";
import { PUBLIC_WEB_FETCH_TOOL_REF, PUBLIC_WEB_SEARCH_TOOL_REF, createPublicWebTools, type PublicWebFetchResponse, type PublicWebProvider, type PublicWebProviderContext, type PublicWebSearchResponse } from "../src/index.js";

export const SECRET = "SECRET_DO_NOT_PERSIST";

export const researcher: Principal = { id: "user.researcher", type: "user" }; // read_only
export const drafter: Principal = { id: "user.drafter", type: "user" }; // write_draft only

export const governance = defineGovernance({
  actors: [researcher, drafter],
  roles: [
    { id: "researcher", version: "1.0.0", permissionClasses: ["read_only"] },
    { id: "drafter", version: "1.0.0", permissionClasses: ["write_draft"] },
  ],
  bindings: [
    { id: "researcher.researcher", actorId: researcher.id, roleId: "researcher", status: "active" },
    { id: "drafter.drafter", actorId: drafter.id, roleId: "drafter", status: "active" },
  ],
  policies: [],
});

type SearchScript = (query: string, context: PublicWebProviderContext) => PublicWebSearchResponse | Promise<PublicWebSearchResponse> | unknown;
type FetchScript = (url: string, maxChars: number, context: PublicWebProviderContext) => PublicWebFetchResponse | Promise<PublicWebFetchResponse> | unknown;

/** A scriptable in-memory provider that records every call. No network. */
export function scriptedProvider(scripts: { search?: SearchScript; fetch?: FetchScript } = {}) {
  const calls = { search: [] as { query: string; maxResults: number; allowedDomains?: readonly string[]; signal?: AbortSignal }[], fetch: [] as { url: string; maxChars: number; signal?: AbortSignal }[] };
  const provider: PublicWebProvider = {
    async search(request, context) {
      calls.search.push({ ...request, ...(context.signal ? { signal: context.signal } : {}) });
      return (await (scripts.search ?? (() => ({ status: "succeeded", hits: [] })))(request.query, context)) as PublicWebSearchResponse;
    },
    async fetch(request, context) {
      calls.fetch.push({ ...request, ...(context.signal ? { signal: context.signal } : {}) });
      return (await (scripts.fetch ?? ((url: string) => ({ status: "succeeded", title: `Title of ${url}`, text: `Text of ${url}` })))(request.url, request.maxChars, context)) as PublicWebFetchResponse;
    },
  };
  return { provider, calls };
}

/** Executes one public-web Tool through the canonical `executeTool` path with a read_only grant. */
export async function execute(tools: { search: ToolDefinition; fetchPages: ToolDefinition }, which: "search" | "fetchPages", input: unknown, signal?: AbortSignal) {
  const registry = createToolRegistry();
  const tool = tools[which];
  registry.register({ spec: { ...tool.spec, permissionClasses: [...tool.spec.permissionClasses] } as ToolSpec, handler: tool.handler, retrySafety: tool.retrySafety! });
  return executeTool({ tools: registry, request: { schemaVersion: 1, toolExecutionId: "unit.exec", toolRef: which === "search" ? PUBLIC_WEB_SEARCH_TOOL_REF : PUBLIC_WEB_FETCH_TOOL_REF, input }, authorizationContext: { schemaVersion: 1, principal: researcher, grantedPermissionClasses: ["read_only"] }, ...(signal ? { signal } : {}) });
}

/** The successful output of `execute`, or a thrown assertion with the failure. */
export async function output<T = Record<string, unknown>>(provider: PublicWebProvider, which: "search" | "fetchPages", input: unknown): Promise<T> {
  const result = await execute(createPublicWebTools({ provider }), which, input);
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`);
  return result.result.output as T;
}

export function fixedClock() {
  let tick = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 15, 9, 0, tick++)).toISOString() };
}

/** search → final: one Tool node on `values.input`, ToolResult at `values.result`. */
export function singleToolWorkflow(toolRef: { id: string; version: string }): Workflow {
  return {
    schemaVersion: 1, id: `public-web.single.${toolRef.id.replace(/[._]/g, "-")}`, version: "1.0.0", name: `Run ${toolRef.id}`, entryNodeId: "run",
    nodes: [
      { id: "run", kind: "tool", config: { toolRef: { ...toolRef }, inputStateKey: "input", resultStateKey: "result" } },
      { id: "final", kind: "final_output", config: {} },
    ],
    edges: [{ sourceNodeId: "run", targetNodeId: "final" }],
  };
}

/** Runs one public-web Tool through createAAO with a Trace recorder: the normal governed path. */
export async function runTool(options: { provider: PublicWebProvider; which: "search" | "fetchPages"; input: JsonValue; principal?: Principal; reliability?: ReliabilityPolicy }): Promise<{ result: WorkflowExecutionResult; trace: TraceEvent[] }> {
  const clock = fixedClock();
  const store = createInMemoryTraceStore();
  const tools = createPublicWebTools({ provider: options.provider });
  const app = createAAO({ governance, principalForRun: () => options.principal ?? researcher, tools: [tools.search, tools.fetchPages], trace: createTraceRecorder({ store, clock }), clock });
  const ref = options.which === "search" ? PUBLIC_WEB_SEARCH_TOOL_REF : PUBLIC_WEB_FETCH_TOOL_REF;
  const prepared = app.prepareWorkflow(singleToolWorkflow(ref), options.reliability ? { reliability: { policiesByNodeId: { run: options.reliability } } } : undefined);
  const result = await prepared.execute({ runId: "run.public-web", initialState: { runId: "run.public-web", revision: 0, values: { input: options.input } } });
  return { result, trace: (await store.getRunTrace("run.public-web")) as TraceEvent[] };
}
