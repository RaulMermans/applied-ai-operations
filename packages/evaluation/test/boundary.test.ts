import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES, TRACE_EVENT_TYPES } from "@aao/contracts";

/**
 * ADR-022 boundary regressions. Evaluation observes execution; execution
 * never depends on Evaluation. The evaluation core imports no framework,
 * provider SDK, MCP, substrate, or eval vendor, loads no code dynamically,
 * touches no filesystem or network, and has no path into any authority.
 */
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceFiles = (pkg: string): string[] => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
  return walk(join(packagesDir, pkg, "src"));
};
const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const imports = (file: string) => [...code(file).matchAll(/^\s*(?:import|export)[^;\n]*\sfrom\s+["']([^"']+)["']/gm)].map((match) => match[1]!);
const manifest = (pkg: string) => JSON.parse(readFileSync(join(packagesDir, pkg, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const EXECUTION_PACKAGES = ["runtime", "tool-runtime", "model-runtime", "agent-runtime", "approval", "durability", "governance", "authorization", "mcp-connector", "workflow-dsl", "contracts", "observability"];
const FORBIDDEN_SPECIFIERS = /langgraph|@langchain|^ai$|@ai-sdk|@modelcontextprotocol|@aao\/mcp-connector|@aao\/substrate-|openai|@anthropic-ai|langfuse|phoenix|arize|promptfoo|deepeval|ragas|braintrust|@aao\/(?:runtime|approval|authorization|governance|tool-runtime|durability|model-runtime|agent-runtime|workflow-dsl|config)$/;

describe("@aao/evaluation dependency direction", () => {
  it("production dependencies are exactly contracts, observability (canonical validators), yaml, and zod", () => {
    expect(Object.keys(manifest("evaluation").dependencies ?? {}).sort()).toEqual(["@aao/contracts", "@aao/observability", "yaml", "zod"]);
  });

  it("imports no framework, provider SDK, MCP, substrate, eval vendor, or execution package", () => {
    const allowed = new Set(["@aao/contracts", "@aao/observability", "yaml", "zod", "node:crypto"]);
    for (const file of sourceFiles("evaluation")) {
      for (const specifier of imports(file).filter((spec) => !spec.startsWith("."))) {
        expect(allowed.has(specifier), `${file} imports ${specifier}`).toBe(true);
        expect(specifier).not.toMatch(FORBIDDEN_SPECIFIERS);
      }
    }
  });

  it("no dynamic import, require, eval, Function constructor, filesystem, process, or network access", () => {
    for (const file of sourceFiles("evaluation")) expect(code(file), file).not.toMatch(/\bimport\(|\brequire\(|\beval\(|new Function\b|node:fs|node:child_process|node:net|node:http|\bfetch\(|process\.env|readFile|writeFile/);
  });

  it.each(EXECUTION_PACKAGES)("@aao/%s neither depends on nor imports @aao/evaluation", (pkg) => {
    const m = manifest(pkg);
    expect(Object.keys({ ...m.dependencies, ...m.devDependencies })).not.toContain("@aao/evaluation");
    for (const file of sourceFiles(pkg)) expect(imports(file)).not.toContain("@aao/evaluation");
  });
});

describe("Evaluation is not inside the Runtime and never becomes execution authority", () => {
  it("the Runtime has no eval hook: RuntimeOptions and the engine know nothing of evaluation", () => {
    const types = code(join(packagesDir, "runtime", "src", "types.ts"));
    const options = /export interface RuntimeOptions \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? "";
    expect(options).not.toBe("");
    expect(options).not.toMatch(/eval|grader|judge/i);
    for (const file of sourceFiles("runtime")) expect(code(file), file).not.toMatch(/\bEval(?:Definition|Result|uation)\b|\bevaluate\(|grader|judge/);
  });

  it("evaluation source has no path to approve, authorize, execute Tools, run or resume workflows, cancel, retry, or recover", () => {
    for (const file of sourceFiles("evaluation")) {
      expect(code(file), file).not.toMatch(/\b(?:executeTool|authorize|resolveAuthority|approve|reject|requestApproval|continueApprovedWorkflow|continueWaitingWorkflow|executeWorkflow|resumeWorkflow|requestCancellation|createDurableRuntimeHost|planRecovery|recoverySafety|retrySafety|ReliabilityPolicy|SUPPORTED_TOOL_PERMISSION_CLASSES|statePatch|applyStatePatch|transitionRunRecord|emitAuditSafely|AuditPort|RuntimeTracePort|createTraceRecorder|createAuditRecorder)\b/);
    }
  });

  it("evaluation never writes Trace, Audit, or Metrics: no eval events exist in either catalog", () => {
    expect(TRACE_EVENT_TYPES.filter((type) => /eval|judge|grade/.test(type))).toEqual([]);
    expect(AUDIT_EVENT_TYPES.filter((type) => /eval|judge|grade/.test(type))).toEqual([]);
    for (const file of sourceFiles("evaluation")) expect(code(file), file).not.toMatch(/\.append\(|\.emit\(|deriveRunMetrics|aggregateRunMetrics/);
  });

  it("Sprint 18 adds pure analytics, a deterministic gate, and a verification harness — no store, database, dashboard, auto-promotion, Reflexion loop, Memory, or Skill runtime", () => {
    const names = sourceFiles("evaluation").map((file) => file.split("/evaluation/src/")[1]).sort();
    expect(names).toEqual([
      "analytics/baseline.ts", "analytics/comparison.ts", "analytics/expectation.ts", "analytics/fingerprints.ts", "analytics/integrity.ts", "analytics/multi-run.ts", "analytics/regression.ts", "analytics/suite-summary.ts",
      "conformance/adapter-verification.ts", "conformance/scenarios.ts",
      "dataset.ts", "evidence.ts",
      "gates/evaluate-gate.ts", "gates/format-report.ts", "gates/policy.ts",
      "grader.ts",
      "graders/approval-compliance.ts", "graders/audit-view.ts", "graders/authorization-compliance.ts", "graders/index.ts", "graders/metrics-threshold.ts", "graders/model-call.ts", "graders/model-judge.ts", "graders/retry-behavior.ts", "graders/run-outcome.ts", "graders/state-assertion.ts", "graders/tool-usage.ts", "graders/trace-contract.ts", "graders/trajectory.ts",
      "index.ts", "registry.ts", "runner.ts", "trace-view.ts",
    ]);
    for (const file of sourceFiles("evaluation")) expect(code(file), file).not.toMatch(/EvalStore|ResultStore|evalDatabase|sqlite|postgres|warehouse|dashboard|express|fastify|createServer|trendline|createRegression|promoteFinding|updateBaseline|acceptAll|writeBaseline|reflexion|revise|promoteMemory|memoryStore|SkillRuntime|skillRegistry|defineAdapter|AdapterManifest|CapabilityMatrix|createAAO|defineWorkflow|defineAgent|defineTool/i);
  });

  it("the model judge is never part of the CI gate or adapter verification", () => {
    for (const file of sourceFiles("evaluation").filter((path) => /\/(analytics|gates|conformance)\//.test(path))) expect(code(file), file).not.toMatch(/model-judge|createModelJudgeGrader|ModelJudgePort/);
  });

  it("side-effect permission classes remain unsupported by the Tool Runtime", () => {
    const permissions = code(join(packagesDir, "tool-runtime", "src", "permissions.ts"));
    const supported = /SUPPORTED_TOOL_PERMISSION_CLASSES[^=]*=\s*([^;]+);/.exec(permissions)?.[1] ?? "";
    expect(supported).not.toMatch(/external_side_effect|destructive|sensitive_data/);
  });
});
