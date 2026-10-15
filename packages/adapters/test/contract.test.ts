import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AAO_ADAPTER_CONFORMANCE_VERSION,
  AAO_ADAPTER_CONTRACT_VERSION,
  ADAPTER_CAPABILITY_CATALOG,
  ADAPTER_CONFORMANCE_SCENARIOS,
  ADAPTER_CONFORMANCE_SUITE,
  ADAPTER_KINDS,
  AdapterContractError,
  adapterConformancePassed,
  adapterManifestFingerprint,
  buildAdapterCompatibilityMatrix,
  buildAdapterConformanceReport,
  checkAdapterCompatibility,
  conformanceScenarioEvidenceRef,
  defineAdapterManifest,
  scenarioClaim,
  validateAdapterConformanceReportIntegrity,
  validateAdapterManifest,
  validateCompleteAdapterConformanceReport,
  type AdapterConformanceReport,
  type AdapterConformanceReportInput,
  type AdapterManifest,
  type ConformanceCase,
  type ConformanceFinding,
} from "../src/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));

const modelInput = () => ({
  id: "test.model-adapter",
  version: "1.0.0",
  kind: "model" as const,
  capabilities: [
    { capability: "model.text_generation" as const, support: "supported" as const },
    { capability: "model.structured_output" as const, support: "supported" as const },
    { capability: "model.usage" as const, support: "supported" as const },
    { capability: "model.cancellation" as const, support: "unsupported" as const },
    { capability: "model.tool_call_response" as const, support: "unsupported" as const },
  ],
});
const toolInput = () => ({
  id: "test.tool-provider",
  version: "2.1.0",
  kind: "tool_provider" as const,
  capabilities: [
    { capability: "tool.execution" as const, support: "supported" as const },
    { capability: "tool.discovery" as const, support: "supported" as const },
    { capability: "tool.retryable_failure" as const, support: "unsupported" as const },
  ],
  limitations: [{ code: "transport.stdio_only" }],
});

describe("contract versions and taxonomy", () => {
  it("adapter contract v1 and conformance v1, distinct from every other version", () => {
    expect(AAO_ADAPTER_CONTRACT_VERSION).toBe(1);
    expect(AAO_ADAPTER_CONFORMANCE_VERSION).toBe(1);
  });

  it("three explicit kinds with distinct catalogs; agent_runtime has no capability until an implementation exists", () => {
    expect(ADAPTER_KINDS).toEqual(["model", "tool_provider", "agent_runtime"]);
    expect(ADAPTER_CAPABILITY_CATALOG.agent_runtime).toEqual([]);
    expect(ADAPTER_CAPABILITY_CATALOG.model.every((capability) => capability.startsWith("model."))).toBe(true);
    expect(ADAPTER_CAPABILITY_CATALOG.tool_provider.every((capability) => capability.startsWith("tool."))).toBe(true);
  });

  it("capability names are AAO semantics, never provider or protocol constructs", () => {
    const all = [...ADAPTER_CAPABILITY_CATALOG.model, ...ADAPTER_CAPABILITY_CATALOG.tool_provider].join(" ");
    expect(all).not.toMatch(/vercel|generateObject|generateText|mcp|listTools|callTool|langgraph|interrupt|openai|anthropic|ollama/i);
  });

  it("every catalog capability is verified by at least one canonical scenario, and every scenario names its kind's capabilities only", () => {
    for (const kind of ["model", "tool_provider"] as const) {
      for (const capability of ADAPTER_CAPABILITY_CATALOG[kind]) expect(ADAPTER_CONFORMANCE_SCENARIOS.some((scenario) => scenario.kind === kind && scenario.requires.includes(capability)), capability).toBe(true);
    }
    for (const scenario of ADAPTER_CONFORMANCE_SCENARIOS) for (const capability of scenario.requires) expect((ADAPTER_CAPABILITY_CATALOG[scenario.kind] as readonly string[]).includes(capability), scenario.id).toBe(true);
  });

  it("the suite is plain canonical data: one case per scenario at least, every evidence ref a scenario, RUNTIME only, no fixture pins, no vendor names", () => {
    const { dataset, definitions } = ADAPTER_CONFORMANCE_SUITE;
    expect(ADAPTER_CONFORMANCE_SUITE.conformanceVersion).toBe(1);
    for (const scenario of ADAPTER_CONFORMANCE_SCENARIOS) expect(dataset.cases.some((evalCase) => evalCase.evidenceRef === conformanceScenarioEvidenceRef(scenario.id)), scenario.id).toBe(true);
    expect(dataset.cases.every((evalCase) => evalCase.mode === "RUNTIME" && evalCase.evidenceFingerprint === undefined && evalCase.evidenceRef.startsWith("scenario://"))).toBe(true);
    const ids = new Set(definitions.map((definition) => definition.id));
    expect(dataset.cases.every((evalCase) => ids.has(evalCase.evalRef.id))).toBe(true);
    expect(JSON.stringify(ADAPTER_CONFORMANCE_SUITE)).not.toMatch(/vercel|\bmcp\b|langgraph|openai|ai-sdk/i);
    expect(Object.isFrozen(ADAPTER_CONFORMANCE_SUITE.dataset.cases)).toBe(true);
  });
});

describe("AdapterManifest V1", () => {
  it("defines a canonical, deep-frozen, detached copy; caller mutation afterwards changes nothing", () => {
    const input = toolInput();
    const manifest = defineAdapterManifest(input);
    expect(manifest).toMatchObject({ schemaVersion: 1, adapterContractVersion: 1, id: "test.tool-provider", version: "2.1.0", kind: "tool_provider" });
    // Canonical catalog order, whatever the input order.
    expect(manifest.capabilities.map((entry) => entry.capability)).toEqual(["tool.discovery", "tool.execution", "tool.retryable_failure"]);
    input.capabilities[0]!.support = "unsupported";
    input.id = "mutated";
    expect(manifest.id).toBe("test.tool-provider");
    expect(manifest.capabilities.find((entry) => entry.capability === "tool.execution")!.support).toBe("supported");
    expect(Object.isFrozen(manifest) && Object.isFrozen(manifest.capabilities) && Object.isFrozen(manifest.capabilities[0])).toBe(true);
  });

  it("round-trips: schema → stringify → parse → schema", () => {
    const manifest = defineAdapterManifest(modelInput());
    const reparsed = validateAdapterManifest(JSON.parse(JSON.stringify(manifest)));
    expect(reparsed).toEqual({ ok: true, manifest: JSON.parse(JSON.stringify(manifest)) });
  });

  it.each([
    ["an unknown field", { ...modelInput(), extra: true }],
    ["a permission grant", { ...modelInput(), permissions: ["destructive"] }],
    ["credentials", { ...modelInput(), apiKey: "sk-live-123" }],
    ["a module path", { ...modelInput(), module: "./my-adapter.js" }],
    ["a dynamic import entry", { ...modelInput(), entry: "import('x')" }],
    ["an identity claim", { ...modelInput(), principal: { id: "admin", type: "user" } }],
    ["a role or approval claim", { ...modelInput(), role: "owner", approved: true }],
    ["a retry-safety claim", { ...modelInput(), retrySafety: "safe" }],
    ["a recovery-safety claim", { ...modelInput(), recoverySafe: true, idempotency: "execution_id" }],
    ["a side-effect support claim", { ...modelInput(), supportedPermissionClasses: ["external_side_effect"] }],
    ["a capability outside the catalog", { ...modelInput(), capabilities: [...modelInput().capabilities, { capability: "vercel.generateObject", support: "supported" }] }],
    ["a capability of another kind", { ...modelInput(), capabilities: [...modelInput().capabilities, { capability: "tool.execution", support: "supported" }] }],
    ["a duplicate capability", { ...modelInput(), capabilities: [...modelInput().capabilities, { capability: "model.usage", support: "supported" }] }],
    ["an incomplete declaration", { ...modelInput(), capabilities: modelInput().capabilities.slice(1) }],
    ["a support value other than supported/unsupported", { ...modelInput(), capabilities: modelInput().capabilities.map((entry) => ({ ...entry, support: "partial" })) }],
    ["a non-exact version", { ...modelInput(), version: "^1.0.0" }],
    ["a latest version", { ...modelInput(), version: "latest" }],
    ["an unknown kind", { ...modelInput(), kind: "workflow_runtime" }],
    ["a capability with free-form semantics", { ...modelInput(), capabilities: modelInput().capabilities.map((entry) => ({ ...entry, note: "trust me" })) }],
  ])("rejects %s (ADAPTER_MANIFEST_INVALID)", (_label, input) => {
    expect(() => defineAdapterManifest(input as never)).toThrow(AdapterContractError);
    expect(validateAdapterManifest({ schemaVersion: 1, adapterContractVersion: 1, ...input })).toMatchObject({ ok: false, code: "ADAPTER_MANIFEST_INVALID" });
  });

  it("rejects functions, class instances, and accessors before copying (nothing executable can be silently dropped)", () => {
    expect(validateAdapterManifest({ ...defineAdapterManifest(modelInput()), invoke: () => undefined })).toMatchObject({ ok: false, code: "ADAPTER_MANIFEST_INVALID" });
    expect(validateAdapterManifest({ ...defineAdapterManifest(modelInput()), createdAt: new Date(0) })).toMatchObject({ ok: false, code: "ADAPTER_MANIFEST_INVALID" });
    const accessor = { ...defineAdapterManifest(modelInput()) };
    Object.defineProperty(accessor, "id", { get: () => "x", enumerable: true });
    expect(validateAdapterManifest(accessor)).toMatchObject({ ok: false, code: "ADAPTER_MANIFEST_INVALID" });
  });

  it("an unsupported contract version fails as ADAPTER_CONTRACT_VERSION_UNSUPPORTED, with no compatibility guessing", () => {
    for (const version of [0, 2, "1", null]) {
      expect(validateAdapterManifest({ schemaVersion: 1, ...modelInput(), adapterContractVersion: version })).toMatchObject({ ok: false, code: "ADAPTER_CONTRACT_VERSION_UNSUPPORTED" });
    }
    expect(() => defineAdapterManifest({ ...modelInput(), adapterContractVersion: 2 })).toThrow(/ADAPTER_CONTRACT_VERSION_UNSUPPORTED/);
  });

  it("the fingerprint is manifest identity: deterministic, order-independent, and changed by any semantic field", () => {
    const a = defineAdapterManifest(modelInput());
    const b = defineAdapterManifest({ ...modelInput(), capabilities: [...modelInput().capabilities].reverse() });
    expect(adapterManifestFingerprint(a)).toBe(adapterManifestFingerprint(b));
    expect(adapterManifestFingerprint(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(adapterManifestFingerprint(defineAdapterManifest({ ...modelInput(), version: "1.0.1" }))).not.toBe(adapterManifestFingerprint(a));
  });
});

describe("checkAdapterCompatibility: deterministic registration-time capability negotiation, not authorization", () => {
  const manifest = defineAdapterManifest(modelInput());
  it("exact required capabilities → compatible", () => {
    expect(checkAdapterCompatibility({ manifest, requirements: { kind: "model", requiredCapabilities: ["model.text_generation", "model.structured_output"] } })).toEqual({ compatible: true, missingCapabilities: [], mismatches: [] });
  });
  it("a capability declared unsupported → missing", () => {
    expect(checkAdapterCompatibility({ manifest, requirements: { kind: "model", requiredCapabilities: ["model.cancellation", "model.text_generation"] } })).toEqual({ compatible: false, missingCapabilities: ["model.cancellation"], mismatches: ["ADAPTER_CAPABILITY_UNSUPPORTED"] });
  });
  it("wrong kind", () => {
    expect(checkAdapterCompatibility({ manifest, requirements: { kind: "tool_provider", requiredCapabilities: [] } }).mismatches).toEqual(["ADAPTER_KIND_MISMATCH"]);
  });
  it("wrong contract version", () => {
    expect(checkAdapterCompatibility({ manifest: { ...manifest, adapterContractVersion: 2 }, requirements: { kind: "model", requiredCapabilities: [] } })).toMatchObject({ compatible: false, mismatches: ["ADAPTER_CONTRACT_VERSION_UNSUPPORTED"] });
  });
  it("a different adapter version is incompatible: no implicit latest", () => {
    expect(checkAdapterCompatibility({ manifest, requirements: { kind: "model", requiredCapabilities: [], adapterRef: { id: "test.model-adapter", version: "2.0.0" } } }).mismatches).toEqual(["ADAPTER_NOT_FOUND"]);
    expect(checkAdapterCompatibility({ manifest, requirements: { kind: "model", requiredCapabilities: [], adapterRef: { id: "test.model-adapter", version: "1.0.0" } } }).compatible).toBe(true);
  });
  it("is pure and deterministic", () => {
    const params = { manifest, requirements: { kind: "model" as const, requiredCapabilities: ["model.usage" as const] } };
    expect(checkAdapterCompatibility(params)).toEqual(checkAdapterCompatibility(params));
  });
});

const matchedCase = (caseId: string, expectation: ConformanceCase["expectation"] = "MATCHED"): ConformanceCase => ({
  caseId,
  comparisonKey: `evk.${"a".repeat(64)}`,
  expected: { status: "passed" },
  actual: { status: expectation === "MATCHED" ? "passed" : "failed", reasonCodes: [] },
  expectation,
  semanticVerdictFingerprint: `evs.${"b".repeat(64)}`,
} as ConformanceCase);

const canonicalCaseIds = (scenarioId: string) => ADAPTER_CONFORMANCE_SUITE.dataset.cases.filter((evalCase) => evalCase.evidenceRef === conformanceScenarioEvidenceRef(scenarioId)).map((evalCase) => evalCase.id);
const canonicalDatasetRef = () => ({ id: ADAPTER_CONFORMANCE_SUITE.dataset.id, version: ADAPTER_CONFORMANCE_SUITE.dataset.version });

/** Builder input from a manifest and synthetic judged canonical cases: every canonical scenario of the kind, with manifest-derived claims. */
function reportInput(manifest: AdapterManifest, failing: readonly string[] = []): AdapterConformanceReportInput {
  const scenarios = ADAPTER_CONFORMANCE_SCENARIOS.filter((scenario) => scenario.kind === manifest.kind).map((scenario) => {
    const claim = scenarioClaim(manifest, scenario);
    const cases = claim === "supported" || claim === "base_invariant" ? canonicalCaseIds(scenario.id).map((caseId, index) => matchedCase(caseId, failing.includes(scenario.id) && index === 0 ? "MISMATCHED" : "MATCHED")) : [];
    return { scenarioId: scenario.id, requires: scenario.requires, claim, cases };
  });
  const findings = [
    ...scenarios.filter((scenario) => scenario.claim === "unsupported").map((scenario) => ({ code: "ADAPTER_SCENARIO_UNSUPPORTED" as const, scenarioId: scenario.scenarioId })),
    ...failing.map((scenarioId) => ({ code: "ADAPTER_CONFORMANCE_FAILED" as const, scenarioId, caseId: canonicalCaseIds(scenarioId)[0]! })),
  ];
  return { manifest, datasetRef: canonicalDatasetRef(), scenarios, findings };
}

/** A report built by the canonical builder: complete, intact, and for exactly this manifest. */
function reportFor(manifest: AdapterManifest, failing: readonly string[] = []): AdapterConformanceReport {
  return buildAdapterConformanceReport(reportInput(manifest, failing));
}

/** A forged report that is nonetheless internally consistent: the canonical builder re-derives status, summary, and fingerprint. */
type ForgeableInput = { scenarios: Array<{ scenarioId: string; requires: string[]; claim: AdapterConformanceReportInput["scenarios"][number]["claim"]; cases: ConformanceCase[] }>; findings: ConformanceFinding[]; datasetRef: { id: string; version: string } };
function resealed(manifest: AdapterManifest, forge: (input: ForgeableInput) => void): AdapterConformanceReport {
  const input = reportInput(manifest);
  const mutable: ForgeableInput = { scenarios: input.scenarios.map((scenario) => ({ ...scenario, requires: [...scenario.requires], cases: [...scenario.cases] })), findings: [...input.findings], datasetRef: { ...input.datasetRef } };
  forge(mutable);
  return buildAdapterConformanceReport({ manifest, ...mutable });
}

describe("conformance vocabulary and report integrity", () => {
  const tool = defineAdapterManifest(toolInput());

  it("claim + pass → PASSED; claim + failure → FAILED; unsupported → UNSUPPORTED; other kind → NOT_APPLICABLE", () => {
    const report = reportFor(tool, ["tool.failure-normalized"]);
    const status = Object.fromEntries(report.scenarios.map((scenario) => [scenario.scenarioId, scenario.status]));
    expect(status["tool.success-structured-result"]).toBe("PASSED");
    expect(status["tool.failure-normalized"]).toBe("FAILED");
    expect(status["tool.transient-retry"]).toBe("UNSUPPORTED");
    expect(scenarioClaim(tool, ADAPTER_CONFORMANCE_SCENARIOS.find((scenario) => scenario.kind === "model")!)).toBe("not_applicable");
    expect(report.summary).toEqual({ total: 7, passed: 5, failed: 1, unsupported: 1, notApplicable: 0 });
    expect(adapterConformancePassed(report, tool)).toBe(false);
  });

  it("base invariants run whatever the manifest declares, and there is no SUPPORTED outcome", () => {
    const base = ADAPTER_CONFORMANCE_SCENARIOS.filter((scenario) => scenario.kind === "tool_provider" && scenario.requires.length === 0);
    expect(base.map((scenario) => scenario.id)).toEqual(["tool.unauthorized-blocked", "tool.unsupported-permission-blocked"]);
    for (const scenario of base) expect(scenarioClaim(tool, scenario)).toBe("base_invariant");
    expect(JSON.stringify(reportFor(tool))).not.toContain('"SUPPORTED"');
  });

  it("an under-claim is truthful: a declared-unsupported capability is UNSUPPORTED, never inferred", () => {
    const model = defineAdapterManifest(modelInput());
    const cancellation = ADAPTER_CONFORMANCE_SCENARIOS.find((scenario) => scenario.id === "model.cancellation-propagated")!;
    expect(scenarioClaim(model, cancellation)).toBe("unsupported");
  });

  it("an intact report validates against its manifest and round-trips", () => {
    const report = reportFor(tool);
    expect(validateAdapterConformanceReportIntegrity(JSON.parse(JSON.stringify(report)), tool)).toEqual({ ok: true, report: JSON.parse(JSON.stringify(report)) });
    expect(adapterConformancePassed(report, tool)).toBe(true);
  });

  it("forged: a FAILED scenario with summary.failed = 0 is rejected", () => {
    const report = structuredClone(reportFor(tool, ["tool.failure-normalized"]));
    report.summary.failed = 0;
    report.summary.passed += 1;
    const integrity = validateAdapterConformanceReportIntegrity(report, tool);
    expect(integrity.ok).toBe(false);
    expect(adapterConformancePassed(report, tool)).toBe(false);
  });

  it.each([
    ["a FAILED scenario relabelled PASSED", (report: AdapterConformanceReport) => { report.scenarios.find((scenario) => scenario.status === "FAILED")!.status = "PASSED"; }],
    ["a mismatched case under a PASSED scenario", (report: AdapterConformanceReport) => { report.scenarios[0]!.cases[0]!.expectation = "MISMATCHED"; }],
    ["an UNSUPPORTED scenario relabelled PASSED", (report: AdapterConformanceReport) => { report.scenarios.find((scenario) => scenario.status === "UNSUPPORTED")!.status = "PASSED"; }],
    ["an edited fingerprint", (report: AdapterConformanceReport) => { report.fingerprint = "0".repeat(64); }],
    ["a dropped finding", (report: AdapterConformanceReport) => { report.findings = report.findings.filter((finding) => finding.code !== "ADAPTER_CONFORMANCE_FAILED"); }],
    ["a claimed version change", (report: AdapterConformanceReport) => { report.adapter.version = "9.9.9"; }],
  ])("forged: %s is rejected", (_label, forge) => {
    const report = structuredClone(reportFor(tool, ["tool.failure-normalized"])) as AdapterConformanceReport;
    forge(report);
    expect(validateAdapterConformanceReportIntegrity(report, tool).ok).toBe(false);
  });

  it("a report for another manifest is rejected", () => {
    const other = defineAdapterManifest({ ...toolInput(), version: "2.1.1" });
    expect(validateAdapterConformanceReportIntegrity(reportFor(tool), other).ok).toBe(false);
  });

  it("is deterministic: identical inputs give deep-equal reports with no timestamps", () => {
    expect(reportFor(tool)).toEqual(reportFor(tool));
    expect(JSON.stringify(reportFor(tool))).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("full conformance: report integrity is not complete AAO conformance", () => {
  const tool = defineAdapterManifest(toolInput());
  const model = defineAdapterManifest(modelInput());
  const cancellationSupported = defineAdapterManifest({ ...modelInput(), capabilities: modelInput().capabilities.map((entry) => (entry.capability === "model.cancellation" ? { ...entry, support: "supported" as const } : entry)) });
  const complete = (report: AdapterConformanceReport, manifest: AdapterManifest) => validateCompleteAdapterConformanceReport(JSON.parse(JSON.stringify(report)), manifest);
  const codes = (report: AdapterConformanceReport, manifest: AdapterManifest) => {
    const result = complete(report, manifest);
    return result.ok ? [] : result.codes;
  };

  it("a genuine complete report is intact, complete, and passes", () => {
    for (const manifest of [tool, model, cancellationSupported]) {
      const report = reportFor(manifest);
      expect(validateAdapterConformanceReportIntegrity(report, manifest).ok).toBe(true);
      expect(complete(report, manifest)).toEqual({ ok: true, report: JSON.parse(JSON.stringify(report)) });
      expect(adapterConformancePassed(report, manifest)).toBe(true);
    }
  });

  it("no vacuous truth: an empty report (0 scenarios) is intact with failed = 0, but incomplete and never a PASS", () => {
    for (const manifest of [tool, model]) {
      const empty = buildAdapterConformanceReport({ manifest, datasetRef: canonicalDatasetRef(), scenarios: [], findings: [] });
      expect(validateAdapterConformanceReportIntegrity(empty, manifest).ok).toBe(true);
      expect(empty.summary).toEqual({ total: 0, passed: 0, failed: 0, unsupported: 0, notApplicable: 0 });
      expect(codes(empty, manifest)).toEqual(["ADAPTER_CONFORMANCE_SCENARIO_MISSING"]);
      expect(adapterConformancePassed(empty, manifest)).toBe(false);
    }
  });

  it("a kind with no canonical scenario can never be complete", () => {
    const agent = defineAdapterManifest({ id: "test.agent-runtime", version: "1.0.0", kind: "agent_runtime", capabilities: [] });
    const empty = buildAdapterConformanceReport({ manifest: agent, datasetRef: canonicalDatasetRef(), scenarios: [], findings: [] });
    expect(codes(empty, agent)).toEqual(["ADAPTER_CONFORMANCE_INCOMPLETE"]);
    expect(adapterConformancePassed(empty, agent)).toBe(false);
  });

  it("a missing canonical scenario, resealed to be internally consistent, is intact but not complete", () => {
    const report = resealed(tool, (input) => {
      input.scenarios = input.scenarios.filter((scenario) => scenario.scenarioId !== "tool.unauthorized-blocked");
    });
    expect(validateAdapterConformanceReportIntegrity(report, tool).ok).toBe(true);
    expect(report.summary.failed).toBe(0);
    expect(codes(report, tool)).toEqual(["ADAPTER_CONFORMANCE_SCENARIO_MISSING"]);
    expect(adapterConformancePassed(report, tool)).toBe(false);
  });

  it("an extra scenario is never accepted as canonical evidence, whether invented or of another kind", () => {
    const invented = resealed(tool, (input) => {
      input.scenarios.push({ scenarioId: "fake.extra.scenario", requires: [], claim: "base_invariant", cases: [matchedCase("fake.extra.case")] });
    });
    expect(validateAdapterConformanceReportIntegrity(invented, tool).ok).toBe(true);
    expect(codes(invented, tool)).toEqual(["ADAPTER_CONFORMANCE_SCENARIO_UNEXPECTED"]);
    expect(adapterConformancePassed(invented, tool)).toBe(false);
    const otherKind = resealed(tool, (input) => {
      input.scenarios.push({ scenarioId: "model.structured-output", requires: ["model.structured_output"], claim: "not_applicable", cases: [] });
    });
    expect(validateAdapterConformanceReportIntegrity(otherKind, tool).ok).toBe(true);
    expect(codes(otherKind, tool)).toEqual(["ADAPTER_CONFORMANCE_SCENARIO_UNEXPECTED"]);
  });

  it("claim downgrade: model.cancellation declared supported cannot be reported unsupported to skip the test", () => {
    const report = resealed(cancellationSupported, (input) => {
      const entry = input.scenarios.find((scenario) => scenario.scenarioId === "model.cancellation-propagated")!;
      entry.claim = "unsupported";
      entry.cases = [];
      input.findings.push({ code: "ADAPTER_SCENARIO_UNSUPPORTED", scenarioId: entry.scenarioId });
    });
    expect(validateAdapterConformanceReportIntegrity(report, cancellationSupported).ok).toBe(true);
    expect(report.summary.failed).toBe(0);
    expect(codes(report, cancellationSupported)).toEqual(["ADAPTER_CONFORMANCE_CLAIM_MISMATCH"]);
    expect(adapterConformancePassed(report, cancellationSupported)).toBe(false);
  });

  it("claim upgrade: model.cancellation declared unsupported cannot be reported supported", () => {
    const report = resealed(model, (input) => {
      const entry = input.scenarios.find((scenario) => scenario.scenarioId === "model.cancellation-propagated")!;
      entry.claim = "supported";
      entry.cases = canonicalCaseIds(entry.scenarioId).map((caseId) => matchedCase(caseId));
      input.findings = input.findings.filter((finding) => finding.scenarioId !== entry.scenarioId);
    });
    expect(validateAdapterConformanceReportIntegrity(report, model).ok).toBe(true);
    expect(codes(report, model)).toEqual(["ADAPTER_CONFORMANCE_CLAIM_MISMATCH"]);
    expect(adapterConformancePassed(report, model)).toBe(false);
  });

  it.each([
    ["requires narrowed to drop a capability", (input: ForgeableInput) => {
      input.scenarios.find((scenario) => scenario.scenarioId === "tool.transient-retry")!.requires = ["tool.execution"];
    }],
    ["requires reordered", (input: ForgeableInput) => {
      input.scenarios.find((scenario) => scenario.scenarioId === "tool.transient-retry")!.requires = ["tool.retryable_failure", "tool.execution"];
    }],
    ["a canonical case dropped", (input: ForgeableInput) => {
      input.scenarios.find((scenario) => scenario.scenarioId === "tool.success-structured-result")!.cases.pop();
    }],
    ["a canonical case renamed", (input: ForgeableInput) => {
      const entry = input.scenarios.find((scenario) => scenario.scenarioId === "tool.success-structured-result")!;
      entry.cases[0] = matchedCase("tool.success.renamed.001");
    }],
    ["a case expectation rewritten", (input: ForgeableInput) => {
      const entry = input.scenarios.find((scenario) => scenario.scenarioId === "tool.success-structured-result")!;
      entry.cases[0] = { ...entry.cases[0]!, expected: { status: "failed", reasonCodes: ["RUN_STATUS_MISMATCH"] } } as ConformanceCase;
    }],
  ])("scenario contract mutation: %s is intact but not complete", (_label, forge) => {
    const report = resealed(tool, forge);
    expect(validateAdapterConformanceReportIntegrity(report, tool).ok).toBe(true);
    expect(codes(report, tool)).toContain("ADAPTER_CONFORMANCE_SCENARIO_MISMATCH");
    expect(adapterConformancePassed(report, tool)).toBe(false);
  });

  it.each([
    ["the right id with the wrong version", { id: "aao.adapter-conformance", version: "0.9.0" }],
    ["the right version with the wrong id", { id: "private.reduced-subset", version: "1.0.0" }],
  ])("dataset mismatch: %s is intact but not complete", (_label, datasetRef) => {
    const report = resealed(tool, (input) => {
      input.datasetRef = datasetRef;
    });
    expect(validateAdapterConformanceReportIntegrity(report, tool).ok).toBe(true);
    expect(codes(report, tool)).toEqual(["ADAPTER_CONFORMANCE_DATASET_MISMATCH"]);
    expect(adapterConformancePassed(report, tool)).toBe(false);
  });

  it("anti-self-attestation: summary.failed = 0 and summary.passed = N over incomplete evidence is refused", () => {
    const partial = resealed(tool, (input) => {
      input.scenarios = input.scenarios.slice(0, 1);
      input.findings = [];
    });
    const forged = structuredClone(partial) as AdapterConformanceReport;
    const full = reportFor(tool).summary;
    forged.summary = { ...full, failed: 0 };
    expect(complete(forged, tool)).toMatchObject({ ok: false, codes: ["ADAPTER_CONFORMANCE_REPORT_INVALID"] });
    expect(adapterConformancePassed(forged, tool)).toBe(false);
    // Even internally consistent, the same evidence is only partial.
    expect(codes(partial, tool)).toEqual(["ADAPTER_CONFORMANCE_SCENARIO_MISSING"]);
    expect(adapterConformancePassed(partial, tool)).toBe(false);
  });

  it("a report that verified nothing never passes, even when complete", () => {
    const nothing = defineAdapterManifest({ ...modelInput(), id: "test.claims-nothing", capabilities: modelInput().capabilities.map((entry) => ({ ...entry, support: "unsupported" as const })) });
    const report = reportFor(nothing);
    expect(complete(report, nothing).ok).toBe(true);
    expect(report.summary).toMatchObject({ passed: 0, failed: 0, unsupported: 6 });
    expect(adapterConformancePassed(report, nothing)).toBe(false);
  });

  it("the report fingerprint commits to scenario ids, claims, requires, cases, and the dataset", () => {
    const base = reportFor(tool).fingerprint;
    expect(reportFor(tool).fingerprint).toBe(base);
    expect(resealed(tool, (input) => { input.datasetRef = { ...input.datasetRef, version: "0.9.0" }; }).fingerprint).not.toBe(base);
    expect(resealed(tool, (input) => { input.scenarios.find((scenario) => scenario.scenarioId === "tool.transient-retry")!.requires = ["tool.execution"]; }).fingerprint).not.toBe(base);
    expect(resealed(tool, (input) => { input.scenarios.pop(); }).fingerprint).not.toBe(base);
  });
});

describe("compatibility matrix: generated from manifests plus complete reports, never authority", () => {
  const tool = defineAdapterManifest(toolInput());
  const model = defineAdapterManifest(modelInput());

  it("derives every conformance cell from scenario outcomes", () => {
    const matrix = buildAdapterCompatibilityMatrix({ entries: [{ manifest: model, report: reportFor(model), reference: false }, { manifest: tool, report: reportFor(tool, ["tool.failure-normalized"]), reference: false }], deferred: [{ id: "langgraph", kind: "agent_runtime", status: "DEFERRED", reason: "No adapter." }] });
    expect(matrix.authority).toBe("none");
    expect(matrix.adapters.map((adapter) => adapter.kind)).toEqual(["model", "tool_provider"]);
    const cells = (id: string) => Object.fromEntries(matrix.adapters.find((adapter) => adapter.id === id)!.capabilities.map((row) => [row.capability, `${row.declared}/${row.conformance}`]));
    expect(cells("test.tool-provider")).toEqual({ "tool.discovery": "supported/PASSED", "tool.execution": "supported/FAILED", "tool.retryable_failure": "unsupported/UNSUPPORTED" });
    expect(cells("test.model-adapter")).toEqual({ "model.text_generation": "supported/PASSED", "model.structured_output": "supported/PASSED", "model.usage": "supported/PASSED", "model.cancellation": "unsupported/UNSUPPORTED", "model.tool_call_response": "unsupported/UNSUPPORTED" });
    expect(matrix.adapters.find((adapter) => adapter.id === "test.tool-provider")!.conformance).toBe("FAILED");
    expect(matrix.deferred).toEqual([{ id: "langgraph", kind: "agent_runtime", status: "DEFERRED", reason: "No adapter." }]);
    expect(JSON.stringify(matrix)).not.toMatch(/"UNSUPPORTED","reason"|langgraph[^}]*UNSUPPORTED/);
  });

  it("refuses a forged report: no hand-typed green cells", () => {
    const forged = structuredClone(reportFor(tool, ["tool.failure-normalized"])) as AdapterConformanceReport;
    forged.scenarios.find((scenario) => scenario.status === "FAILED")!.status = "PASSED";
    expect(() => buildAdapterCompatibilityMatrix({ entries: [{ manifest: tool, report: forged, reference: false }] })).toThrow(/ADAPTER_CONFORMANCE_REPORT_INVALID/);
    expect(() => buildAdapterCompatibilityMatrix({ entries: [{ manifest: model, report: reportFor(tool), reference: false }] })).toThrow(/ADAPTER_CONFORMANCE_REPORT_INVALID/);
  });

  it("refuses partial or self-downgraded evidence: no green cell from an incomplete report", () => {
    const empty = buildAdapterConformanceReport({ manifest: tool, datasetRef: canonicalDatasetRef(), scenarios: [], findings: [] });
    expect(() => buildAdapterCompatibilityMatrix({ entries: [{ manifest: tool, report: empty, reference: false }] })).toThrow(/ADAPTER_CONFORMANCE_SCENARIO_MISSING/);
    const partial = resealed(tool, (input) => { input.scenarios = input.scenarios.filter((scenario) => scenario.scenarioId !== "tool.failure-normalized"); });
    expect(() => buildAdapterCompatibilityMatrix({ entries: [{ manifest: tool, report: partial, reference: false }] })).toThrow(/ADAPTER_CONFORMANCE_SCENARIO_MISSING/);
    const downgraded = resealed(tool, (input) => {
      const entry = input.scenarios.find((scenario) => scenario.scenarioId === "tool.failure-normalized")!;
      entry.claim = "unsupported";
      entry.cases = [];
    });
    expect(() => buildAdapterCompatibilityMatrix({ entries: [{ manifest: tool, report: downgraded, reference: false }] })).toThrow(/ADAPTER_CONFORMANCE_CLAIM_MISMATCH/);
    const otherDataset = resealed(tool, (input) => { input.datasetRef = { id: "private.reduced-subset", version: "1.0.0" }; });
    expect(() => buildAdapterCompatibilityMatrix({ entries: [{ manifest: tool, report: otherDataset, reference: false }] })).toThrow(/ADAPTER_CONFORMANCE_DATASET_MISMATCH/);
  });

  it("is deterministic and order-independent", () => {
    const a = buildAdapterCompatibilityMatrix({ entries: [{ manifest: tool, report: reportFor(tool), reference: false }, { manifest: model, report: reportFor(model), reference: true }] });
    const b = buildAdapterCompatibilityMatrix({ entries: [{ manifest: model, report: reportFor(model), reference: true }, { manifest: tool, report: reportFor(tool), reference: false }] });
    expect(a).toEqual(b);
  });
});

describe("@aao/adapters is vendor-free and authority-free", () => {
  it("depends only on @aao/contracts and zod, and imports nothing else", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>; exports: Record<string, unknown> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@aao/contracts", "zod"]);
    expect(Object.keys(manifest.exports)).toEqual(["."]);
    for (const file of sources(join(packageRoot, "src"))) {
      for (const [, specifier] of code(file).matchAll(/from\s+["']([^"']+)["']/g)) expect(["@aao/contracts", "zod", "node:crypto"].includes(specifier!) || specifier!.startsWith("."), `${file} imports ${specifier}`).toBe(true);
    }
  });

  it("has no discovery, dynamic import, environment, filesystem, network, global registry, or authority path", () => {
    for (const file of sources(join(packageRoot, "src"))) {
      expect(code(file), file).not.toMatch(/\bimport\(|\brequire\(|process\.env|node:fs|node:child_process|\bfetch\(|readdir|globalThis|authorize\(|resolveAuthority|approve\(|executeTool|executeWorkflow|marketplace/);
    }
  });
});
