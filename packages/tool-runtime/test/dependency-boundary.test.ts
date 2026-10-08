import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const srcDir = join(packageRoot, "src");

const FORBIDDEN_SUBSTRINGS = [
  "openai",
  "@anthropic-ai",
  "@ai-sdk/",
  "@google",
  "gemini",
  "@azure",
  "ollama",
  "bedrock",
  "langgraph",
  "@langchain",
  "@modelcontextprotocol",
  "composio",
  "nango",
  "hubspot",
  "salesforce",
  "@slack",
  "octokit",
  "fastify",
  "@aao/model-runtime",
  "@aao/agent-runtime",
  "@aao/substrate-contracts",
  "@aao/substrate-spikes",
  "@aao/config",
  "@aao/workflow-dsl",
  "apps/",
] as const;

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(fullPath);
    return entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function importSpecifiers(file: string): string[] {
  const importPattern = /^\s*(?:import|export)[^;]*?\sfrom\s+["']([^"']+)["']/gm;
  return [...stripComments(readFileSync(file, "utf8")).matchAll(importPattern)].map((match) => match[1]!).filter((specifier) => !specifier.startsWith("."));
}

describe("@aao/tool-runtime dependency boundary", () => {
  const sourceFiles = listTsFiles(srcDir);

  it("finds the source files", () => {
    expect(sourceFiles.map((file) => relative(srcDir, file)).sort()).toEqual([
      "execution-id.ts",
      "executor.ts",
      "index.ts",
      "permissions.ts",
      "registry.ts",
      "schema-validator.ts",
      "tool-node.ts",
      "tool-trace.ts",
      "types.ts",
    ]);
  });

  it.each(sourceFiles.map((file) => [relative(srcDir, file)]))("%s imports no AI SDK, provider/vendor SDK, MCP, orchestration framework, Fastify, app, or substrate package", (file) => {
    const codeOnly = stripComments(readFileSync(join(srcDir, file), "utf8")).toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) expect(codeOnly).not.toContain(forbidden.toLowerCase());
    expect(codeOnly).not.toMatch(/from\s+["']ai["']/);
  });

  it("every source module imports only @aao/authorization, @aao/contracts, @aao/runtime, ajv, zod, and node:crypto", () => {
    const allowed = new Set(["@aao/authorization", "@aao/contracts", "@aao/runtime", "ajv", "zod", "node:crypto"]);
    for (const file of sourceFiles) {
      for (const specifier of importSpecifiers(file)) {
        expect(allowed.has(specifier), `${relative(srcDir, file)} imports unexpected module "${specifier}"`).toBe(true);
      }
    }
  });

  it("no source reads process.env, credentials, the filesystem, the network, or loads modules dynamically", () => {
    for (const file of sourceFiles) {
      const codeOnly = stripComments(readFileSync(file, "utf8"));
      expect(codeOnly).not.toMatch(/process\.env|API_KEY|node:fs|node:http|node:child_process|fetch\(|require\(|import\(|\beval\(|new Function/);
    }
  });

  it("declares exactly the expected production dependencies", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(["@aao/authorization", "@aao/contracts", "@aao/runtime", "ajv", "zod"]);
    expect(Object.keys(packageJson.devDependencies ?? {}).sort()).toEqual(["@aao/governance", "@aao/workflow-dsl"]);
  });

  it("contains no retry execution, timeout race, cache, persistence, or global mutable Tool state", () => {
    for (const file of sourceFiles) {
      const codeOnly = stripComments(readFileSync(file, "utf8"));
      // Retry execution belongs only to the Runtime Reliability Controller (ADR-018). Tool Runtime may
      // declare trusted metadata (`retrySafety`, a handler's `retryable` flag) but owns no attempts,
      // loops, sleeps, timers, or races.
      // tool-trace.ts reports the Runtime-assigned attempt number as observational trace metadata (ADR-020);
      // it is held to every other constraint here. All other files may not even name an attempt.
      const retryExecution = file.endsWith("tool-trace.ts")
        ? /\bretry\b|retries|retrying|maxAttempts|backoff|fallback|sleep|setTimeout|setInterval|Promise\.race|AbortController|sqlite|postgres|redis|globalThis|\bfor\s*\(|\bwhile\s*\(/i
        : /\bretry\b|retries|retrying|attempt|maxAttempts|backoff|fallback|sleep|setTimeout|setInterval|Promise\.race|AbortController|sqlite|postgres|redis|globalThis/i;
      expect(codeOnly).not.toMatch(retryExecution);
      // Registries are created by factories; no module-level Map/Set/array holds Tool state.
      expect(codeOnly).not.toMatch(/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Map|Set)\b/m);
      // No authorization verdict is cached or remembered.
      expect(codeOnly).not.toMatch(/cache|memo/i);
    }
  });

  it("the only module-level collection is registry.ts's WeakMap keying private bindings by registry instance", () => {
    const moduleLevel = sourceFiles.flatMap((file) => [...stripComments(readFileSync(file, "utf8")).matchAll(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*new\s+(\w+)/gm)].map((match) => `${relative(srcDir, file)}:${match[1]}:${match[2]}`));
    expect(moduleLevel).toEqual(["registry.ts:bindingsByRegistry:WeakMap"]);
  });

  it("produces no console logging (authorization contexts are never logged)", () => {
    for (const file of sourceFiles) expect(stripComments(readFileSync(file, "utf8"))).not.toMatch(/console\./);
  });

  it("the Agent Runtime still cannot reach the Tool Runtime or Authorization", () => {
    const agentPackage = JSON.parse(readFileSync(join(packageRoot, "..", "agent-runtime", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(agentPackage.dependencies ?? {})).not.toContain("@aao/tool-runtime");
    for (const file of listTsFiles(join(packageRoot, "..", "agent-runtime", "src"))) expect(stripComments(readFileSync(file, "utf8"))).not.toMatch(/@aao\/tool-runtime|@aao\/authorization/);
  });

  it("the generic Runtime stays authorization-unaware", () => {
    for (const file of listTsFiles(join(packageRoot, "..", "runtime", "src"))) {
      expect(stripComments(readFileSync(file, "utf8"))).not.toMatch(/@aao\/authorization|@aao\/tool-runtime|grantedPermissionClasses|AuthorizationContext|PERMISSION_NOT_GRANTED/);
    }
  });

  it("does not add Agent Tool use: the Agent Runtime's decision vocabulary is untouched", () => {
    const agentTypes = readFileSync(join(packageRoot, "..", "agent-runtime", "src", "types.ts"), "utf8");
    expect(agentTypes).toContain('export const AGENT_ACTIONS = ["CONTINUE", "COMPLETE"] as const;');
    expect(agentTypes).not.toMatch(/CALL_TOOL|USE_TOOL|"ACTION"/);
  });
});
