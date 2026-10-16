import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coreToolbox, listToolboxEntries } from "@aao/toolbox";
import { COMPANY_RESEARCH_EXECUTORS, companyResearchWorkflow } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Code only: comments may name what the code must never do. */
const code = (file: string) => readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const srcFiles = readdirSync(join(root, "src")).filter((file) => file.endsWith(".ts")).map((file) => join(root, "src", file));
const src = Object.fromEntries(srcFiles.map((file) => [file.slice(root.length + 1), code(file)]));
const importsOf = (source: string) => [...source.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; private: boolean };

describe("public-package consumer rule", () => {
  it("the proof's runtime code imports only @aao/framework, @aao/toolbox, and @aao/integration-public-web", () => {
    const external = new Set(Object.values(src).flatMap(importsOf).filter((specifier) => !specifier.startsWith(".")));
    expect([...external].sort()).toEqual(["@aao/framework", "@aao/integration-public-web", "@aao/toolbox"]);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@aao/framework", "@aao/integration-public-web", "@aao/toolbox"]);
    expect(manifest.private).toBe(true);
  });

  it("no deep import into Core and no fixture import from the runtime API", () => {
    for (const [file, source] of Object.entries(src)) {
      expect(importsOf(source).filter((specifier) => /^@aao\/[^/]+\/|\/src\/|fixtures|\.\.\//.test(specifier)), file).toEqual([]);
    }
  });
});

describe("deterministic glue", () => {
  it("glue executors call no provider, network, filesystem, environment, model, or Tool", () => {
    const glue = src["src/executors.ts"]!;
    expect(glue).not.toMatch(/\.search\(|\.fetch\(|\bfetch\(|node:|process\.|createPublicWebTools|executeTool|invoke\(|createAAO|Date\.now|new Date|Math\.random/);
  });

  it("every executor is registered by exact id@version and the Workflow references only those", () => {
    const registered = new Set(COMPANY_RESEARCH_EXECUTORS.map((executor) => `${executor.id}@${executor.version}`));
    const referenced = companyResearchWorkflow.nodes.filter((node) => node.kind === "deterministic").map((node) => { const ref = (node.config as { executorRef: { id: string; version: string } }).executorRef; return `${ref.id}@${ref.version}`; });
    expect(new Set(referenced)).toEqual(registered);
  });

  it("no generic mapping or expression language exists: no templates, JSONPath, JSONata, JMESPath, or dynamic code", () => {
    const all = Object.values(src).join("\n") + JSON.stringify(companyResearchWorkflow);
    expect(all).not.toMatch(/\{\{|\$\.[a-z]|jsonata|jmespath|new Function|\beval\(|import\(/i);
  });
});

describe("no Toolbox pollution", () => {
  it("public_web.* Integration Tools are not in the aao.core Toolbox catalog", () => {
    const ids = listToolboxEntries(coreToolbox).map((entry) => entry.toolRef.id);
    expect(ids.some((id) => id.startsWith("public_web."))).toBe(false);
    expect(ids).toEqual(expect.arrayContaining(["records.dedupe", "records.project"]));
  });
});

describe("scope", () => {
  it("no Agent, Approval, evaluator, memory, Artifact store, Capability Pack, or side-effect Tool", () => {
    expect(companyResearchWorkflow.nodes.some((node) => node.kind === "agent" || node.kind === "approval" || node.kind === "evaluator")).toBe(false);
    const all = Object.values(src).join("\n");
    expect(all).not.toMatch(/\b(createAgent|defineAgent|ArtifactStore|ArtifactRepository|MemoryStore|writeMemory|defineCapabilityPack|approvals\.|external_side_effect|destructive|write_draft)\b/);
    expect(all).not.toMatch(/research_company|do_company_research|analyze_competitor|generate_company_report/);
  });

  it("no document intelligence or crawling: no PDF, OCR, embeddings, or link following", () => {
    expect(Object.values(src).join("\n")).not.toMatch(/\b(pdf|ocr|embedding|crawl|followLinks|href=)\b/i);
  });
});
