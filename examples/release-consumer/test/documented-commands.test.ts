import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_SCRIPTS, assertDocumentedCommands, readDocumentedCommands } from "../../../scripts/documented-commands.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(scripts: Record<string, string>, docs: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "aao-docs-cmd-"));
  temps.push(root);
  mkdirSync(join(root, "docs/guides"), { recursive: true });
  mkdirSync(join(root, "docs/engineering"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(root, "README.md"), docs.readme ?? "");
  writeFileSync(join(root, "CONTRIBUTING.md"), docs.contributing ?? "");
  writeFileSync(join(root, "docs/guides/getting-started-local-v1.md"), docs.gettingStarted ?? "");
  writeFileSync(join(root, "docs/engineering/local-development.md"), docs.localDev ?? "");
  return root;
}

function requiredScripts(): Record<string, string> {
    return Object.fromEntries(REQUIRED_SCRIPTS.map((name: string) => [name, `echo ${name}`]));
}

function documentAll(scripts: string[]): { readme: string; contributing: string; gettingStarted: string; localDev: string } {
  const body = scripts.map((name: string) => `pnpm ${name}`).join("\n");
  return { readme: body, contributing: "internal", gettingStarted: body, localDev: body };
}

describe("documented commands", () => {
  it("fails when a required script is missing", () => {
    const scripts = requiredScripts();
    delete scripts.check;
    const root = fixture(scripts, documentAll(REQUIRED_SCRIPTS.filter((name: string) => name !== "check")));
    expect(() => assertDocumentedCommands(root)).toThrow(/missing scripts: check/);
  });

  it("fails when a required script exists but is undocumented", () => {
    const documented = REQUIRED_SCRIPTS.filter((name: string) => name !== "lint");
    const root = fixture(requiredScripts(), documentAll(documented));
    expect(() => assertDocumentedCommands(root)).toThrow(/undocumented: lint/);
  });

  it("fails on the wrong command spelling", () => {
    const docs = documentAll(REQUIRED_SCRIPTS);
    docs.readme = docs.readme.replace("pnpm check", "pnpm chek");
    docs.gettingStarted = docs.gettingStarted.replace("pnpm check", "pnpm chek");
    docs.localDev = docs.localDev.replace("pnpm check", "pnpm chek");
    const root = fixture(requiredScripts(), docs);
    expect(() => assertDocumentedCommands(root)).toThrow(/undocumented: check/);
  });

  it("passes the current repository documented commands", () => {
    expect(() => assertDocumentedCommands(repositoryRoot)).not.toThrow();
    const result = readDocumentedCommands(repositoryRoot);
    expect(result.missing).toEqual([]);
    expect(result.undocumented).toEqual([]);
  });

  it("does not treat a legitimate internal-only command as a release blocker", () => {
    const scripts = { ...requiredScripts(), "dev:control-plane": "echo internal", "test:watch": "echo watch" };
    const root = fixture(scripts, documentAll(REQUIRED_SCRIPTS));
    expect(() => assertDocumentedCommands(root)).not.toThrow();
  });
});
