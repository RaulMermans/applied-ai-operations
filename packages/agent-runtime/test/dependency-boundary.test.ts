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
  "fastify",
  "@aao/substrate-contracts",
  "@aao/substrate-spikes",
  "@aao/config",
  "@aao/workflow-dsl",
  "@aao/model-runtime/vercel-ai",
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

describe("@aao/agent-runtime dependency boundary", () => {
  const sourceFiles = listTsFiles(srcDir);

  it("finds the source files", () => {
    expect(sourceFiles.map((file) => relative(srcDir, file)).sort()).toEqual(["agent-node.ts", "controller.ts", "decision.ts", "index.ts", "registry.ts", "resolution.ts", "types.ts"]);
  });

  it.each(sourceFiles.map((file) => [relative(srcDir, file)]))("%s imports no AI SDK, provider SDK, orchestration framework, MCP, Fastify, or substrate package", (file) => {
    const codeOnly = stripComments(readFileSync(join(srcDir, file), "utf8")).toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) expect(codeOnly).not.toContain(forbidden.toLowerCase());
  });

  it("every source module imports only @aao/contracts, @aao/runtime, @aao/model-runtime (entry point), and zod — never `ai`", () => {
    const allowed = new Set(["@aao/contracts", "@aao/runtime", "@aao/model-runtime", "zod"]);
    for (const file of sourceFiles) {
      for (const specifier of importSpecifiers(file)) {
        expect(allowed.has(specifier), `${relative(srcDir, file)} imports unexpected module "${specifier}"`).toBe(true);
      }
    }
  });

  it("no source reads process.env, credentials, the filesystem, or loads modules dynamically", () => {
    for (const file of sourceFiles) {
      const codeOnly = stripComments(readFileSync(file, "utf8"));
      expect(codeOnly).not.toMatch(/process\.env|API_KEY|node:fs|require\(|import\(/);
    }
  });

  it("declares exactly the expected production dependencies (`ai` is test-only)", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(["@aao/contracts", "@aao/model-runtime", "@aao/runtime", "zod"]);
    expect(Object.keys(packageJson.devDependencies ?? {}).sort()).toEqual(["@aao/workflow-dsl", "ai"]);
  });

  it("contains no tool execution, delegation, memory, persistence, or retry machinery", () => {
    for (const file of sourceFiles) {
      const codeOnly = stripComments(readFileSync(file, "utf8"));
      expect(codeOnly).not.toMatch(/toolCall|tool_call|spawnAgent|subagent|handoff|vector|sqlite|postgres|redis|setTimeout|retry\(/i);
    }
  });
});
