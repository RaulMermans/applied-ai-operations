import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as integration from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const srcRoot = join(packageRoot, "src");

const sourceFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((file) => /\.(ts|mts|mjs|js)$/.test(file) && !file.endsWith(".d.ts") && !file.includes("node_modules") && !file.includes("dist/"))
        .map((file) => join(dir, file))
    : [];

/** Code only: comments may name things the code must never import or call. */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const sources = sourceFiles(srcRoot);
const indexSource = code(join(srcRoot, "index.ts"));
const importsOf = (source: string) => [...source.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, Record<string, string> | string | string[] | boolean>;

/**
 * THE @aao/integration-documents public API snapshot (Sprint 23, ADR-028).
 * Adding or removing a symbol must change these lists deliberately.
 */
const PUBLIC_VALUE_EXPORTS = [
  "DOCUMENT_EXTRACT_TEXT_TOOL_REF",
  "DOCUMENT_FINGERPRINT_PATTERN",
  "DOCUMENT_ID_PATTERN",
  "DOCUMENT_LIMITS",
  "computeDocumentFingerprint",
  "computeDocumentId",
  "createDocumentTools",
  "normalizeCanonicalPageText",
  "safeSliceUtf16",
];

const PUBLIC_TYPE_EXPORTS = [
  "DocumentFailureCode",
  "DocumentParserResult",
  "DocumentSourceFailureReason",
  "DocumentSourceProvider",
  "DocumentSourceProviderContext",
  "DocumentSourceReadFailure",
  "DocumentSourceReadRequest",
  "DocumentSourceReadResponse",
  "DocumentSourceReadSuccess",
  "DocumentTools",
  "DocumentToolsOptions",
  "ExtractDocumentInput",
  "ExtractDocumentOutput",
  "ExtractedDocumentData",
  "ExtractedDocumentMeta",
  "ExtractedDocumentPage",
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
    expect(Object.keys(integration).sort()).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
  });

  it("the declared value and type exports are exactly the approved lists, with no `export *`", () => {
    const declared = declaredExports(indexSource);
    expect(declared.values).toEqual([...PUBLIC_VALUE_EXPORTS].sort());
    expect(declared.types).toEqual([...PUBLIC_TYPE_EXPORTS].sort());
    for (const file of sources) expect(code(file), relative(packageRoot, file)).not.toMatch(/export\s+\*/);
  });

  it("Tool refs and limits are frozen", () => {
    expect(
      Object.isFrozen(integration.DOCUMENT_EXTRACT_TEXT_TOOL_REF) &&
      Object.isFrozen(integration.DOCUMENT_LIMITS)
    ).toBe(true);
  });

  it("parser-specific internal types (PDFDocumentProxy, etc.) never appear in public exports", () => {
    const declared = declaredExports(indexSource);
    for (const type of declared.types) {
      expect(type).not.toMatch(/PDF|Proxy|unpdf/i);
    }
  });
});

describe("Integration Fabric boundary (static)", () => {
  it("depends only on @aao/framework and unpdf at runtime and imports nothing else but node:crypto and internal modules", () => {
    expect(manifest.dependencies).toEqual({
      "@aao/framework": "workspace:*",
      "unpdf": "^1.9.0",
    });
    const external = new Set(
      sources.flatMap((file) => importsOf(code(file))).filter((specifier) => !specifier.startsWith("."))
    );
    expect([...external].sort()).toEqual(["@aao/framework", "node:crypto", "unpdf"]);
  });

  it("names no cloud storage vendor or concrete provider anywhere in code or dependencies", () => {
    const all = sources.map(code).join("\n") + JSON.stringify(manifest);
    for (const name of ["s3", "gcs", "azure", "google-drive", "sharepoint", "box", "dropbox", "notion"]) {
      expect(all.toLowerCase(), name).not.toMatch(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
    }
  });

  it("performs no network or filesystem operations itself", () => {
    const all = sources.map(code).join("\n");
    expect(all).not.toMatch(/\bfetch\s*\(\s*["'`h]|node:(http|https|net|dns|fs|child_process)|process\.env|globalThis\.fetch|XMLHttpRequest|WebSocket/);
  });

  it("implements no governance, Authorization, Approval, Run lifecycle, or retry machinery", () => {
    const all = sources.map(code).join("\n");
    expect(all).not.toMatch(/\b(Principal|Role|GovernanceConfiguration|AuthorizationContext|authorize|resolveAuthority|grantedPermissionClasses|Approval\w*|executeWorkflow|RunState|RuntimeExecutionState|ReliabilityPolicy|maxAttempts|setTimeout|setInterval)\b/);
    expect(all).not.toMatch(/\bwhile\s*\(|\bfor\s*\(\s*let\s+attempt/);
  });

  it("defines no company-specific or mega Tool: only extract_text", () => {
    const all = sources.map(code).join("\n");
    expect([...all.matchAll(/id:\s*"(document\.[a-z_]+)"/g)].map((match) => match[1])).toEqual(["document.extract_text"]);
    expect(all).not.toMatch(/analyze_document|extract_invoice|review_contract|parse_policy/);
  });

  it("is not part of the Toolbox, and the Toolbox does not depend on it", () => {
    const toolboxManifest = readFileSync(join(repositoryRoot, "packages", "toolbox", "package.json"), "utf8");
    const toolboxCode = sourceFiles(join(repositoryRoot, "packages", "toolbox", "src")).map(code).join("\n");
    expect(toolboxManifest + toolboxCode).not.toMatch(/integration-documents|document\.extract_text/);
  });

  it("no Core package depends on it (dependency direction is integration → Core)", () => {
    const roots = ["packages", "apps"].flatMap((group) => readdirSync(join(repositoryRoot, group)).map((name) => join(repositoryRoot, group, name)));
    for (const root of roots) {
      if (root === packageRoot || !existsSync(join(root, "package.json"))) continue;
      const pkg = readFileSync(join(root, "package.json"), "utf8");
      const text = pkg + sourceFiles(join(root, "src")).map(code).join("\n");
      expect(text, relative(repositoryRoot, root)).not.toMatch(/@aao\/integration-documents/);
    }
  });
});

describe("@aao/integration-documents package manifest", () => {
  it("exposes exactly the root, typed from compiled declarations — never repository src/", () => {
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./package.json": "./package.json",
    });
    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.main).toBe("./dist/index.js");
    expect(JSON.stringify(manifest)).not.toMatch(/\.\/src\//);
  });

  it("allowlists only compiled output and the README; stays private with no bin or install hook", () => {
    expect(manifest.files).toEqual(["dist/**/*.js", "dist/**/*.d.ts", "README.md"]);
    expect(manifest.private).toBe(true);
    expect(manifest.bin).toBeUndefined();
    expect(Object.keys(manifest.scripts as object).filter((name) => /install|prepare|publish/.test(name))).toEqual([]);
    expect(manifest.engines).toEqual({ node: ">=20.20.0 <21.0.0" });
  });
});
