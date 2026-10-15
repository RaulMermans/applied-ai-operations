import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packages = join(dirname(fileURLToPath(import.meta.url)), "../..");
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);
}
function code(path: string) { return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }

describe("production MCP anti-corruption boundary", () => {
  it("only mcp-connector declares the MCP SDK in production; research stays separate", () => {
    const owners = readdirSync(packages).filter((name) => !name.startsWith("substrate-")).filter((name) => {
      const manifest = JSON.parse(readFileSync(join(packages, name, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      return Object.keys(manifest.dependencies ?? {}).some((dependency) => dependency.startsWith("@modelcontextprotocol/"));
    });
    expect(owners).toEqual(["mcp-connector"]);
  });

  it.each(["contracts", "runtime", "agent-runtime", "authorization", "tool-runtime", "workflow-dsl", "model-runtime"])("%s cannot reach connector infrastructure or SDK types", (name) => {
    for (const path of sources(join(packages, name, "src"))) expect(code(path)).not.toMatch(/@modelcontextprotocol|@aao\/mcp-connector|client\.callTool|McpSession|McpStdioConfig/);
    const manifest = JSON.parse(readFileSync(join(packages, name, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@aao/mcp-connector");
  });

  it("connector dependencies point downwards and public exports contain no SDK type or invoke API", () => {
    const root = join(packages, "mcp-connector");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@aao/adapters", "@aao/contracts", "@aao/tool-runtime", "@modelcontextprotocol/sdk", "zod"]);
    expect(code(join(root, "src/index.ts"))).not.toMatch(/@modelcontextprotocol|resolveSessionBinding|invoke|Transport|CallToolResult|ListToolsResult|\bClient\b/);
    const files = sources(join(root, "src"));
    expect(files.filter((path) => code(path).includes("client.callTool("))).toEqual([join(root, "src/session.ts")]);
    for (const path of files) {
      // The connector may *declare* host retry safety and report a transient failure as retryable; it never retries itself.
      expect(code(path)).not.toMatch(/authorize\(|createToolRegistry|\.register\(|process\.env|console\.|node:fs|node:child_process|StreamableHTTP|OAuth|Promise\.race|setTimeout|retry(?!Safety|able)|maxAttempts|for\s*\(.*attempt|reconnect|sqlite|postgres|AgentDecision|\.(?:idempotentHint|readOnlyHint|destructiveHint|annotations|_meta)\b/);
    }
  });
});
