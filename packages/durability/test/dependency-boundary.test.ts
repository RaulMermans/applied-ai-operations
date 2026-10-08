import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(pkg: string): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
  return walk(join(packagesDir, pkg, "src"));
}
function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
function imports(file: string): string[] {
  return [...code(file).matchAll(/^\s*(?:import|export)[^;\n]*\sfrom\s+["']([^"'.][^"']*)["']/gm)].map((match) => match[1]!);
}

describe("durability dependency direction (ADR-019)", () => {
  it.each(["runtime", "approval", "tool-runtime", "governance", "authorization", "contracts", "workflow-dsl"])("@aao/%s never depends on @aao/durability or the filesystem", (pkg) => {
    const manifest = JSON.parse(readFileSync(join(packagesDir, pkg, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })).not.toContain("@aao/durability");
    for (const file of sourceFiles(pkg)) {
      expect(imports(file)).not.toContain("@aao/durability");
      expect(imports(file).filter((specifier) => specifier === "node:fs" || specifier === "fs" || specifier === "node:fs/promises")).toEqual([]);
    }
  });

  it("@aao/durability depends only on contracts, runtime, approval, workflow-dsl, zod, and node built-ins", () => {
    const allowed = new Set(["@aao/contracts", "@aao/runtime", "@aao/approval", "@aao/workflow-dsl", "zod", "node:crypto", "node:fs", "node:path"]);
    for (const file of sourceFiles("durability")) {
      for (const specifier of imports(file)) expect(allowed.has(specifier), `${file} imports ${specifier}`).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(packagesDir, "durability", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@aao/approval", "@aao/contracts", "@aao/runtime", "@aao/workflow-dsl", "zod"]);
  });

  it("filesystem access is confined to the reference store; no global store, queue, worker, tracing, or memory", () => {
    for (const file of sourceFiles("durability")) {
      const text = code(file);
      if (!file.endsWith("file-store.ts")) expect(imports(file)).not.toContain("node:fs");
      // No module-level mutable state: every store and host is explicitly constructed.
      expect(text).not.toMatch(/^(?:let|var) /m);
      expect(text).not.toMatch(/^const \w+ = new (?:Map|Set|WeakMap)/m);
      for (const forbidden of ["opentelemetry", "redis", "bullmq", "kafka", "pg", "sqlite", "temporal", "embedding", "vector"]) expect(text.toLowerCase()).not.toContain(`"${forbidden}`);
    }
  });

  it("the Runtime has exactly one execution loop: resume and continuation enter runLoop", () => {
    const engine = code(join(packagesDir, "runtime", "src", "engine.ts"));
    expect(engine.match(/async function runLoop\(/g)).toHaveLength(1);
    expect(engine.match(/applyStatePatch\(/g)).toHaveLength(1);
    expect(engine.match(/return runLoop\(/g)).toHaveLength(3);
    expect(code(join(packagesDir, "runtime", "src", "reliability.ts")).match(/executor\.execute\(/g)).toHaveLength(1);
  });

  it("the Tool Runtime support gate is unchanged: only read_only and write_draft execute", () => {
    expect(code(join(packagesDir, "tool-runtime", "src", "permissions.ts"))).toContain('SUPPORTED_TOOL_PERMISSION_CLASSES: readonly PermissionClass[] = ["read_only", "write_draft"]');
  });
});
