import { describe, expect, it } from "vitest";
import { ToolboxError, coreToolbox, describeToolbox, getToolboxEntry, listToolboxEntries, searchToolbox, selectToolboxTools } from "../src/index.js";
import { CORE_IDS, ref } from "./support.js";

const ids = (results: readonly { toolRef: { id: string } }[]) => results.map((result) => result.toolRef.id);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolboxError) return error.code;
    throw error;
  }
  throw new Error("expected a ToolboxError");
};

/** Anything executable or private that must never appear in a catalog result. */
function expectNoExecutableState(value: unknown) {
  const json = JSON.stringify(value);
  expect(JSON.parse(json)).toEqual(value); // JSON-safe: nothing dropped by serialization (no function, class instance, or symbol)
  expect(json).not.toMatch(/"handler"|execute|=>|function|retrySafety|grantedPermissionClasses|principal|authorization|\.ts"|\.js"|src\/|dist\//);
}

describe("listToolboxEntries / getToolboxEntry", () => {
  it("lists every entry, ordered by exact Tool ref", () => {
    expect(ids(listToolboxEntries(coreToolbox))).toEqual(["records.count_by", "records.dedupe", "records.project", "records.sort", "text.chunk", "text.normalize"]);
  });

  it("filters by category, tag, and status", () => {
    expect(ids(listToolboxEntries(coreToolbox, { category: "text" }))).toEqual(["text.chunk", "text.normalize"]);
    expect(ids(listToolboxEntries(coreToolbox, { tag: "dedupe" }))).toEqual(["records.dedupe"]);
    expect(listToolboxEntries(coreToolbox, { status: "deprecated" })).toEqual([]);
    expect(listToolboxEntries(coreToolbox, { category: "network" })).toEqual([]);
    expect(codeOf(() => listToolboxEntries(coreToolbox, { owner: "x" } as never))).toBe("TOOLBOX_QUERY_INVALID");
  });

  it("gets an exact ref; a missing Tool or version is undefined; a non-exact ref is invalid", () => {
    const entry = getToolboxEntry(coreToolbox, ref("records.dedupe"))!;
    expect(entry).toMatchObject({ toolRef: ref("records.dedupe"), category: "records", status: "active", permissionClasses: ["read_only"], name: "Deduplicate records by exact key values" });
    expect(entry.description).toContain("no side effects");
    expect(getToolboxEntry(coreToolbox, ref("records.merge"))).toBeUndefined();
    expect(getToolboxEntry(coreToolbox, { id: "records.dedupe", version: "1.0.1" })).toBeUndefined();
    expect(codeOf(() => getToolboxEntry(coreToolbox, { id: "records.dedupe", version: "latest" }))).toBe("TOOLBOX_QUERY_INVALID");
    expect(codeOf(() => getToolboxEntry(coreToolbox, { id: "records.dedupe", version: "^1.0.0" }))).toBe("TOOLBOX_QUERY_INVALID");
  });

  it("catalog entries carry no handler, validator, source, or runtime state", () => {
    expectNoExecutableState(listToolboxEntries(coreToolbox));
    expectNoExecutableState(getToolboxEntry(coreToolbox, ref("text.chunk")));
  });
});

describe("searchToolbox", () => {
  it("an exact id ranks that Tool first", () => {
    for (const id of CORE_IDS) expect(ids(searchToolbox(coreToolbox, { query: id }))[0], id).toBe(id);
  });

  it("matches tags, descriptions, whenToUse, and examples", () => {
    expect(searchToolbox(coreToolbox, { query: "duplicates" })[0]).toMatchObject({ toolRef: ref("records.dedupe"), category: "records", matchedFields: expect.arrayContaining(["tags", "description"]) });
    expect(ids(searchToolbox(coreToolbox, { query: "histogram" }))).toEqual(["records.count_by"]);
    expect(ids(searchToolbox(coreToolbox, { query: "surrogate pair" }))[0]).toBe("text.chunk");
    expect(searchToolbox(coreToolbox, { query: "Unicode normalization form" })[0]!.toolRef).toEqual(ref("text.normalize"));
    expect(searchToolbox(coreToolbox, { query: "neighbouring overlap" })[0]).toMatchObject({ toolRef: ref("text.chunk"), matchedFields: expect.arrayContaining(["whenToUse"]) });
    expect(searchToolbox(coreToolbox, { query: "tickets" })[0]).toMatchObject({ toolRef: ref("records.count_by"), matchedFields: ["examples"] });
    expect(searchToolbox(coreToolbox, { query: "collation" })[0]).toMatchObject({ toolRef: ref("records.sort"), matchedFields: expect.arrayContaining(["whenNotToUse"]) });
  });

  it("prefix matching applies to terms of three or more characters; case is ignored", () => {
    expect(ids(searchToolbox(coreToolbox, { query: "DEDUP" }))[0]).toBe("records.dedupe");
    expect(searchToolbox(coreToolbox, { query: "zz" })).toEqual([]);
  });

  it("filters by category, tag, and status, and honors limit (default 5, max 20)", () => {
    expect(ids(searchToolbox(coreToolbox, { query: "records text", category: "text" })).sort()).toEqual(["text.chunk", "text.normalize"]);
    expect(ids(searchToolbox(coreToolbox, { query: "records", tag: "sort" }))).toEqual(["records.sort"]);
    expect(searchToolbox(coreToolbox, { query: "records", status: "deprecated" })).toEqual([]);
    expect(searchToolbox(coreToolbox, { query: "text records side effects" })).toHaveLength(5);
    expect(searchToolbox(coreToolbox, { query: "text records side effects", limit: 20 })).toHaveLength(6);
    expect(searchToolbox(coreToolbox, { query: "text records side effects", limit: 2 })).toHaveLength(2);
    for (const limit of [0, 21, 2.5]) expect(codeOf(() => searchToolbox(coreToolbox, { query: "text", limit }))).toBe("TOOLBOX_QUERY_INVALID");
  });

  it("ties break deterministically by exact Tool ref", () => {
    // Every Core description says "Pure computation: no side effects": equal scores, so ref order decides.
    const results = searchToolbox(coreToolbox, { query: "pure computation", limit: 20 });
    expect(new Set(results.map((result) => result.score)).size).toBe(1);
    expect(ids(results)).toEqual(["records.count_by", "records.dedupe", "records.project", "records.sort", "text.chunk", "text.normalize"]);
  });

  it("is deterministic: the same query yields the same ordered results and scores", () => {
    const queries = ["remove duplicate records", "split long text", "count status", "sort by score", "normalize unicode whitespace"];
    for (const query of queries) {
      const first = searchToolbox(coreToolbox, { query, limit: 20 });
      for (let i = 0; i < 5; i += 1) expect(searchToolbox(coreToolbox, { query, limit: 20 }), query).toEqual(first);
    }
  });

  it("an empty, punctuation-only, oversized, or over-tokenized query is rejected", () => {
    expect(codeOf(() => searchToolbox(coreToolbox, { query: "" }))).toBe("TOOLBOX_QUERY_INVALID");
    expect(codeOf(() => searchToolbox(coreToolbox, { query: "   ...!? " }))).toBe("TOOLBOX_QUERY_INVALID");
    expect(codeOf(() => searchToolbox(coreToolbox, { query: "x".repeat(257) }))).toBe("TOOLBOX_QUERY_INVALID");
    expect(() => searchToolbox(coreToolbox, { query: "x".repeat(256) })).not.toThrow();
    expect(codeOf(() => searchToolbox(coreToolbox, { query: Array.from({ length: 33 }, (_, i) => `t${i}`).join(" ") }))).toBe("TOOLBOX_QUERY_INVALID");
    expect(codeOf(() => searchToolbox(coreToolbox, { query: 42 } as never))).toBe("TOOLBOX_QUERY_INVALID");
  });

  it("results are identity, category, status, score, and matched fields only — never a handler or authority", () => {
    const results = searchToolbox(coreToolbox, { query: "records", limit: 20 });
    for (const result of results) expect(Object.keys(result).sort()).toEqual(["category", "matchedFields", "score", "status", "toolRef"]);
    expectNoExecutableState(results);
    expect(Object.isFrozen(results) && Object.isFrozen(results[0])).toBe(true);
  });
});

describe("selectToolboxTools", () => {
  it("resolves exact refs, in the order given, to frozen Tool definitions", () => {
    const tools = selectToolboxTools(coreToolbox, [ref("text.chunk"), ref("records.dedupe")]);
    expect(tools.map((tool) => `${tool.spec.id}@${tool.spec.version}`)).toEqual(["text.chunk@1.0.0", "records.dedupe@1.0.0"]);
    expect(Object.isFrozen(tools)).toBe(true);
    for (const tool of tools) expect(tool.retrySafety).toBe("safe");
  });

  it("refuses unknown Tools, non-exact versions, duplicates, and empty or oversized lists", () => {
    expect(codeOf(() => selectToolboxTools(coreToolbox, [ref("records.merge")]))).toBe("TOOLBOX_TOOL_NOT_FOUND");
    expect(codeOf(() => selectToolboxTools(coreToolbox, [{ id: "records.dedupe", version: "2.0.0" }]))).toBe("TOOLBOX_TOOL_NOT_FOUND");
    expect(codeOf(() => selectToolboxTools(coreToolbox, [{ id: "records.dedupe", version: "latest" }]))).toBe("TOOLBOX_QUERY_INVALID");
    expect(codeOf(() => selectToolboxTools(coreToolbox, [ref("records.dedupe"), ref("records.dedupe")]))).toBe("TOOLBOX_QUERY_INVALID");
    expect(codeOf(() => selectToolboxTools(coreToolbox, []))).toBe("TOOLBOX_QUERY_INVALID");
  });
});

describe("describeToolbox", () => {
  it("is static JSON from the manifest and the canonical Tool specs, with no authority", () => {
    const description = describeToolbox(coreToolbox);
    expect(description).toMatchObject({ schemaVersion: 1, kind: "aao.toolbox-catalog", authority: "none", toolbox: { id: "aao.core", version: "1.0.0", fingerprint: coreToolbox.fingerprint } });
    expect(description.tools).toHaveLength(6);
    for (const tool of description.tools) {
      const [definition] = selectToolboxTools(coreToolbox, [tool.toolRef]);
      expect(tool.permissionClasses).toEqual(definition!.spec.permissionClasses);
      expect(tool.inputSchema).toEqual(definition!.spec.inputSchema);
      expect(tool.outputSchema).toEqual(definition!.spec.outputSchema);
      expect(tool.description).toBe(definition!.spec.description);
      expect(tool.retrySafety).toBe("safe");
      expect(tool.idempotency).toBe("none");
    }
    expect(JSON.parse(JSON.stringify(description))).toEqual(description);
    expect(JSON.stringify(description)).not.toMatch(/"handler"|execute\(|=>|function |src\/|dist\/|\.ts"/);
  });

  it("is identical across calls", () => {
    expect(describeToolbox(coreToolbox)).toEqual(describeToolbox(coreToolbox));
  });
});
