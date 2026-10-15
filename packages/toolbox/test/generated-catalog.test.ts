import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToolboxCatalogJson, renderToolboxCatalogMarkdown } from "../src/catalog-doc.js";
import { coreToolbox, describeToolbox, selectToolboxTools } from "../src/index.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const committedJson = readFileSync(join(repositoryRoot, "docs", "generated", "toolbox-core.json"), "utf8");
const committedMarkdown = readFileSync(join(repositoryRoot, "docs", "toolbox", "core-tools.md"), "utf8");

describe("generated Core Toolbox catalog", () => {
  it("docs/generated/toolbox-core.json matches what the canonical Toolbox generates (no drift)", () => {
    expect(renderToolboxCatalogJson(describeToolbox(coreToolbox))).toBe(committedJson);
  });

  it("docs/toolbox/core-tools.md matches what the canonical Toolbox generates (no drift)", () => {
    expect(renderToolboxCatalogMarkdown(describeToolbox(coreToolbox))).toBe(committedMarkdown);
  });

  it("derives permission, version, and description from the actual Tool specs", () => {
    const parsed = JSON.parse(committedJson) as { authority: string; tools: { toolRef: { id: string; version: string }; permissionClasses: string[]; description: string }[] };
    expect(parsed.authority).toBe("none");
    for (const tool of parsed.tools) {
      const [definition] = selectToolboxTools(coreToolbox, [tool.toolRef]);
      expect(tool.permissionClasses).toEqual(definition!.spec.permissionClasses);
      expect(tool.description).toBe(definition!.spec.description);
      expect(committedMarkdown).toContain(`| \`${tool.toolRef.id}\` | ${tool.toolRef.version} |`);
    }
  });

  it("serializes no handler, source, module path, or implementation file", () => {
    for (const text of [committedJson, committedMarkdown]) expect(text).not.toMatch(/"handler"|execute\(|=>|function |packages\/|src\/|dist\/|\.ts\b|\.mjs\b|node:/);
  });
});
