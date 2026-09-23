import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const srcDir = join(packageRoot, "src");

const FORBIDDEN_IMPORT_SUBSTRINGS = [
  "langgraph",
  "@langchain",
  "\"ai\"",
  "'ai'",
  "@modelcontextprotocol",
  "fastify",
  "@aao/substrate-contracts",
  "@aao/substrate-spikes",
  "@aao/config",
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

describe("framework and vendor import boundary", () => {
  const sourceFiles = listTsFiles(srcDir);

  it("finds source files to check (sanity check the check itself runs)", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles.map((file) => [file]))("%s contains no forbidden framework/vendor import", (file) => {
    // Comments are allowed to *discuss* forbidden frameworks (e.g. "must
    // never import LangGraph model types") — only actual code is checked.
    const codeOnly = stripComments(readFileSync(file, "utf8"));
    for (const forbidden of FORBIDDEN_IMPORT_SUBSTRINGS) {
      expect(codeOnly.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("declares zod as its only production dependency", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual(["zod"]);
  });

  it("contains no `any` type in canonical contract source", () => {
    for (const file of sourceFiles) {
      const codeOnly = stripComments(readFileSync(file, "utf8"));
      // Matches `any` as a standalone word so identifiers merely containing
      // "any" (e.g. "company") are not flagged.
      const anyTypeUsage = /\bany\b/.test(codeOnly);
      expect(anyTypeUsage, `${file} must not use the \`any\` type`).toBe(false);
    }
  });
});
