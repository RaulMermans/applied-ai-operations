import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR-020 boundary regressions. Trace is one-directional: authoritative
 * packages may *emit* through an injected port, but none of them imports
 * the observability implementation or reads Trace data, and observability
 * depends on nothing but the canonical contracts.
 */
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(pkg: string): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
  return walk(join(packagesDir, pkg, "src"));
}

function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function imports(file: string): string[] {
  return [...code(file).matchAll(/^\s*(?:import|export)[^;\n]*\sfrom\s+["']([^"']+)["']/gm)].map((match) => match[1]!);
}

const EXECUTION_PACKAGES = ["runtime", "tool-runtime", "model-runtime", "agent-runtime", "approval", "durability", "governance", "authorization", "mcp-connector", "workflow-dsl", "contracts"];
const VENDOR_SDKS = /@opentelemetry|langfuse|arize|phoenix|datadog|dd-trace|newrelic|honeycomb|sentry|winston|pino|bunyan|elastic|loki|prom-client|prometheus|statsd|hot-shots|grafana|splunk|sumologic|chronicle|siem|auditlog-|immudb|qldb/i;

describe("observability dependency direction", () => {
  it("@aao/observability depends only on @aao/contracts and zod in production", () => {
    const manifest = JSON.parse(readFileSync(join(packagesDir, "observability", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@aao/contracts", "zod"]);
    const allowed = new Set(["@aao/contracts", "zod", "node:crypto", "node:fs", "node:path"]);
    for (const file of sourceFiles("observability")) for (const specifier of imports(file).filter((spec) => !spec.startsWith("."))) expect(allowed.has(specifier), `${file} imports ${specifier}`).toBe(true);
  });

  it("observability never imports Durability, Runtime, or any execution package", () => {
    for (const file of sourceFiles("observability")) expect(imports(file).filter((spec) => spec.startsWith("@aao/") && spec !== "@aao/contracts")).toEqual([]);
  });

  it("only the two local file stores (and their shared atomic-write helper) touch the filesystem", () => {
    const fsUsers = sourceFiles("observability").filter((file) => imports(file).some((spec) => spec === "node:fs"));
    expect(fsUsers.map((file) => file.split("/observability/src/")[1]).sort()).toEqual(["audit/file-store.ts", "file-store.ts", "local-files.ts"]);
  });

  it.each(EXECUTION_PACKAGES)("@aao/%s does not depend on or import @aao/observability", (pkg) => {
    const manifest = JSON.parse(readFileSync(join(packagesDir, pkg, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@aao/observability");
    for (const file of sourceFiles(pkg)) expect(imports(file)).not.toContain("@aao/observability");
  });
});

describe("Trace is never read by an execution decision", () => {
  it.each(EXECUTION_PACKAGES)("@aao/%s never reads Trace data (no store queries, no trace reconstruction)", (pkg) => {
    for (const file of sourceFiles(pkg)) {
      const source = code(file);
      expect(source, file).not.toMatch(/\b(?:getRunTrace|getEvent|getLastSequence|reconstructRunTrace|validateTrace|compareTraceWithExecution|TraceStore|createTraceRecorder|runHealth)\b|\.health\(\)/);
    }
  });

  it("the Runtime trace port is emit-only", () => {
    const types = code(join(packagesDir, "runtime", "src", "types.ts"));
    const port = /export interface RuntimeTracePort \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? "";
    expect(port.trim()).toBe("emit(draft: TraceEventDraft): Promise<void>;");
    const context = /export interface NodeTraceContext \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? "";
    expect([...context.matchAll(/^\s*(?:readonly\s+)?(\w+)[?(:]/gm)].map((match) => match[1])).toEqual(["span", "recoveryReplay", "emit"]);
  });

  it("recovery planning depends only on the checkpoint and operation ledger", () => {
    const recovery = code(join(packagesDir, "durability", "src", "recovery.ts"));
    expect(recovery).not.toMatch(/trace/i);
    const host = code(join(packagesDir, "durability", "src", "host.ts"));
    // The host computes the recovery plan before it emits anything, and never awaits a trace result into a decision.
    expect(host.indexOf("const recovery = planRecovery(")).toBeLessThan(host.indexOf('type: "recovery.started"'));
    expect(host).not.toMatch(/=\s*await\s+(?:trace|emit)\b/);
  });

  it("DurabilityStore has no trace storage", () => {
    const store = code(join(packagesDir, "durability", "src", "store.ts"));
    expect(store).not.toMatch(/trace/i);
  });
});

describe("no vendor observability or logging framework", () => {
  it.each(["observability", ...EXECUTION_PACKAGES])("@aao/%s has no vendor tracing, OpenTelemetry SDK, or logging library", (pkg) => {
    const manifest = readFileSync(join(packagesDir, pkg, "package.json"), "utf8");
    expect(manifest).not.toMatch(VENDOR_SDKS);
    for (const file of sourceFiles(pkg)) for (const specifier of imports(file)) expect(specifier).not.toMatch(VENDOR_SDKS);
  });

  it("observability implements Trace, Metrics, and Audit only — no Eval Runtime, alerting, dashboard, or UI surface", () => {
    const names = sourceFiles("observability").map((file) => file.split("/observability/src/")[1]);
    expect(names.sort()).toEqual([
      "audit/event.ts", "audit/file-store.ts", "audit/recorder.ts", "audit/store.ts", "audit/validator.ts",
      "content-policy.ts", "file-store.ts", "health.ts", "identity.ts", "index.ts", "local-files.ts",
      "metrics/aggregate.ts", "metrics/percentile.ts", "metrics/pricing.ts", "metrics/run-metrics.ts",
      "recorder.ts", "store.ts", "validator.ts",
    ]);
    for (const file of sourceFiles("observability")) expect(code(file)).not.toMatch(/\b(?:histogram|gauge|evaluat(?:e|or)|grader|rubric|judge|dataset|dashboard|alert(?:ing)?|threshold|pagerduty|slack|webhook|render|chart)\b/i);
    const manifest = readFileSync(join(packagesDir, "observability", "package.json"), "utf8");
    expect(manifest).not.toMatch(/react|vue|svelte|chart|d3|grafana|express|fastify/i);
  });
});

describe("Metrics are pure Trace projections (ADR-021)", () => {
  const metricsFiles = () => sourceFiles("observability").filter((file) => file.includes("/src/metrics/"));

  it("Metrics consume only Trace evidence and explicit pricing: no Audit, store, recorder, or filesystem import", () => {
    for (const file of metricsFiles()) {
      for (const specifier of imports(file).filter((spec) => spec.startsWith("."))) expect(["../validator.js", "../content-policy.js", "./pricing.js", "./percentile.js"], `${file} imports ${specifier}`).toContain(specifier);
      expect(imports(file).filter((spec) => spec.startsWith("node:"))).toEqual([]);
    }
  });

  it("Metrics have no clock, randomness, I/O, or mutable store", () => {
    for (const file of metricsFiles()) expect(code(file), file).not.toMatch(/Date\.now|new Date\(|Math\.random|randomUUID|fetch\(|process\.env|MetricsStore|append\(/);
  });

  it("no execution package derives, aggregates, or reads Metrics (only @aao/contracts defines their schemas)", () => {
    for (const pkg of EXECUTION_PACKAGES.filter((name) => name !== "contracts")) for (const file of sourceFiles(pkg)) expect(code(file), file).not.toMatch(/\b(?:deriveRunMetrics|aggregateRunMetrics|RunMetrics|AggregateMetrics|ModelPricingProfile)\b/);
  });
});

describe("Audit is one-way accountability evidence (ADR-021)", () => {
  const AUDIT_PRODUCERS = ["approval", "tool-runtime", "durability"];

  it("Audit modules are separate from Trace storage and Metrics", () => {
    for (const file of sourceFiles("observability").filter((candidate) => candidate.includes("/src/audit/"))) {
      for (const specifier of imports(file).filter((spec) => spec.startsWith("."))) expect(["../content-policy.js", "../local-files.js", "./event.js", "./store.js", "./validator.js"], `${file} imports ${specifier}`).toContain(specifier);
    }
  });

  it("the Audit port is emit-only", () => {
    const contracts = code(join(packagesDir, "contracts", "src", "audit.ts"));
    const port = /export interface AuditPort \{([\s\S]*?)\n\}/.exec(contracts)?.[1] ?? "";
    expect(port.trim()).toBe("emit(draft: AuditEventDraft): void | Promise<void>;");
  });

  it.each(EXECUTION_PACKAGES)("@aao/%s never reads Audit (no stream reads, verification, recorder, or store)", (pkg) => {
    for (const file of sourceFiles(pkg)) expect(code(file), file).not.toMatch(/\b(?:getStream|verifyStream|validateAuditStream|checkAuditCompleteness|AuditStore|createAuditRecorder|createFileAuditStore|createInMemoryAuditStore|streamHealth)\b/);
  });

  it("only the authoritative boundaries emit Audit, and only through the contracts port", () => {
    const emitters = EXECUTION_PACKAGES.filter((pkg) => sourceFiles(pkg).some((file) => /emitAuditSafely\(/.test(code(file)) && !file.includes("/contracts/")));
    expect(emitters.sort()).toEqual([...AUDIT_PRODUCERS].sort());
    for (const pkg of ["runtime", "governance", "authorization", "model-runtime", "agent-runtime", "mcp-connector", "workflow-dsl"]) for (const file of sourceFiles(pkg)) expect(code(file), file).not.toMatch(/\bAuditPort\b|emitAuditSafely/);
  });

  it("DurabilityStore and TraceStore have no audit storage; AuditStore has no Trace reconstruction", () => {
    expect(code(join(packagesDir, "durability", "src", "store.ts"))).not.toMatch(/audit/i);
    expect(code(join(packagesDir, "observability", "src", "store.ts"))).not.toMatch(/audit/i);
    const auditStore = /export interface AuditStore \{([\s\S]*?)\n\}/.exec(code(join(packagesDir, "observability", "src", "audit", "store.ts")))?.[1] ?? "";
    expect([...auditStore.matchAll(/^\s*(\w+)\(/gm)].map((match) => match[1])).toEqual(["append", "getStream", "getEvent", "verifyStream"]);
  });

  it("recovery planning never reads Audit", () => {
    expect(code(join(packagesDir, "durability", "src", "recovery.ts"))).not.toMatch(/audit/i);
  });
});

describe("Sprint 16 does not widen execution", () => {
  it("external_side_effect, destructive, and sensitive_data remain unsupported by the Tool Runtime", () => {
    const permissions = code(join(packagesDir, "tool-runtime", "src", "permissions.ts"));
    const supported = /SUPPORTED_TOOL_PERMISSION_CLASSES[^=]*=\s*([^;]+);/.exec(permissions)?.[1] ?? "";
    expect(supported).toMatch(/read_only/);
    expect(supported).toMatch(/write_draft/);
    expect(supported).not.toMatch(/external_side_effect|destructive|sensitive_data/);
  });

  it("no Eval Runtime or UI package was introduced", () => {
    const packages = readdirSync(packagesDir).sort();
    expect(packages.filter((name) => /eval|metrics|audit|analytics|dashboard|ui|control-center/i.test(name))).toEqual([]);
  });
});
