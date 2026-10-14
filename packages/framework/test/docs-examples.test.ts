import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// The quickstart is executable documentation: every ```ts block is type-checked
// against the public surface only and run, so the docs cannot drift from reality.
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..");
const quickstart = readFileSync(join(repositoryRoot, "docs", "framework", "quickstart.md"), "utf8");
const examples = [...quickstart.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!);
const outDir = join(here, "consumer", ".out", "docs");

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("docs/framework/quickstart.md", () => {
  it("has two examples, each importing only @aao/framework", () => {
    expect(examples).toHaveLength(2);
    for (const example of examples) expect([...example.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])).toEqual(["@aao/framework"]);
  });

  it("type-checks against the public surface", () => {
    mkdirSync(outDir, { recursive: true });
    const files = examples.map((example, index) => {
      const file = join(outDir, `example-${index + 1}.ts`);
      writeFileSync(file, `${example}\nexport {};\n`);
      return file;
    });
    writeFileSync(join(outDir, "tsconfig.json"), JSON.stringify({ extends: "../../../../../../tsconfig.base.json", compilerOptions: { noEmit: true, paths: { "@aao/framework": ["../../../../src/index.ts"] } }, files: files.map((file) => file.slice(outDir.length + 1)) }));
    const tsc = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
    expect(() => execFileSync(process.execPath, [tsc, "-p", join(outDir, "tsconfig.json")], { stdio: "pipe" })).not.toThrow();
  }, 60_000);

  it("runs and prints exactly what the comments promise", async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args); });
    try {
      for (const [index, example] of examples.entries()) {
        const file = join(outDir, `run-${index + 1}.ts`);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(file, `${example}\nexport {};\n`);
        await import(pathToFileURL(file).href);
      }
    } finally {
      spy.mockRestore();
    }
    expect(logged).toEqual([[true, "COMPLETED"], ["WAITING_FOR_APPROVAL"], ["COMPLETED"]]);
  });
});
