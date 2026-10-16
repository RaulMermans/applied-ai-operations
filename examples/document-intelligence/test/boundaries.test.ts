import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_INTELLIGENCE_EXECUTORS,
  documentIntelligenceWorkflow,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Code only: comments may name what the code must never do. */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const srcFiles = readdirSync(join(root, "src"))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => join(root, "src", file));

const src = Object.fromEntries(srcFiles.map((file) => [file.slice(root.length + 1), code(file)]));
const importsOf = (source: string) =>
  [...source.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  private: boolean;
};

describe("public-package consumer rule", () => {
  it("the proof's runtime code imports only @aao/framework and @aao/integration-documents", () => {
    const external = new Set(
      Object.values(src)
        .flatMap(importsOf)
        .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"))
    );
    expect([...external].sort()).toEqual(["@aao/framework", "@aao/integration-documents"]);
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@aao/framework",
      "@aao/integration-documents",
    ]);
    expect(manifest.private).toBe(true);
  });

  it("no deep imports into Core packages and no fixture imports from runtime API", () => {
    for (const [file, source] of Object.entries(src)) {
      expect(
        importsOf(source).filter((specifier) => /^@aao\/[^/]+\/|\/src\/|fixtures|\.\.\//.test(specifier)),
        file
      ).toEqual([]);
    }
  });
});

describe("deterministic glue and architectural invariants", () => {
  it("executors call no provider, network, filesystem, environment, or model", () => {
    const glue = src["src/executors.ts"]!;
    expect(glue).not.toMatch(
      /\.read\(|\bfetch\(|node:fs|process\.env|createDocumentTools|executeTool|invoke\(|createAAO|Date\.now|new Date|Math\.random/
    );
  });

  it("every executor is registered by exact id@version and Workflow references only those", () => {
    const registered = new Set(DOCUMENT_INTELLIGENCE_EXECUTORS.map((e) => `${e.id}@${e.version}`));
    const referenced = documentIntelligenceWorkflow.nodes
      .filter((n) => n.kind === "deterministic")
      .map((n) => {
        const ref = (n.config as { executorRef: { id: string; version: string } }).executorRef;
        return `${ref.id}@${ref.version}`;
      });
    expect(new Set(referenced)).toEqual(registered);
  });

  it("no generic mapping or expression language exists: no templates, JSONPath, JSONata, or eval", () => {
    const all = Object.values(src).join("\n") + JSON.stringify(documentIntelligenceWorkflow);
    expect(all).not.toMatch(/\{\{|\$\.[a-z]|jsonata|jmespath|new Function|\beval\(|import\(/i);
  });

  it("no generic branching DSL or if-node in workflow", () => {
    const kinds = documentIntelligenceWorkflow.nodes.map((n) => n.kind);
    expect(kinds).not.toContain("branch");
    expect(kinds).not.toContain("if");
    expect(kinds).not.toContain("switch");
    expect(kinds).not.toContain("condition");
  });

  it("no vector database, embedding framework, OCR, or autonomous agent imports", () => {
    const all = Object.values(src).join("\n");
    expect(all).not.toMatch(/vector|embedding|chroma|pinecone|qdrant|weaviate|tesseract|\bocr\b|agent-runtime/i);
  });
});
