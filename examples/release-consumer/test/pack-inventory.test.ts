import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPackInventory,
  inspectPackedPackage,
  inspectTarball,
  PACK_LIMITS,
} from "../../../scripts/pack-inventory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aao-pack-test-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function validManifest(extra = {}) {
  return JSON.stringify({ name: "@aao/test-pack", version: "0.0.0", private: true, ...extra });
}

function stageAndPack(files: Record<string, string>, setup?: (staging: string) => void): string {
  const dir = tempDir();
  const staging = join(dir, "staging");
  for (const [name, content] of Object.entries(files)) {
    const dest = join(staging, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  setup?.(staging);
  const tarball = join(dir, "package.tgz");
  execFileSync("tar", ["-czf", tarball, "package"], { cwd: staging });
  return tarball;
}

function requiredFiles(overrides: Record<string, string> = {}) {
  return {
    "package/package.json": validManifest(),
    "package/README.md": "# test",
    "package/LICENSE": "MIT License",
    "package/dist/index.js": "export const ok = true;\n",
    "package/dist/index.d.ts": "export declare const ok: boolean;\n",
    ...overrides,
  };
}

describe("assertPackInventory", () => {
  it("rejects a synthetic unexpected entry", () => {
    expect(() =>
      assertPackInventory([
        {
          name: "@aao/synthetic",
          unexpected: ["package/surprise.js"],
          findings: [],
          files: ["package/surprise.js"],
          forbidden: [],
        },
      ]),
    ).toThrow(/unexpected-path/);
  });

  it("rejects a package lacking an approved inclusion policy", () => {
    expect(() =>
      assertPackInventory([
        {
          name: "@aao/no-files-field",
          unexpected: [],
          findings: [{ rule: "missing-inclusion-policy", entry: null }],
          files: ["package/package.json"],
          forbidden: [],
        },
      ]),
    ).toThrow(/missing-inclusion-policy/);
  });
});

describe("inspectTarball", () => {
  it("accepts a legitimate compiled package layout", () => {
    const report = inspectTarball(stageAndPack(requiredFiles()));
    expect(report.findings).toEqual([]);
    expect(report.packedPrivate).toBe(true);
  });

  it("rejects an unexpected JavaScript file", () => {
    const report = inspectTarball(stageAndPack(requiredFiles({ "package/extra.js": "export {}\n" })));
    expect(report.unexpected).toContain("package/extra.js");
    expect(() => assertPackInventory([{ name: "@aao/test-pack", ...report }])).toThrow(/unexpected-path/);
  });

  it("rejects an unexpected document", () => {
    const report = inspectTarball(stageAndPack(requiredFiles({ "package/NOTES.md": "notes" })));
    expect(report.unexpected).toContain("package/NOTES.md");
    expect(() => assertPackInventory([{ name: "@aao/test-pack", ...report }])).toThrow(/unexpected-path/);
  });

  it("rejects a forbidden .env file", () => {
    const report = inspectTarball(stageAndPack(requiredFiles({ "package/.env": "TOKEN=x" })));
    expect(report.forbidden.some((entry: string) => entry.endsWith(".env"))).toBe(true);
    expect(() => assertPackInventory([{ name: "@aao/test-pack", ...report }])).toThrow(/forbidden-path/);
  });

  it("rejects private-key content in an otherwise allowed file without echoing the secret", () => {
    const report = inspectTarball(
      stageAndPack(requiredFiles({ "package/dist/index.js": "export const k = `-----BEGIN RSA PRIVATE KEY-----`;\n" })),
    );
    expect(report.contentFindings.some((item: { rule: string }) => item.rule === "private-key-block")).toBe(true);
    expect(() => assertPackInventory([{ name: "@aao/test-pack", ...report }])).toThrow(/private-key-block/);
    try {
      assertPackInventory([{ name: "@aao/test-pack", ...report }]);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/BEGIN RSA PRIVATE KEY/);
    }
  });

  it("rejects a high-confidence access token in packaged content", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const report = inspectTarball(stageAndPack(requiredFiles({ "package/dist/index.js": `export const t = "${token}";\n` })));
    expect(report.contentFindings.some((item: { rule: string }) => item.rule === "high-confidence-token")).toBe(true);
    expect(() => assertPackInventory([{ name: "@aao/test-pack", ...report }])).toThrow(/high-confidence-token/);
    try {
      assertPackInventory([{ name: "@aao/test-pack", ...report }]);
    } catch (error) {
      expect((error as Error).message).not.toContain(token);
    }
  });

  it("rejects missing required package metadata", () => {
    const report = inspectTarball(
      stageAndPack(requiredFiles({ "package/package.json": JSON.stringify({ name: "@aao/test-pack", version: "0.0.0" }) })),
    );
    expect(report.missingMetadata.some((item: { rule: string }) => item.rule === "package-not-private")).toBe(true);
    expect(() => assertPackInventory([{ name: "@aao/test-pack", ...report }])).toThrow(/package-not-private/);
  });

  it("rejects an unsafe archive entry", () => {
    const report = inspectTarball(
      stageAndPack(requiredFiles(), (staging) => {
        symlinkSync("/tmp/secret", join(staging, "package", "link"));
      }),
    );
    expect(report.unsafe.some((item: { rule: string }) => item.rule === "unsafe-archive-entry")).toBe(true);
    expect(() => assertPackInventory([{ name: "@aao/test-pack", ...report }])).toThrow(/unsafe-archive-entry/);
  });

  it("rejects an oversized archive entry", () => {
    const report = inspectTarball(
      stageAndPack(requiredFiles({ "package/dist/index.js": "x".repeat(PACK_LIMITS.maxEntryBytes + 1) })),
    );
    expect(report.oversized.some((item: { rule: string }) => item.rule === "oversized-archive-entry")).toBe(true);
    expect(() => assertPackInventory([{ name: "@aao/test-pack", ...report }])).toThrow(/oversized-archive-entry/);
  });

  it("rejects malformed archive metadata", () => {
    const dir = tempDir();
    const tarball = join(dir, "broken.tgz");
    writeFileSync(tarball, "this is not a gzip tar");
    const report = inspectTarball(tarball);
    expect(report.malformed).toBe(true);
    expect(() => assertPackInventory([{ name: "@aao/test-pack", ...report }])).toThrow(/malformed-archive/);
  });
});

describe("packed Local V1 packages", () => {
  it("accepts the framework and public-web integration tarballs", () => {
    const framework = inspectPackedPackage(join(root, "packages/framework"));
    const integration = inspectPackedPackage(join(root, "packages/integration-public-web"));
    expect(framework.hasFilesField).toBe(true);
    expect(integration.hasFilesField).toBe(true);
    expect(framework.workspaceDependencies?.length).toBeGreaterThan(0);
    expect(() => assertPackInventory([framework, integration])).not.toThrow();
  }, 30_000);
});
