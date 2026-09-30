import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("governance dependency boundary", () => {
  it("depends only on canonical contracts and schema validation", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@aao/contracts", "zod"]);
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@aao\/(authorization|tool-runtime|mcp-connector|agent-runtime)/);
    expect(source).not.toMatch(/Date\.now|Math\.random|process\.env|fetch\(|require\(/);
  });
});
