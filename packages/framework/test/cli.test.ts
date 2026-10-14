import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { compileWorkflowSource } from "@aao/workflow-dsl";
import { installNetworkGuard } from "../src/cli/eval/network-guard.js";
import { HELP, runCli } from "../src/cli/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..", "..");
const fixtures = join(here, "fixtures", "workflows");
const cli = (...argv: string[]) => runCli(argv, { cwd: fixtures });
const repoCli = (...argv: string[]) => runCli(argv, { cwd: repositoryRoot });

const hashTree = (dir: string) => {
  const hash = createHash("sha256");
  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()) {
    try {
      hash.update(file).update(readFileSync(join(dir, file)));
    } catch {
      hash.update(`${file}/`);
    }
  }
  return hash.digest("hex");
};
const noStack = (text: string) => expect(text).not.toMatch(/\n\s+at\s|\.ts:\d+|node_modules|Error:/);

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

describe("aao --help and command errors", () => {
  it("--help lists exactly the implemented commands, nothing aspirational", async () => {
    const result = await cli("--help");
    expect(result).toEqual({ exitCode: 0, stdout: HELP, stderr: "" });
    const commands = [...HELP.matchAll(/^\s+aao (.+?)(?:\s+[[<-]|$)/gm)].map((match) => match[1]);
    expect(commands).toEqual(["workflow validate", "workflow compile", "eval ci", "eval adapters", "eval baseline propose", "--help"]);
    expect(HELP).not.toMatch(/aao (run|init|serve|deploy|publish|plugin|adapter)/);
    expect((await cli("eval", "ci", "--help")).exitCode).toBe(0);
  });

  it("no arguments prints usage to stderr and exits 1", async () => {
    expect(await cli()).toEqual({ exitCode: 1, stdout: "", stderr: HELP });
  });

  it.each([
    [["run", "valid.yaml"], "AAO_CLI_UNKNOWN_COMMAND"],
    [["init"], "AAO_CLI_UNKNOWN_COMMAND"],
    [["workflow", "execute", "valid.yaml"], "AAO_CLI_UNKNOWN_COMMAND"],
    [["eval", "dashboard"], "AAO_CLI_UNKNOWN_COMMAND"],
    [["eval", "baseline", "accept"], "AAO_CLI_UNKNOWN_COMMAND"],
    [["--plugin", "./x.js"], "AAO_CLI_UNKNOWN_OPTION"],
    [["workflow", "validate", "valid.yaml", "--strict"], "AAO_CLI_UNKNOWN_OPTION"],
    [["eval", "ci", "--accept-all"], "AAO_CLI_UNKNOWN_OPTION"],
    [["workflow", "validate"], "AAO_CLI_MISSING_ARGUMENT"],
    [["workflow", "validate", "valid.yaml", "extra.yaml"], "AAO_CLI_UNEXPECTED_ARGUMENT"],
    [["workflow", "validate", "valid.yaml", "--format", "xml"], "AAO_CLI_INVALID_OPTION"],
    [["eval", "baseline", "propose", "--id", "x"], "AAO_CLI_MISSING_ARGUMENT"],
  ])("%j → exit 1, %s, concise stderr, no stack", async (argv, code) => {
    const result = await cli(...argv);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.startsWith(`ERROR ${code}: `)).toBe(true);
    expect(result.stderr.split("\n").length).toBeLessThanOrEqual(3);
    noStack(result.stderr);
  });
});

describe("aao workflow validate", () => {
  it.each([["valid.yaml", "VALID cli.approved-update@1.0.0\n"], ["valid.yml", "VALID cli.approved-update@1.0.0\n"], ["valid.json", "VALID cli.direct-draft@2.1.0\n"]])("%s → VALID with id@version", async (file, stdout) => {
    expect(await cli("workflow", "validate", file)).toEqual({ exitCode: 0, stdout, stderr: "" });
  });

  it("an invalid graph prints the canonical diagnostics and exits 1", async () => {
    const result = await cli("workflow", "validate", "invalid-graph.yaml");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('INVALID invalid-graph.yaml\n  DUPLICATE_NODE_ID node=start: Node id "start" is used by more than one node.\n  UNREACHABLE_NODE node=orphan: Node "orphan" is not reachable from entryNodeId "start".\n');
  });

  it("invalid YAML is a single-line PARSE_ERROR that never echoes source content", async () => {
    const result = await cli("workflow", "validate", "invalid-syntax.yaml");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^INVALID invalid-syntax\.yaml\n {2}PARSE_ERROR: Invalid YAML source: [^\n]*\n$/);
    expect(result.stdout).not.toContain("sk-live");
    noStack(result.stdout);
  });

  it("schema errors are anchored to the node and path", async () => {
    const result = await cli("workflow", "validate", "invalid-schema.json");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("SCHEMA_VALIDATION_ERROR node=a path=nodes.0.kind:");
  });

  it("--format json is machine-readable with canonical diagnostics", async () => {
    expect(JSON.parse((await cli("workflow", "validate", "valid.json", "--format", "json")).stdout)).toEqual({ valid: true, workflow: { id: "cli.direct-draft", version: "2.1.0" } });
    const invalid = await cli("workflow", "validate", "invalid-graph.yaml", "--format", "json");
    expect(invalid.exitCode).toBe(1);
    const canonical = compileWorkflowSource(readFileSync(join(fixtures, "invalid-graph.yaml"), "utf8"), "yaml");
    expect(JSON.parse(invalid.stdout)).toEqual({ valid: false, diagnostics: canonical.ok ? [] : canonical.diagnostics });
  });

  it("refuses unsupported file types, missing files, and directories", async () => {
    expect((await cli("workflow", "validate", "notes.txt")).stderr).toContain("AAO_CLI_UNSUPPORTED_FILE_TYPE");
    expect((await cli("workflow", "validate", "missing.yaml")).stderr).toContain("AAO_CLI_FILE_NOT_READABLE");
    const dir = mkdtempSync(join(tmpdir(), "aao-cli-"));
    temporary.push(dir);
    cpSync(fixtures, join(dir, "folder.yaml"), { recursive: true });
    expect((await runCli(["workflow", "validate", "folder.yaml"], { cwd: dir })).stderr).toContain("AAO_CLI_FILE_NOT_READABLE");
    writeFileSync(join(dir, "huge.json"), " ".repeat(1024 * 1024 + 1));
    expect((await runCli(["workflow", "validate", "huge.json"], { cwd: dir })).stderr).toContain("AAO_CLI_FILE_TOO_LARGE");
  });
});

describe("aao workflow compile", () => {
  it("prints the canonical compiled plan JSON to stdout, deterministically, and writes no file", async () => {
    const before = hashTree(fixtures);
    const first = await cli("workflow", "compile", "valid.yaml");
    expect(first.exitCode).toBe(0);
    const canonical = compileWorkflowSource(readFileSync(join(fixtures, "valid.yaml"), "utf8"), "yaml");
    expect(JSON.parse(first.stdout)).toEqual(canonical.ok ? canonical.plan : undefined);
    expect((await cli("workflow", "compile", "valid.yaml", "--format", "json")).stdout).toBe(first.stdout);
    expect(hashTree(fixtures)).toBe(before);
  });

  it("an invalid workflow leaves stdout empty and reports diagnostics on stderr", async () => {
    const result = await cli("workflow", "compile", "invalid-graph.yaml");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("UNREACHABLE_NODE node=orphan");
    expect((await cli("workflow", "compile", "valid.yaml", "--format", "text")).stderr).toContain("AAO_CLI_INVALID_OPTION");
  });
});

describe("aao eval", () => {
  it("eval ci → PASS, text and JSON; deterministic; evals/ untouched", async () => {
    const before = hashTree(join(repositoryRoot, "evals"));
    const text = await repoCli("eval", "ci");
    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toMatch(/^AAO Eval Gate\n[\s\S]*Cases: 35\/35 matched[\s\S]*\nPASS\n$/);
    const [a, b] = [await repoCli("eval", "ci", "--format", "json"), await repoCli("--", "eval", "ci", "--", "--format", "json")];
    expect(a.stdout).toBe(b.stdout);
    expect(JSON.parse(a.stdout)).toMatchObject({ gate: { passed: true, outcome: "PASS" }, cases: { total: 35, matched: 35 } });
    expect(hashTree(join(repositoryRoot, "evals"))).toBe(before);
  });

  it("eval ci → hard failure exits 1 on a genuine critical regression (temporary copy of evals/)", async () => {
    const root = mkdtempSync(join(tmpdir(), "aao-eval-"));
    temporary.push(root);
    cpSync(join(repositoryRoot, "evals"), join(root, "evals"), { recursive: true });
    const dataset = join(root, "evals", "datasets", "runtime-foundation.v2.yaml");
    const source = readFileSync(dataset, "utf8");
    const regressed = source.replace("expected: { status: failed, reasonCodes: [TRACE_SEQUENCE_GAP] }", "expected: { status: passed }");
    expect(regressed).not.toBe(source);
    writeFileSync(dataset, regressed);
    const result = await runCli(["eval", "ci", "--root", root], { cwd: fixtures });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("FAIL EVAL_GATE_CRITICAL_REGRESSION");
    expect(result.stdout.trimEnd().endsWith("FAIL")).toBe(true);
  });

  it("eval ci → a missing eval root is a GATE ERROR, never a regression", async () => {
    const empty = mkdtempSync(join(tmpdir(), "aao-empty-"));
    temporary.push(empty);
    const result = await runCli(["eval", "ci", "--root", empty], { cwd: empty });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("GATE ERROR");
    expect(result.stdout).toContain("No trustworthy comparison occurred.");
    noStack(result.stdout);
  });

  it("eval adapters → PASS across native Tool, MCP, native model, and Vercel AI SDK (LangGraph is not a driver)", async () => {
    const result = await repoCli("eval", "adapters");
    expect(result.exitCode).toBe(0);
    for (const id of ["aao.native-tool (tool)", "aao.mcp-connector (tool)", "aao.native-model (model)", "aao.vercel-ai-sdk (model)"]) expect(result.stdout).toContain(id);
    expect(result.stdout).not.toMatch(/langgraph/i);
    expect(result.stdout.trimEnd().endsWith("PASS")).toBe(true);
  }, 60_000);

  it("eval baseline propose → a proposal on stdout, nothing written", async () => {
    const before = hashTree(join(repositoryRoot, "evals"));
    const result = await repoCli("eval", "baseline", "propose", "--id", "runtime-foundation", "--version", "1.0.0");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "aao.eval-baseline-proposal", unmatchedCases: [], baselineRef: { id: "runtime-foundation", version: "1.0.0" } });
    expect(hashTree(join(repositoryRoot, "evals"))).toBe(before);
  });

  it("the offline guard refuses and records network access, and is removed after each command", async () => {
    const original = globalThis.fetch;
    const guard = installNetworkGuard();
    try {
      await expect(Promise.resolve().then(() => fetch("https://example.invalid"))).rejects.toThrow("AAO_EVAL_NETWORK_FORBIDDEN");
      expect(guard.attempts()).toEqual(["fetch"]);
    } finally {
      guard.uninstall();
    }
    expect(globalThis.fetch).toBe(original);
    await repoCli("eval", "ci");
    expect(globalThis.fetch).toBe(original);
  });
});
