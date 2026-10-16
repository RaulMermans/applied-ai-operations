import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as framework from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const srcRoot = join(packageRoot, "src");

const sourceFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => /\.(ts|mts|mjs|js)$/.test(file) && !file.endsWith(".d.ts")).map((file) => join(dir, file)) : []);
/** Code only: comments may name things the code must never import or call. */
const code = (file: string) => readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const frameworkSources = sourceFiles(srcRoot);
const indexSource = code(join(srcRoot, "index.ts"));

/**
 * THE public API snapshot (ADR-024, extended deliberately by ADR-025).
 * Everything exported from the @aao/framework root is intentional consumer
 * API: adding or removing a symbol must change this list deliberately, and
 * a breaking change needs an ADR or migration note. Sprint 20 adds only the
 * stable adapter-contract concepts (contract version, manifest definition,
 * compatibility, the ModelAdapter port and `defineModelAdapter`), model and
 * Agent registration types, the deterministic executor shape, and the
 * optional Trace port type. Concrete adapters stay in their own packages.
 */
const PUBLIC_VALUE_EXPORTS = [
  "AAOFrameworkError", "AAO_ADAPTER_CONTRACT_VERSION", "AAO_FRAMEWORK_API_VERSION", "AdapterContractError", "checkAdapterCompatibility", "createAAO", "defineAdapterManifest", "defineAgent", "defineEval", "defineGovernance", "defineModelAdapter", "defineModelPolicy", "defineTool", "defineWorkflow",
];
const PUBLIC_TYPE_EXPORTS = [
  "AAOApp", "AAOApprovals", "AAOClock", "AAOFrameworkDiagnostic", "AAOFrameworkErrorCode", "AAOOptions", "AdapterCapability", "AdapterCompatibilityResult", "AdapterConformanceReport", "AdapterKind", "AdapterManifest", "AdapterManifestInput", "AdapterRef",
  "AgentDefinition", "AgentSpec", "ApprovalRecord", "DeterministicExecutor", "DeterministicExecutorContext", "DeterministicExecutorResult", "EvalDefinition", "ExecuteWorkflowInput", "GovernanceConfiguration",
  "JsonObject", "JsonValue", "ModelAdapter", "ModelAdapterContext", "ModelAdapterDefinition", "ModelAdapterRequest", "ModelAdapterResult", "ModelBindingDefinition", "ModelPolicySpec", "ModelRequest", "ModelResult",
  "PermissionClass", "PrepareWorkflowOptions", "PreparedWorkflow", "Principal", "PrincipalForRun", "ReliabilityPolicy", "RetrySafety", "RunState", "RuntimeExecutionState", "RuntimeFailure", "RuntimeTracePort",
  "ToolDefinition", "ToolDefinitionInput", "ToolHandler", "ToolHandlerContext", "ToolHandlerResult", "ToolIdempotency", "ToolSpec", "Workflow", "WorkflowDiagnostic", "WorkflowExecutionResult",
];

/** Every name the root index exports, value or type, from its explicit export lists. */
function declaredExports(source: string): { values: string[]; types: string[] } {
  const values: string[] = [];
  const types: string[] = [];
  for (const match of source.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    for (const raw of match[2]!.split(",").map((entry) => entry.trim()).filter(Boolean)) {
      const isType = match[1] !== undefined || raw.startsWith("type ");
      const name = raw.replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      (isType ? types : values).push(name);
    }
  }
  return { values: values.sort(), types: types.sort() };
}

describe("public API snapshot", () => {
  it("the runtime root exports exactly the approved symbols", () => {
    expect(Object.keys(framework).sort()).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
  });

  it("the declared value and type exports are exactly the approved lists", () => {
    const declared = declaredExports(indexSource);
    expect(declared.values).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
    expect(declared.types).toEqual([...PUBLIC_TYPE_EXPORTS].sort());
  });

  it("AAO_FRAMEWORK_API_VERSION is 1", () => {
    expect(framework.AAO_FRAMEWORK_API_VERSION).toBe(1);
  });

  it("no `export *` anywhere in the framework: the façade is an allowlist, not a re-export of the monorepo", () => {
    for (const file of frameworkSources) expect(code(file), relative(packageRoot, file)).not.toMatch(/export\s+\*/);
  });

  it("no internal, Core-implementation, or adapter symbol leaks from the root", () => {
    const exported = new Set([...Object.keys(framework), ...declaredExports(indexSource).types]);
    const forbidden = [
      // Runtime / registry / compiler internals
      "resolveToolBinding", "executeTool", "createToolRegistry", "createToolNodeExecutor", "createNodeRegistry", "executeWorkflow", "continueWaitingWorkflow", "resumeWorkflow", "transitionRunRecord", "transitionNodeStatus", "compileWorkflow", "runPreflight",
      // Governance / Authorization / Approval internals
      "createGovernanceRegistry", "resolveAuthority", "authorize", "authorizationContextFromAuthority", "createApprovalEngine", "createApprovalNodeExecutor", "createInMemoryApprovalRepository", "ApprovalRepository", "continueApprovedWorkflow",
      // Durability / observability / evaluation internals
      "createDurableRuntimeHost", "createFileDurableStore", "createTraceRecorder", "createAuditRecorder", "evaluateEvalGate", "buildEvalSuiteReport", "EvalSuiteReport", "runGatePipeline",
      // Concrete adapters never come from the root (ADR-025): hosts import them from their own packages.
      "VercelAIAdapter", "MCPAdapter", "createVercelAiModelAdapter", "defineVercelAiModelAdapter", "VERCEL_AI_SDK_ADAPTER_MANIFEST", "createMcpSession", "createMcpToolBinding", "MCP_CONNECTOR_ADAPTER_MANIFEST", "registerLangGraph", "LangGraphAdapter",
      // No universal adapter, global registration, discovery, or loading.
      "Adapter", "defineAdapter", "registerAdapter", "registerModelAdapter", "registerMCPAdapter", "discoverAdapters", "loadAdapter", "AdapterRegistry",
      // Conformance and the matrix are the explicit "@aao/framework/conformance" subpath, and test subjects never leave it.
      "verifyAdapterConformance", "evaluateAdapterConformance", "createConformanceDriver", "nativeModelReference", "nativeToolReference", "buildAdapterCompatibilityMatrix", "AdapterVerificationDriver", "AdapterCapabilityMatrix", "ADAPTER_CONFORMANCE_SUITE", "SUPPORTED", "UNSUPPORTED",
    ];
    for (const name of forbidden) expect(exported.has(name), name).toBe(false);
  });
});

describe("dependency boundaries", () => {
  // @aao/toolbox (Sprint 21, ADR-026) is a Framework *consumer* above Core, not a Core package: it depends on
  // the public Framework root by design. Its own tests prove no Core package, app, or the Framework imports it.
  // @aao/integration-public-web (Sprint 22, ADR-027) is the Integration Fabric's first capability, likewise above Core.
  // @aao/integration-documents (Sprint 23, ADR-028) is the Integration Fabric's second capability, likewise above Core.
  const FRAMEWORK_CONSUMERS = ["toolbox", "integration-public-web", "integration-documents"];
  const corePackages = readdirSync(join(repositoryRoot, "packages")).filter((name) => name !== "framework" && !FRAMEWORK_CONSUMERS.includes(name) && existsSync(join(repositoryRoot, "packages", name, "package.json")));

  it("the Framework consumers inside packages/ (@aao/toolbox, @aao/integration-public-web, @aao/integration-documents) use only the public root", () => {
    for (const consumer of FRAMEWORK_CONSUMERS.filter((name) => name !== "toolbox")) {
      const consumerManifest = JSON.parse(readFileSync(join(repositoryRoot, "packages", consumer, "package.json"), "utf8")) as { dependencies: Record<string, string> };
      expect(consumerManifest.dependencies).toHaveProperty("@aao/framework");
      for (const file of sourceFiles(join(repositoryRoot, "packages", consumer, "src"))) expect(code(file), relative(repositoryRoot, file)).not.toMatch(/@aao\/framework\/|packages\/framework/);
    }
    const toolboxManifest = JSON.parse(readFileSync(join(repositoryRoot, "packages", "toolbox", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(toolboxManifest.dependencies).toHaveProperty("@aao/framework");
    for (const file of sourceFiles(join(repositoryRoot, "packages", "toolbox", "src"))) expect(code(file), relative(repositoryRoot, file)).not.toMatch(/@aao\/framework\/|packages\/framework/);
  });

  it("no Core package or app depends on or imports @aao/framework (framework → core only)", () => {
    expect(corePackages.length).toBeGreaterThan(10);
    for (const name of corePackages) {
      const manifest = JSON.parse(readFileSync(join(repositoryRoot, "packages", name, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
      expect({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }, name).not.toHaveProperty("@aao/framework");
      for (const dir of ["src", "conformance"]) for (const file of sourceFiles(join(repositoryRoot, "packages", name, dir))) expect(code(file), relative(repositoryRoot, file)).not.toMatch(/@aao\/framework|packages\/framework|\.\.\/framework\//);
    }
    for (const app of readdirSync(join(repositoryRoot, "apps"))) for (const file of sourceFiles(join(repositoryRoot, "apps", app, "src"))) expect(code(file), relative(repositoryRoot, file)).not.toMatch(/@aao\/framework/);
  });

  it("the framework imports no provider or framework SDK, and declares none as a dependency", () => {
    // Import specifiers only: the matrix may *name* LangGraph as deferred data, but nothing may import a vendor or protocol SDK.
    for (const file of frameworkSources) {
      for (const [, specifier] of code(file).matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) expect(specifier, relative(packageRoot, file)).not.toMatch(/@modelcontextprotocol|@langchain|langgraph|^ai$|^ai\/|@ai-sdk|openai|anthropic|express|fastify/i);
    }
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).filter((name) => !name.startsWith("@aao/"))).toEqual([]);
  });

  it("the public root's import graph reaches only the Core packages it composes — never the CLI, Evaluation, MCP, or model packages", () => {
    const bare = new Set<string>();
    const visited = new Set<string>();
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const match of code(file).matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
        else bare.add(specifier);
      }
    };
    visit(join(srcRoot, "index.ts"));
    expect([...visited].some((file) => file.includes(`${join("src", "cli")}`))).toBe(false);
    // Sprint 20: the adapter contract, the Model Runtime root (never its vercel-ai subpath), and the Agent Runtime. No vendor, MCP, Evaluation, or observability.
    expect([...bare].sort()).toEqual(["@aao/adapters", "@aao/agent-runtime", "@aao/approval", "@aao/authorization", "@aao/contracts", "@aao/governance", "@aao/model-runtime", "@aao/runtime", "@aao/tool-runtime", "@aao/workflow-dsl", "node:crypto"]);
    expect([...visited].some((file) => file.includes(`${join("src", "conformance")}`))).toBe(false);
  });

  it("no dynamic loading, plugin loading, environment discovery, or schema library of its own", () => {
    for (const file of frameworkSources) {
      const source = code(file);
      const name = relative(packageRoot, file);
      expect(source, name).not.toMatch(/\bimport\s*\(|\brequire\s*\(|createRequire|process\.env|\bplugins?\b|from\s+["']zod["']/);
    }
    const nonCli = frameworkSources.filter((file) => !file.includes(join("src", "cli")));
    for (const file of nonCli) expect(code(file), relative(packageRoot, file)).not.toMatch(/node:fs|readFileSync|readdirSync|process\.cwd/);
  });
});

describe("internal API integrity: the façade calls Core, it does not copy it", () => {
  const all = frameworkSources.map(code).join("\n");

  it("composes the canonical Core functions", () => {
    for (const fn of ["compileWorkflow", "executeWorkflow", "continueApprovedWorkflow", "createToolRegistry", "createToolNodeExecutor", "createGovernanceRegistry", "resolveAuthority", "authorizationContextFromAuthority", "createApprovalEngine", "createApprovalNodeExecutor", "createNodeRegistry", "finalOutputExecutor", "parseWorkflowSource", "compileWorkflowSource", "createModelRegistry", "createModelPolicyRegistry", "createModelNodeExecutor", "createAgentRegistry", "createAgentNodeExecutor", "createDeterministicNodeExecutor", "defineModelAdapter"]) {
      expect(all, fn).toMatch(new RegExp(`\\b${fn}\\(|\\b${fn}\\b[),]`));
    }
  });

  it("re-implements none of them: no schema, compiler, allow/deny decision, approval state, Run lifecycle, or retry logic", () => {
    expect(all).not.toMatch(/\bz\.object|WorkflowSchema\s*=|function\s+(authorize|compile|executeWorkflow|continueWaitingWorkflow|transition\w+|fingerprintApprovalSubject|retry\w*)\b/);
    expect(all).not.toMatch(/WAITING_FOR_APPROVAL|status\s*=\s*["'](approved|rejected|COMPLETED|FAILED)/);
    // The application host never fabricates an Authorization Context. Only the conformance host (src/conformance, a separate
    // subpath unreachable from the root and from createAAO) states a scenario's test principal and grants, exactly as a trusted host does.
    const host = frameworkSources.filter((file) => !file.includes(join("src", "conformance"))).map(code).join("\n");
    expect(host).not.toMatch(/grantedPermissionClasses\s*:/);
    expect(all).not.toMatch(/SUPPORTED_TOOL_PERMISSION_CLASSES|checkToolPermissionSupport/);
  });

  it("the old JavaScript Eval CLI is gone: one canonical TypeScript CLI, with the repo scripts as aliases to it", () => {
    expect(existsSync(join(repositoryRoot, "packages", "evaluation", "cli"))).toBe(false);
    const scripts = (JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const [script, command] of [["eval:ci", "eval ci"], ["eval:adapters", "eval adapters"], ["eval:baseline:propose", "eval baseline propose"]]) {
      expect(scripts[script!], script).toBe(`pnpm run --silent build:framework && node packages/framework/dist/cli/main.js ${command}`);
    }
    const tracked = execFileSync("git", ["ls-files", "packages"], { cwd: repositoryRoot, encoding: "utf8" }).split("\n");
    expect(tracked.filter((file) => /eval-ci\.mjs|eval-adapters\.mjs|eval-baseline-propose\.mjs|cli\/host\.mjs|cli\/network-guard\.mjs/.test(file))).toEqual([]);
  });

  it("no second Model or Agent Runtime: the framework never invokes an adapter, routes a model, or loops an Agent itself", () => {
    expect(all).not.toMatch(/\.invoke\(|executeModelRequest\(|executeAgent\(|selectModelBinding\(|deriveRequiredCapabilities\(|maxIterations\s*[<>]=?|for\s*\([^)]*iteration/);
  });

  it("no public Framework function accepts a caller-supplied EvalSuiteReport", () => {
    expect(indexSource).not.toMatch(/EvalSuiteReport|EvalBaseline|EvalGate/);
  });
});
