import { describe, expect, it } from "vitest";
import { validateTrace } from "@aao/observability";
import type { WorkflowExecutionResult } from "@aao/framework";
import { SECRET, drafter, runTool, scriptedProvider } from "./support.js";

const failureOf = (result: WorkflowExecutionResult) => (result.ok ? undefined : result.failure);

const types = (trace: { type: string }[]) => trace.map((event) => event.type);

describe("public-web Tools through the normal governed Tool Runtime", () => {
  it("a read_only principal runs public_web.search; the canonical ToolResult enters state", async () => {
    const { provider, calls } = scriptedProvider({ search: () => ({ status: "succeeded", hits: [{ url: "https://acme.example/", title: "Acme" }] }) });
    const { result, trace } = await runTool({ provider, which: "search", input: { queries: ["acme"] } });
    expect(result.ok).toBe(true);
    expect(result.execution!.state.values.result).toMatchObject({ schemaVersion: 1, toolRef: { id: "public_web.search", version: "1.0.0" }, output: { status: "success" } });
    expect(calls.search).toHaveLength(1);
    expect(types(trace)).toContain("tool.call.started");
    expect(validateTrace(trace).valid).toBe(true);
  });

  it("a principal without read_only is denied canonically: zero provider calls", async () => {
    const { provider, calls } = scriptedProvider();
    const { result, trace } = await runTool({ provider, which: "search", input: { queries: ["acme"] }, principal: drafter });
    expect(result.ok).toBe(false);
    expect(failureOf(result)).toMatchObject({ code: "NODE_EXECUTION_FAILED", executorFailure: { namespace: "tool", code: "TOOL_AUTHORIZATION_DENIED" } });
    expect(calls.search).toHaveLength(0);
    expect(types(trace)).toContain("tool.call.blocked");
    expect(types(trace)).not.toContain("tool.call.started");
  });

  it("the same Authorization applies to fetch: zero provider calls when denied", async () => {
    const { provider, calls } = scriptedProvider();
    const { result } = await runTool({ provider, which: "fetchPages", input: { urls: ["https://acme.example/"] }, principal: drafter });
    expect(failureOf(result)).toMatchObject({ executorFailure: { code: "TOOL_AUTHORIZATION_DENIED" } });
    expect(calls.fetch).toHaveLength(0);
  });

  it("an unregistered principal has no authority (TOOL_AUTHORIZATION_REQUIRED)", async () => {
    const { provider, calls } = scriptedProvider();
    const { result } = await runTool({ provider, which: "search", input: { queries: ["acme"] }, principal: { id: "user.stranger", type: "user" } });
    expect(failureOf(result)).toMatchObject({ executorFailure: { code: "TOOL_AUTHORIZATION_REQUIRED" } });
    expect(calls.search).toHaveLength(0);
  });

  it("retries are the Runtime's: an outage is retried only under an explicit reliability policy", async () => {
    let attempts = 0;
    const flaky = () => scriptedProvider({ search: () => (++attempts === 1 ? { status: "failed", reason: "unavailable" } : { status: "succeeded", hits: [{ url: "https://acme.example/", title: "Acme" }] }) });
    const withPolicy = await runTool({ provider: flaky().provider, which: "search", input: { queries: ["acme"] }, reliability: { maxAttempts: 2 } });
    expect(withPolicy.result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(types(withPolicy.trace)).toContain("retry.scheduled");

    attempts = 0;
    const withoutPolicy = await runTool({ provider: flaky().provider, which: "search", input: { queries: ["acme"] } });
    expect(failureOf(withoutPolicy.result)).toMatchObject({ executorFailure: { code: "TOOL_EXECUTION_FAILED" } });
    expect(attempts).toBe(1);
  });

  it("Trace stays metadata-only: seeded secrets in provider errors and page content never reach it", async () => {
    const { provider } = scriptedProvider({ fetch: (url) => (url.endsWith("/bad") ? Promise.reject(new Error(SECRET)) : { status: "succeeded", title: SECRET, text: `content ${SECRET}` }) });
    const { result, trace } = await runTool({ provider, which: "fetchPages", input: { urls: ["https://acme.example/good", "https://acme.example/bad"] } });
    expect(result.ok).toBe(true);
    // Source content is legitimate Run state (evidence) …
    expect(JSON.stringify(result.execution!.state)).toContain(SECRET);
    // … but never observability.
    expect(JSON.stringify(trace)).not.toContain(SECRET);
    expect(validateTrace(trace).valid).toBe(true);
  });
});
