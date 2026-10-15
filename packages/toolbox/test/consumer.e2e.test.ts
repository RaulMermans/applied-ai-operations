import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runConsumerScenarios } from "./consumer/app.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Code only: comments may mention lower-level packages; imports may not. */
const consumerSource = readFileSync(join(here, "consumer", "app.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let outcome: Awaited<ReturnType<typeof runConsumerScenarios>>;
beforeAll(async () => {
  outcome = await runConsumerScenarios();
});

describe("consumer fixture: public imports only", () => {
  it("imports nothing but @aao/framework and @aao/toolbox", () => {
    const specifiers = [...consumerSource.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gms)].map((match) => match[1]);
    expect(specifiers).toEqual(["@aao/framework", "@aao/toolbox"]);
    expect(consumerSource).not.toMatch(/@aao\/(?!framework["']|toolbox["'])|from\s+["']\.|require\(|import\(/);
  });

  it("type-checks with TypeScript against the public surfaces only", () => {
    const tsc = join(here, "..", "..", "..", "node_modules", "typescript", "bin", "tsc");
    expect(() => execFileSync(process.execPath, [tsc, "-p", join(here, "consumer", "tsconfig.source.json")], { stdio: "pipe" })).not.toThrow();
  }, 60_000);
});

describe("consumer E2E: Toolbox Tools through the normal governed path", () => {
  it("discovery finds records.dedupe first", () => {
    expect(outcome.discovered[0]).toBe("records.dedupe");
  });

  it("records.dedupe → records.project completes with canonical state and each Tool called once", () => {
    expect(outcome.accounts.summary).toMatchObject({ ok: true, status: "COMPLETED" });
    expect(outcome.accounts.projected).toEqual({ status: "success", data: { records: [{ id: "a-1", name: "Acme" }, { id: "a-2", name: "Globex" }] }, meta: { recordCount: 2, fields: ["id", "name"], missing: [{ field: "id", count: 0 }, { field: "name", count: 0 }] } });
    expect(outcome.accounts.calls).toEqual(["records.dedupe", "records.project"]);
  });

  it("text.normalize → text.chunk completes with deterministic chunks", () => {
    expect(outcome.notes.summary).toMatchObject({ ok: true, status: "COMPLETED" });
    const normalized = "Toolbox Tools\nrun through the\n\nnormal Tool Runtime.";
    const chunks = outcome.notes.chunks!;
    chunks.forEach((chunk, index) => {
      expect(chunk.text).toBe(normalized.slice(chunk.start, chunk.end));
      expect(chunk.end - chunk.start).toBeLessThanOrEqual(16);
      if (index > 0) expect(chunks[index - 1]!.end - chunk.start).toBe(4);
    });
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(normalized.length);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["Toolbox Tools\nru", "s\nrun through th", "h the\n\nnormal To", "l Tool Runtime."]);
  });

  it("a principal without read_only is denied canonically with zero handler starts", () => {
    expect(outcome.denied.summary).toMatchObject({ ok: false, status: "FAILED", failure: "NODE_EXECUTION_FAILED", executorFailure: "TOOL_AUTHORIZATION_DENIED" });
    expect(outcome.denied.starts).toBe(0);
  });

  it("a discoverable Tool that the host never selected is not executable", () => {
    expect(outcome.unselected.discoverable).toBe("records.sort");
    expect(outcome.unselected.summary).toMatchObject({ ok: false, failure: "RUNTIME_PREFLIGHT_FAILED" });
    expect(outcome.started).not.toContain("records.sort");
  });

  it("a consumer-defined Toolbox Tool runs through the same path", () => {
    expect(outcome.greeting).toEqual({ summary: expect.objectContaining({ ok: true, status: "COMPLETED" }), output: { greeting: "Hello, Ada!" } });
  });
});
