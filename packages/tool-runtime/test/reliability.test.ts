import { describe, expect, it } from "vitest";
import type { PermissionClass, ReliabilityPolicy } from "@aao/contracts";
import { authorizationContextFromAuthority } from "@aao/authorization";
import { createGovernanceRegistry, resolveAuthority } from "@aao/governance";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { createNodeRegistry, executeWorkflow, finalOutputExecutor, type RuntimeSleeper } from "@aao/runtime";
import { executeTool } from "../src/executor.js";
import { TOOL_FAILURE_CODES, type RegisteredTool, type ToolHandlerResult } from "../src/types.js";
import { classifyToolFailure, createToolNodeExecutor, type ResolveToolAuthorizationContext } from "../src/tool-node.js";
import { LOOKUP_REF, SECRET, authContext, buildRegistry, buildRequest, buildToolSpec, spyHandler } from "./fixtures.js";

/**
 * Sprint 13: the Tool Node participates in Runtime reliability only through
 * trusted metadata (a registered Tool's `retrySafety`, a handler's explicit
 * `retryable` flag) and structured classification. Tool Runtime itself
 * still invokes a handler at most once per `executeTool` call.
 */
const WORKFLOW_YAML = `
schemaVersion: 1
id: examples.reliable-lookup
version: "1.0.0"
name: Reliable lookup
entryNodeId: lookup
nodes:
  - id: lookup
    kind: tool
    config:
      toolRef: { id: local.lookup, version: "1.0.0" }
      inputStateKey: lookupInput
      resultStateKey: lookupResult
  - id: final
    kind: final_output
    config: {}
edges:
  - { sourceNodeId: lookup, targetNodeId: final }
`;
const compiled = compileWorkflowSource(WORKFLOW_YAML, "yaml");
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
const plan = compiled.plan;

const TRANSIENT: ToolHandlerResult = { ok: false, code: "DEPENDENCY_TEMPORARILY_UNAVAILABLE", retryable: true };
const immediateSleeper = (): RuntimeSleeper & { delays: number[] } => {
  const delays: number[] = [];
  return { delays, sleep: (ms, signal) => (signal ? new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })) : (delays.push(ms), Promise.resolve())) };
};

function world(options: { script: Array<ToolHandlerResult | (() => Promise<ToolHandlerResult>)>; permissionClasses?: PermissionClass[]; retrySafety?: RegisteredTool["retrySafety"]; policy?: ReliabilityPolicy; resolve?: ResolveToolAuthorizationContext; sleeper?: RuntimeSleeper }) {
  let index = 0;
  const handler = spyHandler(() => {
    const step = options.script[Math.min(index++, options.script.length - 1)]!;
    return typeof step === "function" ? step() : step;
  });
  const tools = buildRegistry([{ spec: buildToolSpec({ permissionClasses: options.permissionClasses ?? ["read_only"] }), handler, ...(options.retrySafety ? { retrySafety: options.retrySafety } : {}) }]);
  const registry = createNodeRegistry();
  registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: options.resolve ?? (() => authContext(["read_only", "write_draft"])) }));
  registry.register(finalOutputExecutor);
  let tick = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 9, 7, 9, 0, tick++)).toISOString() };
  const runId = "run.reliable.lookup";
  const result = executeWorkflow({ runId, plan, registry, initialState: { runId, revision: 0, values: { lookupInput: { query: "alpha" } } }, options: { clock, sleeper: options.sleeper ?? immediateSleeper(), reliability: { policiesByNodeId: { lookup: options.policy ?? { maxAttempts: 3 } } } } });
  return { handler, result };
}

describe("Tool retry-safety registration", () => {
  it("defaults to unsafe and accepts an explicit safe declaration only for read_only Tools", () => {
    const handler = spyHandler();
    expect(() => buildRegistry([{ spec: buildToolSpec(), handler, retrySafety: "safe" }])).not.toThrow();
    for (const permissionClasses of [["write_draft"], ["read_only", "write_draft"], ["external_side_effect"], ["destructive"], ["sensitive_data"], ["read_only", "sensitive_data"]] as PermissionClass[][]) {
      expect(() => buildRegistry([{ spec: buildToolSpec({ permissionClasses }), handler, retrySafety: "safe" }])).toThrow(/read_only/);
      expect(() => buildRegistry([{ spec: buildToolSpec({ permissionClasses }), handler, retrySafety: "unsafe" }])).not.toThrow();
    }
    expect(() => buildRegistry([{ spec: buildToolSpec(), handler, retrySafety: "maybe" as never }])).toThrow(/retrySafety/);
  });

  it("classifies every Tool failure code deterministically; only an explicit handler retryable flag is transient", () => {
    const expected: Record<(typeof TOOL_FAILURE_CODES)[number], string> = {
      INVALID_TOOL_REQUEST: "VALIDATION",
      TOOL_NOT_FOUND: "VALIDATION",
      TOOL_PERMISSION_UNSUPPORTED: "POLICY",
      TOOL_AUTHORIZATION_REQUIRED: "AUTHORIZATION",
      TOOL_AUTHORIZATION_DENIED: "AUTHORIZATION",
      TOOL_INPUT_SCHEMA_MISMATCH: "VALIDATION",
      TOOL_EXECUTION_FAILED: "EXECUTION",
      TOOL_OUTPUT_SCHEMA_MISMATCH: "VALIDATION",
      INVALID_TOOL_RESULT: "VALIDATION",
    };
    for (const code of TOOL_FAILURE_CODES) {
      expect(classifyToolFailure({ code })).toBe(expected[code]);
      expect(classifyToolFailure({ code, handlerFailureRetryable: true })).toBe(code === "TOOL_EXECUTION_FAILED" ? "TRANSIENT_DEPENDENCY" : expected[code]);
    }
  });

  it("executeTool carries the handler's retryable flag as bounded evidence, rejects anything richer, and still calls the handler once", async () => {
    const handler = spyHandler(() => TRANSIENT);
    const tools = buildRegistry([{ spec: buildToolSpec(), handler, retrySafety: "safe" }]);
    const outcome = await executeTool({ tools, request: buildRequest(), authorizationContext: authContext(["read_only"]) });
    expect(!outcome.ok && outcome.failure).toMatchObject({ code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "DEPENDENCY_TEMPORARILY_UNAVAILABLE", handlerFailureRetryable: true });
    expect(handler.calls).toHaveLength(1);
    for (const malformed of [{ ok: false, code: "X", retryable: false }, { ok: false, code: "X", retryable: "yes" }, { ok: false, code: "X", retryable: true, retryAfterMs: 5 }]) {
      const tools2 = buildRegistry([{ spec: buildToolSpec(), handler: spyHandler(() => malformed as never) }]);
      const result = await executeTool({ tools: tools2, request: buildRequest(), authorizationContext: authContext(["read_only"]) });
      expect(!result.ok && result.failure.code).toBe("INVALID_TOOL_RESULT");
    }
  });
});

describe("Tool reliability E2E: YAML → compiler → Runtime → Tool Node → handler", () => {
  it("read-only retry-safe Tool: attempt 1 transient → attempt 2 success; accepted once; Run COMPLETED", async () => {
    const { handler, result: pending } = world({ script: [TRANSIENT, { ok: true, output: { items: ["alpha-result"] } }], retrySafety: "safe" });
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(handler.calls).toHaveLength(2);
    // One logical Tool execution: the same deterministic execution id on every attempt.
    expect(new Set(handler.calls.map((call) => call.toolExecutionId)).size).toBe(1);
    expect(result.execution.run.status).toBe("COMPLETED");
    expect(result.execution.nodeStatusesById).toEqual({ lookup: "SUCCEEDED", final: "SUCCEEDED" });
    expect(result.execution.state.revision).toBe(1);
    expect(result.execution.history[0]).toMatchObject({ status: "SUCCEEDED", stateRevisionBefore: 0, stateRevisionAfter: 1, attemptCount: 2, attemptFailures: [{ attempt: 1, category: "TRANSIENT_DEPENDENCY", causeCode: "TOOL_EXECUTION_FAILED" }] });
    expect(result.output).toMatchObject({ lookupResult: { output: { items: ["alpha-result"] } } });
  });

  it("retry exhaustion: three transient failures → three calls, NODE_RETRY_EXHAUSTED, state unchanged", async () => {
    const { handler, result: pending } = world({ script: [TRANSIENT], retrySafety: "safe" });
    const result = await pending;
    expect(handler.calls).toHaveLength(3);
    expect(!result.ok && result.failure).toMatchObject({ code: "NODE_RETRY_EXHAUSTED", category: "TRANSIENT_DEPENDENCY", retryable: true, attempt: 3, maxAttempts: 3, causeCode: "TOOL_EXECUTION_FAILED", executorFailure: { namespace: "tool", code: "TOOL_EXECUTION_FAILED", category: "TRANSIENT_DEPENDENCY" } });
    expect(!result.ok && result.execution?.state).toEqual({ runId: "run.reliable.lookup", revision: 0, values: { lookupInput: { query: "alpha" } } });
    expect(!result.ok && result.execution?.nodeStatusesById).toEqual({ lookup: "FAILED", final: "PENDING" });
  });

  it.each<[string, PermissionClass[], RegisteredTool["retrySafety"]]>([
    ["write_draft Tool", ["write_draft"], undefined],
    ["write_draft Tool declared unsafe", ["write_draft"], "unsafe"],
    ["read_only Tool without a safe declaration", ["read_only"], undefined],
  ])("%s: retryable failure + maxAttempts 3 → exactly one handler call", async (_label, permissionClasses, retrySafety) => {
    const { handler, result: pending } = world({ script: [TRANSIENT, { ok: true, output: { items: [] } }], permissionClasses, retrySafety });
    const result = await pending;
    expect(handler.calls.length).toBeLessThanOrEqual(1);
    expect(handler.calls).toHaveLength(1);
    expect(!result.ok && result.failure).toMatchObject({ code: "NODE_EXECUTION_FAILED", category: "TRANSIENT_DEPENDENCY", retryable: true, attempt: 1, maxAttempts: 3 });
  });

  it("an unflagged handler failure (e.g. an MCP-style call failure code) is never retried", async () => {
    const { handler, result: pending } = world({ script: [{ ok: false, code: "MCP_CALL_FAILED" }, { ok: true, output: { items: [] } }], retrySafety: "safe" });
    const result = await pending;
    expect(handler.calls).toHaveLength(1);
    expect(!result.ok && result.failure).toMatchObject({ category: "EXECUTION", retryable: false });
  });

  it("a thrown handler is never retried and leaks nothing", async () => {
    const { handler, result: pending } = world({ script: [() => Promise.reject(new Error(`${SECRET} transient, please retry`)), { ok: true, output: { items: [] } }], retrySafety: "safe" });
    const result = await pending;
    expect(handler.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("internal.example.com");
    expect(JSON.stringify(result)).not.toContain("please retry");
  });

  it("timeout race through the Tool Node: hung attempt aborted and ignored, second attempt accepted once", async () => {
    let releaseLate!: (value: ToolHandlerResult) => void;
    const late = new Promise<ToolHandlerResult>((resolve) => (releaseLate = resolve));
    let timeoutIndex = 0;
    const sleeper: RuntimeSleeper = { sleep: (_ms, signal) => (signal && timeoutIndex++ === 0 ? Promise.resolve() : new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }) ?? resolve())) };
    const { handler, result: pending } = world({ script: [() => late, { ok: true, output: { items: ["second"] } }], retrySafety: "safe", policy: { maxAttempts: 2, attemptTimeoutMs: 500 }, sleeper });
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(handler.calls).toHaveLength(2);
    expect(handler.signals.map((signal) => signal?.aborted)).toEqual([true, false]);
    releaseLate({ ok: true, output: { items: ["late"] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.execution.state.revision).toBe(1);
    expect(result.execution.state.values.lookupResult).toMatchObject({ output: { items: ["second"] } });
    expect(result.output).toMatchObject({ lookupResult: { output: { items: ["second"] } } });
  });
});

describe("retries never create authority or support", () => {
  it.each<[string, ResolveToolAuthorizationContext]>([
    ["Authorization DENY (no grant)", () => authContext([])],
    ["missing authorization context", () => undefined],
    ["Agent permission ceiling", () => authContext(["read_only"], { agentCeiling: ["write_draft"] })],
    [
      "Governance policy DENY",
      () => {
        const governance = createGovernanceRegistry({
          actors: [{ id: "user.alice", type: "user" }],
          roles: [{ id: "researcher", version: "1.0.0", permissionClasses: ["read_only"] }],
          bindings: [{ id: "alice.researcher", actorId: "user.alice", roleId: "researcher", status: "active" }],
          policies: [{ id: "deny.read", rules: [{ id: "read", effect: "DENY", permissionClasses: ["read_only"] }] }],
        });
        const decision = resolveAuthority(governance, { id: "user.alice", type: "user" }, ["read_only"]);
        return authorizationContextFromAuthority(decision.authority!);
      },
    ],
  ])("%s with a retry-safe Tool and maxAttempts 3 → one attempt, zero handler calls", async (_label, resolve) => {
    const { handler, result: pending } = world({ script: [{ ok: true, output: { items: [] } }], retrySafety: "safe", resolve });
    const result = await pending;
    expect(handler.calls).toHaveLength(0);
    expect(!result.ok && result.failure).toMatchObject({ code: "NODE_EXECUTION_FAILED", category: "AUTHORIZATION", retryable: false, attempt: 1, maxAttempts: 3 });
    expect(!result.ok && result.execution?.history[0]?.attemptCount).toBe(1);
  });

  it("invalid Tool input with a retry-safe Tool and maxAttempts 3 → one attempt, zero handler calls", async () => {
    const handler = spyHandler();
    const tools = buildRegistry([{ spec: buildToolSpec(), handler, retrySafety: "safe" }]);
    const registry = createNodeRegistry();
    registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => authContext(["read_only"]) }));
    registry.register(finalOutputExecutor);
    const result = await executeWorkflow({ runId: "run.bad.input", plan, registry, initialState: { runId: "run.bad.input", revision: 0, values: { lookupInput: { query: 42 } } }, options: { sleeper: immediateSleeper(), reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } } });
    expect(handler.calls).toHaveLength(0);
    expect(!result.ok && result.failure).toMatchObject({ category: "VALIDATION", retryable: false, attempt: 1 });
  });

  it.each<PermissionClass>(["external_side_effect", "destructive", "sensitive_data"])("%s Tool with maxAttempts 3: unsupported, zero handler calls, zero attempts", async (permissionClass) => {
    const handler = spyHandler();
    const tools = buildRegistry([{ spec: buildToolSpec({ permissionClasses: [permissionClass] }), handler }]);
    const registry = createNodeRegistry();
    registry.register(createToolNodeExecutor({ tools, resolveAuthorizationContext: () => authContext([permissionClass]) }));
    registry.register(finalOutputExecutor);
    const result = await executeWorkflow({ runId: "run.unsupported", plan, registry, initialState: { runId: "run.unsupported", revision: 0, values: { lookupInput: { query: "alpha" } } }, options: { sleeper: immediateSleeper(), reliability: { policiesByNodeId: { lookup: { maxAttempts: 3 } } } } });
    expect(!result.ok && result.failure.code).toBe("RUNTIME_PREFLIGHT_FAILED");
    expect(JSON.stringify(!result.ok && result.failure)).toContain("TOOL_PERMISSION_UNSUPPORTED");
    expect(!result.ok && result.execution?.history).toEqual([]);
    expect(handler.calls).toHaveLength(0);
    // Direct path: the support gate answers before any handler, every time.
    for (let attempt = 0; attempt < 3; attempt++) {
      const direct = await executeTool({ tools, request: buildRequest({ toolRef: { ...LOOKUP_REF } }), authorizationContext: authContext([permissionClass]) });
      expect(!direct.ok && direct.failure.code).toBe("TOOL_PERMISSION_UNSUPPORTED");
    }
    expect(handler.calls).toHaveLength(0);
  });
});
