import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const srcDir = join(packageRoot, "src");

/** The only module allowed to import the Vercel AI SDK. */
const AI_SDK_ADAPTER = "adapters/vercel-ai.ts";

const FORBIDDEN_IMPORT_SUBSTRINGS = [
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

describe("@aao/model-runtime dependency boundary", () => {
  const sourceFiles = listTsFiles(srcDir);

  it("finds source files, including the AI SDK adapter", () => {
    expect(sourceFiles.map((file) => relative(srcDir, file))).toContain(AI_SDK_ADAPTER);
  });

  it.each(sourceFiles.map((file) => [relative(srcDir, file)]))("%s imports no provider SDK, orchestration framework, or substrate package", (file) => {
    const codeOnly = stripComments(readFileSync(join(srcDir, file), "utf8")).toLowerCase();
    for (const forbidden of FORBIDDEN_IMPORT_SUBSTRINGS) expect(codeOnly).not.toContain(forbidden.toLowerCase());
  });

  it("only the AI SDK adapter imports `ai`; generic modules import only @aao/contracts, @aao/runtime, zod, ajv", () => {
    const generic = new Set(["@aao/contracts", "@aao/runtime", "zod", "ajv"]);
    for (const file of sourceFiles) {
      const rel = relative(srcDir, file);
      const allowed = rel === AI_SDK_ADAPTER ? new Set(["ai"]) : generic;
      for (const specifier of importSpecifiers(file)) {
        expect(allowed.has(specifier), `${rel} imports unexpected module "${specifier}"`).toBe(true);
      }
    }
  });

  it("the package entry point does not re-export the AI SDK adapter", () => {
    expect(stripComments(readFileSync(join(srcDir, "index.ts"), "utf8"))).not.toContain("adapters/");
  });

  it("no source reads process.env or credentials", () => {
    for (const file of sourceFiles) {
      const codeOnly = stripComments(readFileSync(file, "utf8"));
      expect(codeOnly).not.toMatch(/process\.env|API_KEY/);
    }
  });

  it("declares exactly the expected production dependencies", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(["@aao/contracts", "@aao/runtime", "ai", "ajv", "zod"]);
  });
});
