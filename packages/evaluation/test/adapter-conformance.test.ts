import { beforeAll, describe, expect, it } from "vitest";
import {
  ADAPTER_VERIFICATION_SCENARIOS,
  AdapterConformanceReportSchema,
  AdapterVerificationError,
  compareAdapterConformance,
  createEvaluatorRegistry,
  deterministicGraders,
  evidenceFingerprint,
  verifyAdapter,
  type AdapterConformanceReport,
  type AdapterVerificationDriver,
} from "../src/index.js";
import { renderConformance, runAdapterConformance } from "../cli/eval-adapters.mjs";
import { installNetworkGuard } from "../cli/network-guard.mjs";
import { mcpDriver, nativeToolDriver, vercelAiDriver } from "./support/drivers.js";
import { loadConformanceDataset, loadConformanceDefinitions, registry } from "./support/evals.js";

/**
 * Sprint 18 adapter verification: each substrate's own test driver
 * produces canonical AAO evidence and the existing Evaluation Runtime
 * judges it. Kinds stay distinct, support may be partial, and an
 * unsupported capability is never reported as a pass.
 */
const scenario = (id: string) => ADAPTER_VERIFICATION_SCENARIOS.find((entry) => entry.id === id)!;
const verify = (driver: AdapterVerificationDriver) => verifyAdapter({ driver, dataset: loadConformanceDataset(), definitions: loadConformanceDefinitions(), registry: registry() });
const statuses = (report: AdapterConformanceReport) => Object.fromEntries(report.scenarios.map((entry) => [entry.scenarioId, entry.status]));
type Trace = Array<{ type: string; payload: Record<string, unknown> }>;

/**
 * Measured (Sprint 18): one full conformance pass spawns a real MCP stdio
 * server child process per MCP scenario and loads the AI SDK — ≈1.1 s warm
 * and ≈5.3 s cold in isolation, more under full-suite CPU contention. The
 * pass therefore runs once (beforeAll) and is shared; only the tests that
 * genuinely spawn MCP processes get this scoped budget. No global timeout
 * changes.
 */
const SUBPROCESS_BUDGET_MS = 30_000;
let conformance: Awaited<ReturnType<typeof runAdapterConformance>>;
beforeAll(async () => {
  conformance = await runAdapterConformance();
}, SUBPROCESS_BUDGET_MS);
const reports = () => {
  if (!conformance.ok) throw new Error(JSON.stringify(conformance.error));
  return conformance.reports;
};
const reportOf = (id: string) => reports().find((report) => report.adapter.id === id)!;

describe("adapter inventory: the exact, truthful support matrix", () => {
  it("native Tool, MCP, native model, and Vercel AI SDK pass every scenario they declare SUPPORTED; the rest are reported as declared", () => {
    const outcome = conformance;
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    expect(outcome.passed).toBe(true);
    expect(Object.fromEntries(outcome.reports.map((report) => [report.adapter.id, statuses(report)]))).toEqual({
      "aao.native-tool": { "tool.success-structured-result": "PASSED", "tool.unauthorized-blocked": "PASSED", "tool.unsupported-permission-blocked": "PASSED", "tool.failure-normalized": "PASSED", "tool.transient-retry": "PASSED" },
      "aao.mcp-connector": { "tool.success-structured-result": "PASSED", "tool.unauthorized-blocked": "PASSED", "tool.unsupported-permission-blocked": "PASSED", "tool.failure-normalized": "PASSED", "tool.transient-retry": "UNSUPPORTED" },
      "aao.native-model": { "model.structured-output": "PASSED", "model.identity-and-usage": "PASSED", "model.provider-error-normalized": "PASSED", "model.tool-call-fail-closed": "NOT_APPLICABLE", "model.attempt-timeout": "PASSED" },
      "aao.vercel-ai-sdk": { "model.structured-output": "PASSED", "model.identity-and-usage": "PASSED", "model.provider-error-normalized": "PASSED", "model.tool-call-fail-closed": "PASSED", "model.attempt-timeout": "PASSED" },
    });
    const mcp = outcome.reports.find((report) => report.adapter.id === "aao.mcp-connector")!;
    expect(mcp).toMatchObject({ scenariosTotal: 5, supported: 4, passed: 4, failed: 0, unsupported: 1, notApplicable: 0, findings: [{ code: "ADAPTER_SCENARIO_UNSUPPORTED", scenarioId: "tool.transient-retry" }] });
    // Kinds stay distinct: a Tool adapter is never judged on model scenarios, and vice versa.
    for (const report of outcome.reports) expect(report.scenarios.every((entry) => scenario(entry.scenarioId).kind === report.adapter.kind)).toBe(true);
    for (const report of outcome.reports) expect(AdapterConformanceReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
    const rendered = renderConformance(outcome, "text");
    expect(rendered.exitCode).toBe(0);
    expect(rendered.output).toContain("UNSUPPORTED    tool.transient-retry");
    expect(renderConformance(outcome, "json").output).not.toContain("\u001b[");
  });

  it("conformance reuses the Evaluation Runtime: every conformance definition resolves to a registered deterministic grader", () => {
    const evaluator = createEvaluatorRegistry(deterministicGraders());
    for (const definition of loadConformanceDefinitions()) expect(evaluator.resolve(definition.graderRef).ok, definition.id).toBe(true);
    expect(loadConformanceDataset().cases.every((evalCase) => evalCase.mode === "RUNTIME" && evalCase.evidenceFingerprint === undefined && evalCase.evidenceRef.startsWith("scenario://"))).toBe(true);
    expect(loadConformanceDataset().cases.length).toBeGreaterThanOrEqual(10);
    expect(loadConformanceDataset().cases.length).toBeLessThanOrEqual(20);
  });
});

describe("portability: same semantic verdict across substrates, not byte-equal evidence", () => {
  it("native Tool vs MCP and native model vs Vercel AI SDK: equal comparison keys and semantic verdict fingerprints on every shared case", () => {
    const [nativeTool, mcp, nativeModel, vercel] = ["aao.native-tool", "aao.mcp-connector", "aao.native-model", "aao.vercel-ai-sdk"].map(reportOf) as [AdapterConformanceReport, AdapterConformanceReport, AdapterConformanceReport, AdapterConformanceReport];
    const tools = compareAdapterConformance({ reference: nativeTool, candidates: [mcp] });
    expect(tools.consistent).toBe(true);
    expect(tools.cases.map((entry) => entry.caseId).sort()).toEqual(["tool.failure.normalized.001", "tool.failure.run-failed.001", "tool.success.invoked-once.001", "tool.success.result-mapped.001", "tool.success.run-completed.001", "tool.success.trace-valid.001", "tool.unauthorized.blocked.001", "tool.unauthorized.denial-audited.001", "tool.unsupported-permission.never-invoked.001", "tool.unsupported-permission.preflight-refused.001"]);
    const models = compareAdapterConformance({ reference: nativeModel, candidates: [vercel] });
    expect(models.consistent).toBe(true);
    expect(models.cases).toHaveLength(7);
    // Mismatched kinds are never compared.
    expect(compareAdapterConformance({ reference: nativeTool, candidates: [vercel] }).cases).toEqual([]);
  });

  it("the same Tool-use scenario: native and MCP evidence fingerprints differ while their verdicts agree", async () => {
    const native = await nativeToolDriver().executeScenario(scenario("tool.success-structured-result"));
    const mcp = await mcpDriver().executeScenario(scenario("tool.success-structured-result"));
    expect(evidenceFingerprint(native)).not.toBe(evidenceFingerprint(mcp));
    const started = (trace: unknown) => (trace as Trace).find((event) => event.type === "tool.call.started")!.payload;
    expect(started(mcp.trace)).toMatchObject({ toolRef: { id: "crm.account.read", version: "1.0.0" }, permissionClasses: ["read_only"] });
    expect(started(native.trace)).toMatchObject({ toolRef: started(mcp.trace).toolRef, permissionClasses: started(mcp.trace).permissionClasses });
  }, SUBPROCESS_BUDGET_MS);

  it("a divergent semantic verdict is reported, never averaged away", () => {
    const nativeTool = reportOf("aao.native-tool");
    const diverged = structuredClone(nativeTool);
    diverged.adapter.id = "test.diverging";
    diverged.scenarios[0]!.cases[0]!.semanticVerdictFingerprint = `evs.${"0".repeat(64)}`;
    expect(compareAdapterConformance({ reference: nativeTool, candidates: [diverged] })).toMatchObject({ consistent: false, findings: [{ code: "ADAPTER_SEMANTIC_DIVERGENCE", adapterId: "test.diverging", caseId: diverged.scenarios[0]!.cases[0]!.caseId }] });
  });
});

describe("MCP security conformance", () => {
  it("hostile remote metadata grants nothing: the host-owned permission stays canonical, unauthorized and unsupported calls never reach the server", async () => {
    const driver = mcpDriver();
    const success = await driver.executeScenario(scenario("tool.success-structured-result"));
    expect(driver.serverCalls("tool.success-structured-result")).toBe(1);
    expect((success.trace as Trace).find((event) => event.type === "tool.call.started")!.payload.permissionClasses).toEqual(["read_only"]);

    const unauthorized = await driver.executeScenario(scenario("tool.unauthorized-blocked"));
    expect(driver.serverCalls("tool.unauthorized-blocked")).toBe(0);
    const blocked = (unauthorized.trace as Trace).find((event) => event.type === "tool.call.blocked")!;
    expect(blocked.payload).toMatchObject({ code: "TOOL_AUTHORIZATION_DENIED", access: { decision: "deny", reasonCode: "PERMISSION_NOT_GRANTED" } });
    expect((unauthorized.trace as Trace).some((event) => event.type === "tool.call.started")).toBe(false);
    expect((unauthorized.audit as Array<{ type: string }>).map((event) => event.type)).toContain("tool.access.denied");

    await driver.executeScenario(scenario("tool.unsupported-permission-blocked"));
    expect(driver.serverCalls("tool.unsupported-permission-blocked")).toBe(0);

    const failure = await driver.executeScenario(scenario("tool.failure-normalized"));
    expect(driver.serverCalls("tool.failure-normalized")).toBe(1);
    const serialized = JSON.stringify([success, unauthorized, failure]);
    for (const marker of driver.sensitiveMarkers) expect(serialized).not.toContain(marker);
    expect(serialized).not.toMatch(/structuredContent|isError|annotations|stdio/);
  }, SUBPROCESS_BUDGET_MS);
});

describe("model adapter conformance", () => {
  it("Vercel AI SDK: structured output, trusted identity, and usage map canonically; a provider error is one normalized failure with no raw leakage", async () => {
    const driver = vercelAiDriver();
    const structured = await driver.executeScenario(scenario("model.structured-output"));
    expect((structured.execution as { state: { values: Record<string, unknown> } }).state.values.modelResult).toMatchObject({ outputKind: "structured", output: { category: "research" }, modelBindingId: "conformance.binding", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
    const completed = (structured.trace as Trace).find((event) => event.type === "model.call.completed")!;
    expect(completed.payload).toMatchObject({ modelIdentity: { provider: "conformance-provider", model: "conformance-model" }, usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });

    const failed = await driver.executeScenario(scenario("model.provider-error-normalized"));
    expect(driver.providerCalls("model.provider-error-normalized")).toBe(1);
    expect((failed.trace as Trace).find((event) => event.type === "model.call.failed")!.payload).toMatchObject({ code: "MODEL_INVOCATION_FAILED", adapterReason: "provider_error" });
    for (const marker of driver.sensitiveMarkers) expect(JSON.stringify(failed)).not.toContain(marker);

    const toolCall = await driver.executeScenario(scenario("model.tool-call-fail-closed"));
    expect((toolCall.trace as Trace).find((event) => event.type === "model.call.failed")!.payload).toMatchObject({ code: "INVALID_MODEL_RESULT", adapterReason: "unsupported_response" });
    const timeout = await driver.executeScenario(scenario("model.attempt-timeout"));
    expect((timeout.trace as Trace).find((event) => event.type === "node.failed")!.payload).toMatchObject({ code: "NODE_ATTEMPT_TIMEOUT", category: "TIMEOUT" });
  });
});

describe("truthfulness of support declarations", () => {
  it("a false SUPPORTED claim is caught by the evidence: MCP declared retry-capable fails the transient-retry scenario", async () => {
    const honest = mcpDriver();
    const overclaiming = { ...honest, id: "test.mcp-overclaiming", support: { ...honest.support, "tool.transient-retry": "SUPPORTED" as const }, executeScenario: honest.executeScenario, serverCalls: honest.serverCalls } as AdapterVerificationDriver;
    const report = await verify(overclaiming);
    expect(statuses(report)["tool.transient-retry"]).toBe("FAILED");
    expect(report.findings).toContainEqual({ code: "ADAPTER_CONFORMANCE_FAILED", scenarioId: "tool.transient-retry", caseId: "tool.transient.retried-once.001" });
  }, SUBPROCESS_BUDGET_MS);

  it("declarations must cover exactly the driver's kind, and SUPPORTED needs verifiable cases", async () => {
    const native = nativeToolDriver();
    await expect(verify({ ...native, support: { "tool.success-structured-result": "SUPPORTED" } } as AdapterVerificationDriver)).rejects.toBeInstanceOf(AdapterVerificationError);
    await expect(verify({ ...native, support: { ...native.support, "model.structured-output": "SUPPORTED" } } as AdapterVerificationDriver)).rejects.toThrow("ADAPTER_DECLARATION_INVALID");
    const dataset = loadConformanceDataset();
    const withoutTransient = { ...dataset, cases: dataset.cases.filter((evalCase) => !evalCase.evidenceRef.endsWith("tool.transient-retry")) };
    await expect(verifyAdapter({ driver: native, dataset: withoutTransient, definitions: loadConformanceDefinitions(), registry: registry() })).rejects.toThrow("ADAPTER_DECLARATION_INVALID");
  });

  it("a throwing driver fails its scenario (ADAPTER_DRIVER_ERROR); leaked provider content fails it (ADAPTER_EVIDENCE_LEAK)", async () => {
    const native = nativeToolDriver();
    const throwing = { ...native, id: "test.throwing", executeScenario: async () => { throw new Error("substrate exploded with secret-123"); } } as AdapterVerificationDriver;
    const thrown = await verify(throwing);
    expect(thrown.failed).toBe(5);
    expect(thrown.findings.every((finding) => finding.code === "ADAPTER_DRIVER_ERROR")).toBe(true);
    expect(JSON.stringify(thrown)).not.toContain("secret-123");
    const leaky = { ...native, id: "test.leaky", sensitiveMarkers: ["Local Test Account"], executeScenario: native.executeScenario } as AdapterVerificationDriver;
    const leaked = await verify(leaky);
    expect(leaked.findings).toContainEqual({ code: "ADAPTER_EVIDENCE_LEAK", scenarioId: "tool.success-structured-result" });
    expect(statuses(leaked)["tool.success-structured-result"]).toBe("FAILED");
  });
});

describe("conformance reports are private, deterministic, and offline", () => {
  it("reports carry identifiers, statuses, codes, and fingerprints only — no raw provider, MCP, Tool, or model content", () => {
    const serialized = JSON.stringify(conformance);
    for (const forbidden of ["Local Test Account", "Conformance answer", "Classify: quarterly", "secret-token", "sk-live", "sk-native", "api.example.com", "native-provider-secret", "bypass authorization", "structuredContent", "toolName", "a-1\""]) expect(serialized, forbidden).not.toContain(forbidden);
  });

  it("a second run produces deep-equal conformance reports, with no network access", async () => {
    const guard = installNetworkGuard();
    try {
      expect(await runAdapterConformance()).toEqual(conformance);
      expect(guard.attempts()).toEqual([]);
    } finally {
      guard.uninstall();
    }
  }, SUBPROCESS_BUDGET_MS);
});
