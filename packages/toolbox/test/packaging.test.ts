import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;

describe("@aao/toolbox package manifest (packaged as if publishable; not published)", () => {
  it("exposes exactly the root, typed from compiled declarations — never repository src/", () => {
    expect(manifest.exports).toEqual({ ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./package.json": "./package.json" });
    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.main).toBe("./dist/index.js");
    expect(JSON.stringify(manifest)).not.toMatch(/\.\/src\//);
  });

  it("allowlists only compiled output and the README: no tests, fixtures, scripts, maps, logs, or env files", () => {
    expect(manifest.files).toEqual(["dist/**/*.js", "dist/**/*.d.ts", "README.md"]);
  });

  it("stays private (no accidental publication), has no bin or install hook, and pins the repository's Node range", () => {
    expect(manifest.private).toBe(true);
    expect(manifest.bin).toBeUndefined();
    expect(Object.keys(manifest.scripts as object).filter((name) => /install|prepare|publish/.test(name))).toEqual([]);
    expect(manifest.engines).toEqual({ node: ">=20.20.0 <21.0.0" });
  });
});
