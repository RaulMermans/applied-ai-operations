import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ADAPTER_CONFORMANCE_SCENARIOS, ADAPTER_CONFORMANCE_SUITE, adapterConformancePassed, defineAdapterManifest, validateAdapterConformanceReportIntegrity, type AdapterConformanceReport, type AdapterConformanceScenario } from "@aao/adapters";
import { AdapterConformanceError, createEvaluatorRegistry, deterministicGraders } from "@aao/evaluation";
import { createMcpConformanceSubject } from "@aao/mcp-connector/conformance";
import { createVercelAiConformanceSubject } from "@aao/model-runtime/vercel-ai/conformance";
import { createConformanceDriver, nativeModelReference, nativeToolReference, verifyAdapterConformance, type ModelConformanceSubject, type ToolProviderConformanceSubject } from "@aao/framework/conformance";
import { renderConformance, renderMatrixMarkdown, runAdapterConformance, runAdaptersMatrix } from "../src/cli/eval/adapters.js";
import { installNetworkGuard } from "../src/cli/eval/network-guard.js";

/**
 * Sprint 20 adapter conformance through the public contract: manifests
 * declare, the canonical suite verifies, and the native AAO references
 * are the semantic baseline. One official pass spawns a real MCP stdio
 * child process per MCP scenario and loads the AI SDK, so it runs once
 * (beforeAll) and is shared. Only tests that spawn processes get the
 * scoped budget. No global timeout changes.
 */
const SUBPROCESS_BUDGET_MS = 60_000;
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scenario = (id: string) => ADAPTER_CONFORMANCE_SCENARIOS.find((entry) => entry.id === id)!;
const statuses = (report: AdapterConformanceReport) => Object.fromEntries(report.scenarios.map((entry) => [entry.scenarioId, entry.status]));
type Trace = Array<{ type: string; payload: Record<string, unknown> }>;

let official: Awaited<ReturnType<typeof runAdapterConformance>>;
beforeAll(async () => {
  official = await runAdapterConformance();
}, SUBPROCESS_BUDGET_MS);
const outcome = () => {
  if (!official.ok) throw new Error(JSON.stringify(official.error));
  return official;
};
const reportOf = (id: string) => outcome().reports.find((report) => report.adapter.id === id)!;

describe("official adapters: the exact, truthful conformance table", () => {
  it("native Tool, MCP, native model, and Vercel AI SDK pass every scenario their manifest claims; the rest are reported as declared", () => {
    expect(outcome().passed).toBe(true);
    expect(Object.fromEntries(outcome().reports.map((report) => [`${report.adapter.id}@${report.adapter.version}`, statuses(report)]))).toEqual({
      "aao.native-tool@1.0.0": { "tool.success-structured-result": "PASSED", "tool.unauthorized-blocked": "PASSED", "tool.unsupported-permission-blocked": "PASSED", "tool.failure-normalized": "PASSED", "tool.transient-retry": "PASSED", "tool.unsafe-default-no-retry": "PASSED", "tool.discovery-metadata-non-authoritative": "UNSUPPORTED" },
      "aao.mcp-connector@1.0.0": { "tool.success-structured-result": "PASSED", "tool.unauthorized-blocked": "PASSED", "tool.unsupported-permission-blocked": "PASSED", "tool.failure-normalized": "PASSED", "tool.transient-retry": "PASSED", "tool.unsafe-default-no-retry": "PASSED", "tool.discovery-metadata-non-authoritative": "PASSED" },
      "aao.native-model@1.0.0": { "model.structured-output": "PASSED", "model.identity-and-usage": "PASSED", "model.provider-error-normalized": "PASSED", "model.tool-call-fail-closed": "UNSUPPORTED", "model.attempt-timeout": "PASSED", "model.cancellation-propagated": "PASSED" },
      "aao.vercel-ai-sdk@1.0.0": { "model.structured-output": "PASSED", "model.identity-and-usage": "PASSED", "model.provider-error-normalized": "PASSED", "model.tool-call-fail-closed": "PASSED", "model.attempt-timeout": "PASSED", "model.cancellation-propagated": "PASSED" },
    });
    for (const report of outcome().reports) {
      expect(report.conformanceVersion).toBe(1);
      expect(report.adapter.adapterContractVersion).toBe(1);
      expect(validateAdapterConformanceReportIntegrity(JSON.parse(JSON.stringify(report))).ok, report.adapter.id).toBe(true);
    }
    const rendered = renderConformance(outcome(), "text");
    expect(rendered.exitCode).toBe(0);
    expect(rendered.output).toContain("UNSUPPORTED    model.tool-call-fail-closed");
    expect(rendered.output).toContain("Deferred: langgraph (agent_runtime): not an implemented adapter");
  });

  it("MCP is a tool_provider and nothing else; LangGraph is deferred, never an UNSUPPORTED adapter", () => {
    expect(reportOf("aao.mcp-connector").adapter.kind).toBe("tool_provider");
    expect(outcome().reports.some((report) => /langgraph/i.test(report.adapter.id))).toBe(false);
    expect(outcome().matrix.deferred).toEqual([expect.objectContaining({ id: "langgraph", kind: "agent_runtime", status: "DEFERRED" })]);
  });

  it("conformance reuses the Evaluation Runtime: every suite definition resolves to a registered deterministic grader", () => {
    const evaluator = createEvaluatorRegistry(deterministicGraders());
    for (const definition of ADAPTER_CONFORMANCE_SUITE.definitions) expect(evaluator.resolve(definition.graderRef).ok, definition.id).toBe(true);
  });
});

describe("portability: same semantic verdict across substrates, not byte-equal evidence", () => {
  it("native Tool vs MCP and native model vs Vercel AI SDK reach identical verdicts on every shared case", () => {
    const tools = outcome().portability.find((entry) => entry.kind === "tool_provider")!;
    expect(tools).toMatchObject({ reference: "aao.native-tool", consistent: true });
    expect(tools.cases).toHaveLength(16);
    const models = outcome().portability.find((entry) => entry.kind === "model")!;
    expect(models).toMatchObject({ reference: "aao.native-model", consistent: true });
    expect(models.cases).toHaveLength(9);
  });
});

describe("MCP: host-owned retry safety and non-authoritative remote metadata", () => {
  const run = async (id: string) => {
    const subject = createMcpConformanceSubject();
    let remoteCalls = -1;
    const observing: ToolProviderConformanceSubject = {
      manifest: subject.manifest,
      sensitiveMarkers: subject.sensitiveMarkers,
      async prepare(target, host) {
        const prepared = await subject.prepare(target, host);
        return { tool: prepared.tool, dispose: async () => { remoteCalls = prepared.observations().remoteCalls; await prepared.dispose(); } };
      },
    };
    const execution = await createConformanceDriver(observing).executeScenario(scenario(id));
    return { trace: execution.evidence.trace as unknown as Trace, execution: execution.evidence.execution as unknown as { run: { status: string } }, audit: execution.evidence.audit as unknown as Array<{ type: string }>, remoteCalls, serialized: JSON.stringify(execution), markers: subject.sensitiveMarkers };
  };

  it("host-declared retry-safe read: one bounded retry, one logical execution, two physical calls, canonical Trace", async () => {
    const result = await run("tool.transient-retry");
    expect(result.remoteCalls).toBe(2);
    expect(result.execution.run.status).toBe("COMPLETED");
    expect(result.trace.filter((event) => event.type === "retry.scheduled")).toHaveLength(1);
    expect(result.trace.filter((event) => event.type === "tool.call.started")).toHaveLength(2);
  }, SUBPROCESS_BUDGET_MS);

  it("the same server Tool without a host declaration: no retry (unsafe default)", async () => {
    const result = await run("tool.unsafe-default-no-retry");
    expect(result.remoteCalls).toBe(1);
    expect(result.execution.run.status).toBe("FAILED");
    expect(result.trace.some((event) => event.type === "retry.scheduled")).toBe(false);
  }, SUBPROCESS_BUDGET_MS);

  it("server advertises safeToRetry / idempotent / readOnly / authority while the host says unsafe: unsafe wins, no retry, host permission stands", async () => {
    const result = await run("tool.discovery-metadata-non-authoritative");
    expect(result.remoteCalls).toBe(1);
    expect(result.trace.some((event) => event.type === "retry.scheduled")).toBe(false);
    expect(result.trace.find((event) => event.type === "tool.call.started")!.payload.permissionClasses).toEqual(["read_only"]);
    for (const marker of result.markers) expect(result.serialized).not.toContain(marker);
    expect(result.serialized).not.toMatch(/structuredContent|isError|annotations|_meta|stdio|principal":"admin|approved":true/);
  }, SUBPROCESS_BUDGET_MS);

  it("unauthorized and unsupported-class calls never reach the server", async () => {
    const unauthorized = await run("tool.unauthorized-blocked");
    expect(unauthorized.remoteCalls).toBe(0);
    expect(unauthorized.trace.find((event) => event.type === "tool.call.blocked")!.payload).toMatchObject({ code: "TOOL_AUTHORIZATION_DENIED" });
    expect(unauthorized.audit.map((event) => event.type)).toContain("tool.access.denied");
    expect((await run("tool.unsupported-permission-blocked")).remoteCalls).toBe(0);
  }, SUBPROCESS_BUDGET_MS);
});

describe("model adapters: cancellation reaches the provider boundary and a late result never commits", () => {
  it("Vercel AI SDK: the Runtime attempt timeout aborts the signal, the provider observes it, the Run fails with canonical timeout semantics, and no result commits", async () => {
    const subject = createVercelAiConformanceSubject();
    let observations: { providerCalls: number; cancellationObserved: boolean } | undefined;
    const observing: ModelConformanceSubject = {
      manifest: subject.manifest,
      prepare(target) {
        const prepared = subject.prepare(target);
        return { adapter: prepared.adapter, observations: () => (observations = prepared.observations()) };
      },
    };
    const execution = await createConformanceDriver(observing).executeScenario(scenario("model.cancellation-propagated"));
    expect(observations).toEqual({ providerCalls: 1, cancellationObserved: true });
    expect(execution.boundary).toEqual({ cancellationObserved: true });
    const evidence = execution.evidence as unknown as { trace: Trace; execution: { run: { status: string }; state: { values: Record<string, unknown> } } };
    expect(evidence.trace.find((event) => event.type === "node.failed")!.payload).toMatchObject({ code: "NODE_ATTEMPT_TIMEOUT", category: "TIMEOUT" });
    expect(evidence.execution.run.status).toBe("FAILED");
    expect(evidence.execution.state.values.modelResult).toBeUndefined();
  });
});

describe("truthfulness: claims are verified, never trusted", () => {
  const ignoringSignal = (): ModelConformanceSubject => {
    const reference = nativeModelReference();
    return {
      // Claims cancellation, but its provider ignores the signal entirely.
      manifest: defineAdapterManifest({ ...reference.manifest, id: "test.ignores-signal" }),
      prepare(target) {
        const prepared = reference.prepare(target);
        if ((target.parameters as { outcome: string }).outcome !== "blocks_until_cancelled") return prepared;
        return { adapter: { invoke: () => new Promise(() => {}) }, observations: () => ({ cancellationObserved: false }) };
      },
    };
  };

  it("a false model.cancellation claim (the adapter ignores AbortSignal) is FAILED, not downgraded to UNSUPPORTED", async () => {
    const report = await verifyAdapterConformance({ subject: ignoringSignal() });
    expect(statuses(report)["model.cancellation-propagated"]).toBe("FAILED");
    expect(report.findings).toContainEqual({ code: "ADAPTER_BOUNDARY_UNOBSERVED", scenarioId: "model.cancellation-propagated" });
    expect(adapterConformancePassed(report)).toBe(false);
  });

  it("a conservative under-claim is allowed: model.cancellation declared unsupported is UNSUPPORTED and conformance infers nothing", async () => {
    const reference = nativeModelReference();
    const manifest = defineAdapterManifest({ ...reference.manifest, id: "test.underclaims", capabilities: reference.manifest.capabilities.map((entry) => (entry.capability === "model.cancellation" ? { ...entry, support: "unsupported" as const } : entry)) });
    const report = await verifyAdapterConformance({ subject: { ...reference, manifest } });
    expect(statuses(report)["model.cancellation-propagated"]).toBe("UNSUPPORTED");
    expect(adapterConformancePassed(report)).toBe(true);
  });

  it("a false tool.retryable_failure claim (the handler never reports retryable) fails the transient-retry scenario", async () => {
    const reference = nativeToolReference();
    const overclaiming: ToolProviderConformanceSubject = {
      manifest: defineAdapterManifest({ ...reference.manifest, id: "test.never-retryable" }),
      async prepare(target, host) {
        const prepared = await reference.prepare(target, host);
        const execute = prepared.tool.handler.execute;
        return { ...prepared, tool: { ...prepared.tool, handler: { execute: async (context) => { const result = await execute(context); return result.ok ? result : { ok: false, code: result.code }; } } } };
      },
    };
    const report = await verifyAdapterConformance({ subject: overclaiming });
    expect(statuses(report)["tool.transient-retry"]).toBe("FAILED");
    expect(report.findings).toContainEqual({ code: "ADAPTER_CONFORMANCE_FAILED", scenarioId: "tool.transient-retry", caseId: "tool.transient.retried-once.001" });
  });

  it("a subject that tries to widen its own retry safety is caught by the unsafe-default scenario", async () => {
    const reference = nativeToolReference();
    const widening: ToolProviderConformanceSubject = { manifest: defineAdapterManifest({ ...reference.manifest, id: "test.widens-safety" }), prepare: async (target, host) => reference.prepare(target, { ...host, retrySafety: "safe" }) };
    const report = await verifyAdapterConformance({ subject: widening });
    expect(statuses(report)["tool.unsafe-default-no-retry"]).toBe("FAILED");
  });

  it("a wrong-kind scenario is NOT_APPLICABLE, never support", async () => {
    const report = await verifyAdapterConformance({ subject: nativeToolReference(), scenarios: [scenario("model.structured-output"), scenario("tool.success-structured-result")] });
    expect(statuses(report)).toEqual({ "model.structured-output": "NOT_APPLICABLE", "tool.success-structured-result": "PASSED" });
    expect(report.summary).toEqual({ total: 2, passed: 1, failed: 0, unsupported: 0, notApplicable: 1 });
  });

  it("a throwing subject fails every running scenario (ADAPTER_DRIVER_ERROR) without leaking; leaked provider content fails (ADAPTER_EVIDENCE_LEAK)", async () => {
    const reference = nativeToolReference();
    const throwing: ToolProviderConformanceSubject = { manifest: defineAdapterManifest({ ...reference.manifest, id: "test.throwing" }), prepare: async () => { throw new Error("substrate exploded with secret-123"); } };
    const thrown = await verifyAdapterConformance({ subject: throwing });
    expect(thrown.summary).toMatchObject({ failed: 6, unsupported: 1 });
    expect(thrown.findings.filter((finding) => finding.code !== "ADAPTER_SCENARIO_UNSUPPORTED").every((finding) => finding.code === "ADAPTER_DRIVER_ERROR")).toBe(true);
    expect(JSON.stringify(thrown)).not.toContain("secret-123");
    const leaky: ToolProviderConformanceSubject = { ...reference, manifest: defineAdapterManifest({ ...reference.manifest, id: "test.leaky" }), sensitiveMarkers: ["Local Test Account"] };
    const leaked = await verifyAdapterConformance({ subject: leaky });
    expect(leaked.findings).toContainEqual({ code: "ADAPTER_EVIDENCE_LEAK", scenarioId: "tool.success-structured-result" });
    expect(statuses(leaked)["tool.success-structured-result"]).toBe("FAILED");
  });

  it("an invalid manifest is refused before any scenario runs", async () => {
    const reference = nativeToolReference();
    await expect(verifyAdapterConformance({ subject: { ...reference, manifest: { ...reference.manifest, adapterContractVersion: 2 } as never } })).rejects.toBeInstanceOf(AdapterConformanceError);
    await expect(verifyAdapterConformance({ subject: { ...reference, manifest: { ...reference.manifest, permissions: ["destructive"] } as never } })).rejects.toThrow(/ADAPTER_MANIFEST_INVALID/);
  });

  it("a caller cannot add a scenario: only canonical scenarios have suite cases", async () => {
    const invented: AdapterConformanceScenario = { ...scenario("tool.success-structured-result"), id: "tool.invented" };
    await expect(verifyAdapterConformance({ subject: nativeToolReference(), scenarios: [invented] })).rejects.toThrow(/ADAPTER_CONFORMANCE_SUITE_INVALID/);
  });
});

describe("generated compatibility matrix", () => {
  it("is generated from manifests plus fresh conformance reports and matches the committed artifacts exactly", async () => {
    const json = await runAdaptersMatrix({ format: "json" });
    expect(json.exitCode).toBe(0);
    expect(json.output).toBe(readFileSync(join(repositoryRoot, "docs", "generated", "adapter-compatibility.json"), "utf8"));
    expect(renderMatrixMarkdown(outcome().matrix)).toBe(readFileSync(join(repositoryRoot, "docs", "framework", "adapter-compatibility.md"), "utf8"));
  }, SUBPROCESS_BUDGET_MS);

  it("every conformance cell agrees with the report it came from, and the matrix grants nothing", () => {
    const matrix = outcome().matrix;
    expect(matrix.authority).toBe("none");
    for (const adapter of matrix.adapters) {
      const report = reportOf(adapter.id);
      expect(adapter.reportFingerprint).toBe(report.fingerprint);
      for (const row of adapter.capabilities) {
        const ran = row.scenarios.map((id) => report.scenarios.find((entry) => entry.scenarioId === id)!.status).filter((status) => status === "PASSED" || status === "FAILED");
        const expected = row.declared === "unsupported" ? "UNSUPPORTED" : ran.length > 0 && ran.every((status) => status === "PASSED") ? "PASSED" : "FAILED";
        expect(row.conformance, `${adapter.id} ${row.capability}`).toBe(expected);
      }
    }
    // No field of the matrix can carry authority: no permission, identity, role, grant, or approval keys anywhere.
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        if (!Array.isArray(value)) keys.add(key);
        walk(nested);
      }
    };
    walk(matrix);
    for (const key of keys) expect(key).not.toMatch(/permission|principal|role$|grant|approv|identity|enabled/i);
  });
});

describe("conformance evidence is private, deterministic, and offline", () => {
  it("reports, matrix, and CLI output carry identifiers, statuses, codes, and fingerprints only", () => {
    const serialized = JSON.stringify([outcome(), renderConformance(outcome(), "json").output, renderMatrixMarkdown(outcome().matrix)]);
    for (const forbidden of ["Local Test Account", "Conformance answer", "Classify: quarterly", "secret-token", "sk-live", "sk-native", "api.example.com", "native-provider-secret", "bypass authorization", "structuredContent", "toolName", "safeToRetry", "a-1\""]) expect(serialized, forbidden).not.toContain(forbidden);
  });

  it("a second run produces deep-equal reports and matrix, with no network access", async () => {
    const guard = installNetworkGuard();
    try {
      expect(await runAdapterConformance()).toEqual(official);
      expect(guard.attempts()).toEqual([]);
    } finally {
      guard.uninstall();
    }
  }, SUBPROCESS_BUDGET_MS);
});
