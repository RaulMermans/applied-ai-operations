import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as toolbox from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const srcRoot = join(packageRoot, "src");

const sourceFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => /\.(ts|mts|mjs|js)$/.test(file) && !file.endsWith(".d.ts")).map((file) => join(dir, file)) : []);
/** Code only: comments may name things the code must never import or call. */
const code = (file: string) => readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const toolboxSources = sourceFiles(srcRoot);
const coreToolSources = sourceFiles(join(srcRoot, "core"));
const indexSource = code(join(srcRoot, "index.ts"));
const importsOf = (source: string) => [...source.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]!);

/**
 * THE @aao/toolbox public API snapshot (Sprint 21, ADR-026). Adding or
 * removing a symbol must change these lists deliberately.
 */
const PUBLIC_VALUE_EXPORTS = ["CORE_TOOL_LIMITS", "ToolboxError", "coreToolbox", "defineToolbox", "describeToolbox", "getToolboxEntry", "listToolboxEntries", "searchToolbox", "selectToolboxTools"];
const PUBLIC_TYPE_EXPORTS = [
  "DefineToolboxInput", "Toolbox", "ToolboxCatalogEntry", "ToolboxDescription", "ToolboxEntry", "ToolboxEntryFilter", "ToolboxEntryInput", "ToolboxErrorCode", "ToolboxExample", "ToolboxManifest", "ToolboxManifestInput", "ToolboxRef",
  "ToolboxSearchField", "ToolboxSearchQuery", "ToolboxSearchResult", "ToolboxToolDescription", "ToolboxToolRef",
];

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
    expect(Object.keys(toolbox).sort()).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
  });

  it("the declared value and type exports are exactly the approved lists", () => {
    const declared = declaredExports(indexSource);
    expect(declared.values).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
    expect(declared.types).toEqual([...PUBLIC_TYPE_EXPORTS].sort());
  });

  it("no `export *` anywhere in the package", () => {
    for (const file of toolboxSources) expect(code(file), relative(packageRoot, file)).not.toMatch(/export\s+\*/);
  });

  it("no second runtime, authorization, retry, approval, registry, or evaluator is exported or defined", () => {
    const exported = new Set([...Object.keys(toolbox), ...declaredExports(indexSource).types]);
    for (const name of ["ToolboxExecutor", "ToolboxRuntime", "ToolboxAuthorization", "ToolboxRetryEngine", "ToolboxApprovalEngine", "ToolboxEvaluator", "ToolboxEvalEngine", "executeTool", "createToolRegistry", "registerToolbox", "installToolbox", "loadToolbox", "allTools", "autoRegister"]) {
      expect(exported.has(name), name).toBe(false);
    }
    const all = toolboxSources.map(code).join("\n");
    expect(all).not.toMatch(/\b(class|function|const)\s+Toolbox(Executor|Runtime|Authorization|RetryEngine|ApprovalEngine|Evaluator|EvalEngine)\b/);
    expect(all).not.toMatch(/\b(executeTool|createToolRegistry|createToolNodeExecutor|authorize|resolveAuthority|executeWorkflow|createApprovalEngine)\s*\(/);
  });
});

describe("dependency and authority boundaries", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

  it("production dependencies are the public Framework, the canonical contracts, and zod — nothing else", () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@aao/contracts", "@aao/framework", "zod"]);
  });

  it("Evaluation, Observability, and the Tool Runtime are test-only dependencies; production source never imports them", () => {
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(["@aao/evaluation", "@aao/observability", "@aao/tool-runtime"]);
    const imported = new Set(toolboxSources.flatMap((file) => importsOf(code(file))).filter((specifier) => !specifier.startsWith(".")));
    expect([...imported].sort()).toEqual(["@aao/contracts", "@aao/framework", "node:crypto", "zod"]);
  });

  it("no Core package, app, or the Framework depends on or imports @aao/toolbox (Toolbox sits above Core)", () => {
    const packages = readdirSync(join(repositoryRoot, "packages")).filter((name) => name !== "toolbox" && existsSync(join(repositoryRoot, "packages", name, "package.json")));
    expect(packages.length).toBeGreaterThan(10);
    for (const name of packages) {
      const other = JSON.parse(readFileSync(join(repositoryRoot, "packages", name, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
      expect({ ...other.dependencies, ...other.devDependencies, ...other.peerDependencies }, name).not.toHaveProperty("@aao/toolbox");
      for (const dir of ["src", "conformance", "smoke"]) for (const file of sourceFiles(join(repositoryRoot, "packages", name, dir))) expect(code(file), relative(repositoryRoot, file)).not.toMatch(/@aao\/toolbox|packages\/toolbox/);
    }
    for (const app of readdirSync(join(repositoryRoot, "apps"))) for (const file of sourceFiles(join(repositoryRoot, "apps", app, "src"))) expect(code(file), relative(repositoryRoot, file)).not.toMatch(/@aao\/toolbox/);
  });

  it("no provider SDK, protocol SDK, HTTP or database client, or Capability Pack is imported or declared", () => {
    const forbidden = /@modelcontextprotocol|@langchain|langgraph|^ai$|^ai\/|@ai-sdk|openai|anthropic|slack|google|googleapis|@octokit|github|hubspot|salesforce|notion|axios|node-fetch|undici|got$|^pg$|mysql|sqlite|mongodb|redis|prisma|express|fastify|capability-pack/i;
    for (const file of toolboxSources) for (const specifier of importsOf(code(file))) expect(specifier, relative(packageRoot, file)).not.toMatch(forbidden);
    for (const name of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]) expect(name).not.toMatch(forbidden);
    expect(toolboxSources.map(code).join("\n")).not.toMatch(/\bCapabilityPack|capabilityPack/);
  });

  it("no network, filesystem, environment, process, clock, randomness, locale, or dynamic code in any source", () => {
    for (const file of toolboxSources) {
      const source = code(file);
      const name = relative(packageRoot, file);
      expect(source, name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(http|https|net|dgram|tls|dns|fs|fs\/promises|child_process|vm|worker_threads|os|path)\b|["'](fs|http|https|net|child_process|vm|os)["']/);
      expect(source, name).not.toMatch(/process\.|\bDate\b|Math\.random|crypto\.random|randomUUID|performance\.now|Intl\.|toLocale|localeCompare/);
      expect(source, name).not.toMatch(/\beval\s*\(|new\s+Function\b|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(|createRequire|setTimeout|setInterval/);
    }
  });

  it("Core Tool handlers do not use the handler context beyond `input`", () => {
    for (const file of coreToolSources) expect(code(file), relative(packageRoot, file)).not.toMatch(/toolExecutionId|context\.signal|\bsignal\b/);
  });

  it("Toolbox code never authorizes, retries, approves, or reads permission classes for any decision but admission", () => {
    const all = toolboxSources.map(code).join("\n");
    expect(all).not.toMatch(/grantedPermissionClasses|AuthorizationContext|principalForRun|maxAttempts|ReliabilityPolicy|approve\(|reject\(|SUPPORTED_TOOL_PERMISSION_CLASSES/);
    // The only permission-class read outside catalog copies is the admission rule in contract.ts.
    const reads = toolboxSources.filter((file) => /ADMISSIBLE_PERMISSION_CLASSES/.test(code(file))).map((file) => relative(packageRoot, file));
    expect(reads).toEqual([join("src", "contract.ts")]);
  });

  it("importing the package registers nothing globally: no module-level registry, singleton catalog, or global assignment", () => {
    const all = toolboxSources.map(code).join("\n");
    expect(all).not.toMatch(/globalThis|global\.|Symbol\.for\(/);
    // The only module-level collection is the WeakMap of Toolbox-private state, keyed by Toolbox objects callers create.
    expect([...all.matchAll(/^const\s+\w+\s*=\s*new\s+(Map|Set|WeakMap)\b/gm)].map((match) => match[1])).toEqual(["WeakMap"]);
  });

  it("the public root's import graph reaches only the package's own modules", () => {
    const visited = new Set<string>();
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const specifier of importsOf(code(file))) if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    };
    visit(join(srcRoot, "index.ts"));
    // The generated-document renderer is package-internal and unreachable from the root.
    expect([...visited].map((file) => relative(srcRoot, file)).sort()).toEqual(["catalog.ts", "contract.ts", join("core", "index.ts"), join("core", "limits.ts"), join("core", "records-common.ts"), join("core", "records.ts"), join("core", "text.ts"), "errors.ts", "index.ts", "json.ts"]);
  });
});
