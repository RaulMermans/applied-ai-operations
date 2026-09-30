import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const srcDir = join(packageRoot, "src");

const FORBIDDEN_SUBSTRINGS = [
  "@aao/tool-runtime",
  "@aao/agent-runtime",
  "@aao/model-runtime",
  "@aao/runtime",
  "@aao/workflow-dsl",
  "@aao/config",
  "@aao/substrate-contracts",
  "@aao/substrate-spikes",
  "openai",
  "@anthropic-ai",
  "@ai-sdk/",
  "@google",
  "@azure",
  "langgraph",
  "@langchain",
  "@modelcontextprotocol",
  "fastify",
  "composio",
  "nango",
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

describe("@aao/authorization dependency boundary", () => {
  const sourceFiles = listTsFiles(srcDir);

  it("finds the source files", () => {
    expect(sourceFiles.map((file) => relative(srcDir, file)).sort()).toEqual(["evaluator.ts", "index.ts", "types.ts"]);
  });

  it.each(sourceFiles.map((file) => [relative(srcDir, file)]))("%s imports no Tool/Agent/Model/workflow Runtime, AI SDK, vendor SDK, MCP, LangGraph, Fastify, or app", (file) => {
    const codeOnly = stripComments(readFileSync(join(srcDir, file), "utf8")).toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) expect(codeOnly).not.toContain(forbidden.toLowerCase());
    expect(codeOnly).not.toMatch(/from\s+["']ai["']/);
  });

  it("every source module imports only contracts, governance types, and zod", () => {
    for (const file of sourceFiles) {
      for (const specifier of importSpecifiers(file)) {
        expect(["@aao/contracts", "@aao/governance", "zod"].includes(specifier), `${relative(srcDir, file)} imports unexpected module "${specifier}"`).toBe(true);
      }
    }
  });

  it("declares exactly contracts, governance, and zod as dependencies", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(["@aao/contracts", "@aao/governance", "zod"]);
    expect(packageJson.devDependencies ?? {}).toEqual({});
  });

  it("is pure: no I/O, env, clock, randomness, logging, dynamic code, network, or module-level state", () => {
    for (const file of sourceFiles) {
      const codeOnly = stripComments(readFileSync(file, "utf8"));
      expect(codeOnly).not.toMatch(/process\.env|node:|fetch\(|require\(|import\(|\beval\(|new Function|Date\.|new Date|Math\.random|console\.|setTimeout|globalThis/);
      expect(codeOnly).not.toMatch(/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Weak)?(?:Map|Set)\b/m);
      expect(codeOnly).not.toMatch(/\blet\s+\w+\s*=/);
    }
  });

  it("has no superuser, bypass, default-allow, hierarchy, policy language, or approval vocabulary", () => {
    for (const file of sourceFiles) {
      const codeOnly = stripComments(readFileSync(file, "utf8"));
      expect(codeOnly).not.toMatch(/allowAll|bypass|isAdmin|admin\s*:|superuser|implies|REQUIRE_APPROVAL|rego|cedar/i);
    }
  });
});
