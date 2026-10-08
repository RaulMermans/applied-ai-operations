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
const VENDOR_SDKS = /@opentelemetry|langfuse|arize|phoenix|datadog|dd-trace|newrelic|honeycomb|sentry|winston|pino|bunyan|elastic|loki/i;

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

  it("only the file store touches the filesystem", () => {
    const fsUsers = sourceFiles("observability").filter((file) => imports(file).some((spec) => spec === "node:fs"));
    expect(fsUsers.map((file) => file.split("/").pop())).toEqual(["file-store.ts"]);
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

  it("observability implements no metrics, audit, eval, or UI surface", () => {
    const names = sourceFiles("observability").map((file) => file.split("/").pop());
    expect(names.sort()).toEqual(["content-policy.ts", "file-store.ts", "identity.ts", "index.ts", "recorder.ts", "store.ts", "validator.ts"]);
    for (const file of sourceFiles("observability")) expect(code(file)).not.toMatch(/\b(?:histogram|counter|gauge|percentile|auditLog|evaluat(?:e|or)|dashboard|estimatedCost|pricing)\b/i);
  });
});
