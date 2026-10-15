// A consumer application using the AAO Toolbox. It imports ONLY the public
// `@aao/framework` and `@aao/toolbox` packages — no deep imports, no
// relative repository imports, no lower-level @aao/* package. The vitest
// E2E runs it against source; the compiled Sprint 21 smoke compiles it with
// tsc against the packages' dist declarations and runs it on dist JavaScript.
import { createAAO, defineGovernance, defineTool, defineWorkflow, type DeterministicExecutor, type JsonValue, type Principal, type WorkflowExecutionResult } from "@aao/framework";
import { coreToolbox, defineToolbox, searchToolbox, selectToolboxTools } from "@aao/toolbox";

export const analyst: Principal = { id: "user.analyst", type: "user" }; // read_only
export const drafter: Principal = { id: "user.drafter", type: "user" }; // write_draft only

export const governance = defineGovernance({
  actors: [analyst, drafter],
  roles: [
    { id: "analyst", version: "1.0.0", permissionClasses: ["read_only"] },
    { id: "drafter", version: "1.0.0", permissionClasses: ["write_draft"] },
  ],
  bindings: [
    { id: "analyst.analyst", actorId: analyst.id, roleId: "analyst", status: "active" },
    { id: "drafter.drafter", actorId: drafter.id, roleId: "drafter", status: "active" },
  ],
  policies: [],
});

const v1 = (id: string) => ({ id, version: "1.0.0" });

/** Host-owned glue between Tool steps: trusted deterministic code, not a Tool. */
const prepareProject: DeterministicExecutor = {
  id: "consumer.prepare-project",
  version: "1.0.0",
  async execute({ state }) {
    const deduped = state.values.deduped as { output: { data: { records: JsonValue[] } } };
    return { ok: true, statePatch: { projectInput: { records: deduped.output.data.records, fields: ["id", "name"] } } };
  },
};
const prepareChunk: DeterministicExecutor = {
  id: "consumer.prepare-chunk",
  version: "1.0.0",
  async execute({ state }) {
    const normalized = state.values.normalized as { output: { data: { text: string } } };
    return { ok: true, statePatch: { chunkInput: { text: normalized.output.data.text, maxChars: 16, overlapChars: 4 } } };
  },
};

export const accountsWorkflow = defineWorkflow({
  schemaVersion: 1, id: "consumer.accounts", version: "1.0.0", name: "Deduplicate and project accounts", entryNodeId: "dedupe",
  nodes: [
    { id: "dedupe", kind: "tool", config: { toolRef: v1("records.dedupe"), inputStateKey: "accounts", resultStateKey: "deduped" } },
    { id: "prepare", kind: "deterministic", config: { executorRef: v1("consumer.prepare-project") } },
    { id: "project", kind: "tool", config: { toolRef: v1("records.project"), inputStateKey: "projectInput", resultStateKey: "projected" } },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "dedupe", targetNodeId: "prepare" }, { sourceNodeId: "prepare", targetNodeId: "project" }, { sourceNodeId: "project", targetNodeId: "final" }],
});

export const notesWorkflow = defineWorkflow({
  schemaVersion: 1, id: "consumer.notes", version: "1.0.0", name: "Normalize and chunk notes", entryNodeId: "normalize",
  nodes: [
    { id: "normalize", kind: "tool", config: { toolRef: v1("text.normalize"), inputStateKey: "notes", resultStateKey: "normalized" } },
    { id: "prepare", kind: "deterministic", config: { executorRef: v1("consumer.prepare-chunk") } },
    { id: "chunk", kind: "tool", config: { toolRef: v1("text.chunk"), inputStateKey: "chunkInput", resultStateKey: "chunked" } },
    { id: "final", kind: "final_output", config: {} },
  ],
  edges: [{ sourceNodeId: "normalize", targetNodeId: "prepare" }, { sourceNodeId: "prepare", targetNodeId: "chunk" }, { sourceNodeId: "chunk", targetNodeId: "final" }],
});

/** Discoverable in the catalog, but this host never selects it. */
export const sortWorkflow = defineWorkflow({
  schemaVersion: 1, id: "consumer.sort", version: "1.0.0", name: "Sort", entryNodeId: "sort",
  nodes: [{ id: "sort", kind: "tool", config: { toolRef: v1("records.sort"), inputStateKey: "input", resultStateKey: "sorted" } }, { id: "final", kind: "final_output", config: {} }],
  edges: [{ sourceNodeId: "sort", targetNodeId: "final" }],
});

/** A host's own Toolbox: a framework primitive, not only the Core constant. */
export const greetingsToolbox = defineToolbox({
  manifest: {
    id: "consumer.greetings",
    version: "1.0.0",
    name: "Consumer greetings",
    description: "A consumer-defined Toolbox.",
    entries: [{ toolRef: v1("consumer.greet"), category: "text", tags: ["greeting"], whenToUse: ["A friendly greeting is needed."], whenNotToUse: ["Anything else."], examples: [{ title: "Greet", input: { name: "Ada" } }] }],
  },
  tools: [
    defineTool({
      spec: { schemaVersion: 1, id: "consumer.greet", version: "1.0.0", name: "Greet", description: "Returns a greeting for the supplied name. Pure computation with no side effects.", inputSchema: { type: "object", properties: { name: { type: "string", maxLength: 64 } }, required: ["name"], additionalProperties: false }, outputSchema: { type: "object", properties: { greeting: { type: "string" } }, required: ["greeting"], additionalProperties: false }, permissionClasses: ["read_only"] },
      handler: { execute: async ({ input }) => ({ ok: true, output: { greeting: `Hello, ${(input as { name: string }).name}!` } }) },
      retrySafety: "safe",
    }),
  ],
});

export const greetWorkflow = defineWorkflow({
  schemaVersion: 1, id: "consumer.greet", version: "1.0.0", name: "Greet", entryNodeId: "greet",
  nodes: [{ id: "greet", kind: "tool", config: { toolRef: v1("consumer.greet"), inputStateKey: "person", resultStateKey: "greeting" } }, { id: "final", kind: "final_output", config: {} }],
  edges: [{ sourceNodeId: "greet", targetNodeId: "final" }],
});

const summary = (result: WorkflowExecutionResult) => JSON.parse(JSON.stringify({
  ok: result.ok,
  status: result.execution?.run.status,
  failure: result.ok ? undefined : result.failure.code,
  executorFailure: result.ok ? undefined : result.failure.executorFailure?.code,
  details: result.ok ? undefined : result.failure.details,
})) as { ok: boolean; status?: string; failure?: string; executorFailure?: string; details?: Record<string, unknown> };

/** Every consumer scenario through the public API only. */
export async function runConsumerScenarios() {
  // 1. Discovery is information: a deterministic lexical search over the catalog.
  const discovered = searchToolbox(coreToolbox, { query: "remove duplicate records" }).map((result) => result.toolRef.id);

  // 2. Explicit selection by exact refs, then explicit registration. Importing @aao/toolbox registered nothing.
  const tools = [...selectToolboxTools(coreToolbox, [v1("records.dedupe"), v1("records.project"), v1("text.normalize"), v1("text.chunk")]), ...selectToolboxTools(greetingsToolbox, [v1("consumer.greet")])];
  const sessions = new Map<string, Principal>();
  const started: string[] = [];
  let tick = 0;
  const app = createAAO({
    governance,
    principalForRun: ({ runId }) => {
      const principal = sessions.get(runId);
      if (principal === undefined) throw new Error("no authenticated session for this Run");
      return principal;
    },
    tools,
    deterministicExecutors: [prepareProject, prepareChunk],
    trace: {
      async emit(draft) {
        const event = draft as unknown as { type: string; payload?: { toolRef?: { id: string } } };
        if (event.type === "tool.call.started" && event.payload?.toolRef) started.push(event.payload.toolRef.id);
      },
    },
    clock: { now: () => new Date(Date.UTC(2026, 9, 15, 9, 0, tick++)).toISOString() },
  });
  const execute = (workflow: Parameters<typeof app.prepareWorkflow>[0], runId: string, principal: Principal, values: Record<string, JsonValue>) => {
    sessions.set(runId, principal);
    return app.prepareWorkflow(workflow).execute({ runId, initialState: { runId, revision: 0, values } });
  };

  // 3. records.dedupe → records.project.
  const accounts = await execute(accountsWorkflow, "run-accounts", analyst, { accounts: { records: [{ id: "a-1", name: "Acme", owner: "x" }, { id: "a-2", name: "Globex", owner: "y" }, { id: "a-1", name: "Acme (dup)", owner: "z" }], keys: ["id"] } });
  const accountsCalls = [...started];
  // 4. text.normalize → text.chunk.
  const notes = await execute(notesWorkflow, "run-notes", analyst, { notes: { text: "  Toolbox Tools\r\nrun through the\r\n\r\n\r\nnormal Tool Runtime.  ", maxConsecutiveBlankLines: 1 } });
  // 5. Canonical Authorization denial: zero handler starts.
  const before = started.length;
  const denied = await execute(accountsWorkflow, "run-denied", drafter, { accounts: { records: [], keys: ["id"] } });
  const deniedStarts = started.length - before;
  // 6. Discovered but not selected ⇒ not executable.
  const unselected = await execute(sortWorkflow, "run-sort", analyst, { input: { records: [], keys: [{ field: "id" }] } });
  // 7. A consumer-defined Toolbox Tool runs through the same path.
  const greeting = await execute(greetWorkflow, "run-greet", analyst, { person: { name: "Ada" } });

  return {
    discovered,
    accounts: { summary: summary(accounts), projected: (accounts.execution?.state.values.projected as { output: JsonValue } | undefined)?.output, calls: accountsCalls },
    notes: { summary: summary(notes), chunks: (notes.execution?.state.values.chunked as { output: { data: { chunks: { start: number; end: number; text: string }[] } } } | undefined)?.output.data.chunks },
    denied: { summary: summary(denied), starts: deniedStarts },
    unselected: { discoverable: searchToolbox(coreToolbox, { query: "records.sort" })[0]?.toolRef.id, summary: summary(unselected) },
    greeting: { summary: summary(greeting), output: (greeting.execution?.state.values.greeting as { output: JsonValue } | undefined)?.output },
    started,
  };
}
