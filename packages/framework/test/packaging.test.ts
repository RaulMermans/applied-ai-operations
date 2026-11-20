import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;

describe("@aao/framework package manifest (packaged as if publishable; not published)", () => {
  it("exposes exactly the root and the explicit conformance subpath, typed from compiled declarations — never repository src/", () => {
    expect(manifest.exports).toEqual({ ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./conformance": { types: "./dist/conformance/index.d.ts", default: "./dist/conformance/index.js" }, "./package.json": "./package.json" });
    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.main).toBe("./dist/index.js");
    expect(JSON.stringify(manifest)).not.toMatch(/\.\/src\//);
  });

  it("ships the aao executable from compiled TypeScript", () => {
    expect(manifest.bin).toEqual({ aao: "./dist/cli/main.js" });
    expect(readFileSync(join(packageRoot, "src", "cli", "main.ts"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("allowlists only compiled output and the README: no tests, fixtures, maps, reports, logs, or env files", () => {
    expect(manifest.files).toEqual(["dist/**/*.js", "dist/**/*.d.ts", "README.md", "LICENSE"]);
  });

  it("stays private (no accidental publication) and pins the repository's Node range", () => {
    expect(manifest.private).toBe(true);
    expect(manifest.engines).toEqual({ node: ">=20.20.0 <21.0.0" });
    expect(Object.keys(manifest.dependencies as object).every((name) => name.startsWith("@aao/"))).toBe(true);
  });
});
