import { defineTool, type ToolDefinition } from "@aao/framework";
import { describe, expect, it } from "vitest";
import { ToolboxError, coreToolbox, defineToolbox, getToolboxEntry, listToolboxEntries, searchToolbox, selectToolboxTools, type ToolboxEntryInput, type ToolboxManifestInput } from "../src/index.js";
import { ref } from "./support.js";

const DESCRIPTION = "Returns the supplied greeting unchanged. Use it in tests only. No side effects; pure computation.";

function makeTool(id: string, version = "1.0.0", overrides: Record<string, unknown> = {}): ToolDefinition {
  const readOnly = overrides.permissionClasses === undefined;
  return defineTool({
    spec: { schemaVersion: 1, id, version, name: `Tool ${id}`, description: DESCRIPTION, inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["read_only"], ...overrides },
    handler: { execute: async () => ({ ok: true, output: {} }) },
    // The canonical rule: retrySafety "safe" is valid only for read_only Tools.
    ...(readOnly ? { retrySafety: "safe" as const } : {}),
  });
}

function entry(id: string, version = "1.0.0", overrides: Partial<ToolboxEntryInput> = {}): ToolboxEntryInput {
  return { toolRef: { id, version }, category: "testing", tags: ["echo"], whenToUse: ["When a test needs it."], whenNotToUse: ["In production."], examples: [{ title: "Echo", input: { greeting: "hi" } }], ...overrides };
}

const manifest = (entries: ToolboxEntryInput[], overrides: Partial<ToolboxManifestInput> = {}): ToolboxManifestInput => ({ id: "acme.test", version: "1.0.0", name: "Test Toolbox", description: "A custom Toolbox for tests.", entries, ...overrides });

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolboxError);
    return { code: (error as ToolboxError).code, issues: (error as ToolboxError).issues };
  }
  throw new Error("expected a ToolboxError");
};

describe("defineToolbox: valid manifests", () => {
  it("defines a custom Toolbox from normal AAO Tool definitions", () => {
    const toolbox = defineToolbox({ manifest: manifest([entry("acme.echo"), entry("acme.other")]), tools: [makeTool("acme.other"), makeTool("acme.echo")] });
    expect(toolbox.ref).toEqual({ id: "acme.test", version: "1.0.0" });
    expect(toolbox.manifest.schemaVersion).toBe(1);
    expect(toolbox.manifest.entries.map((item) => item.toolRef.id)).toEqual(["acme.echo", "acme.other"]);
    expect(toolbox.manifest.entries[0]!.status).toBe("active");
    expect(toolbox.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("the Core Toolbox is aao.core@1.0.0 with six read_only Tools", () => {
    expect(coreToolbox.ref).toEqual({ id: "aao.core", version: "1.0.0" });
    expect(listToolboxEntries(coreToolbox).map((item) => `${item.toolRef.id}@${item.toolRef.version}`)).toEqual(["records.count_by@1.0.0", "records.dedupe@1.0.0", "records.project@1.0.0", "records.sort@1.0.0", "text.chunk@1.0.0", "text.normalize@1.0.0"]);
    for (const item of listToolboxEntries(coreToolbox)) expect(item.permissionClasses).toEqual(["read_only"]);
  });

  it("a deprecated entry may name a replacement in the same Toolbox; both stay explicitly selectable", () => {
    const toolbox = defineToolbox({
      manifest: manifest([entry("acme.echo", "1.0.0", { status: "deprecated", replacementRef: { id: "acme.echo", version: "2.0.0" } }), entry("acme.echo", "2.0.0")]),
      tools: [makeTool("acme.echo", "1.0.0"), makeTool("acme.echo", "2.0.0")],
    });
    expect(getToolboxEntry(toolbox, { id: "acme.echo", version: "1.0.0" })).toMatchObject({ status: "deprecated", replacementRef: { id: "acme.echo", version: "2.0.0" } });
    // No implicit replacement: selecting the deprecated ref returns exactly that Tool.
    const [selected] = selectToolboxTools(toolbox, [{ id: "acme.echo", version: "1.0.0" }]);
    expect(selected!.spec.version).toBe("1.0.0");
  });

  it("identity is deterministic: the same content in a different order fingerprints identically; any catalog change alters it", () => {
    const a = defineToolbox({ manifest: manifest([entry("acme.echo", "1.0.0", { tags: ["b", "a"] }), entry("acme.other")]), tools: [makeTool("acme.echo"), makeTool("acme.other")] });
    const b = defineToolbox({ manifest: manifest([entry("acme.other"), entry("acme.echo", "1.0.0", { tags: ["a", "b"] })]), tools: [makeTool("acme.other"), makeTool("acme.echo")] });
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = defineToolbox({ manifest: manifest([entry("acme.echo", "1.0.0", { tags: ["a", "c"] }), entry("acme.other")]), tools: [makeTool("acme.echo"), makeTool("acme.other")] });
    expect(c.fingerprint).not.toBe(a.fingerprint);
    // Handler code is not part of catalog identity.
    const d = defineToolbox({ manifest: manifest([entry("acme.echo", "1.0.0", { tags: ["b", "a"] }), entry("acme.other")]), tools: [defineTool({ ...makeTool("acme.echo"), handler: { execute: async () => ({ ok: true, output: { different: true } }) } }), makeTool("acme.other")] });
    expect(d.fingerprint).toBe(a.fingerprint);
  });
});

describe("defineToolbox: invalid manifests", () => {
  const tools = [makeTool("acme.echo")];

  it.each([
    ["missing id", { id: undefined }],
    ["implicit latest", { version: "latest" }],
    ["version range", { version: "^1.0.0" }],
    ["inequality version", { version: ">=1" }],
    ["empty name", { name: "" }],
    ["unknown top-level field", { registry: "https://example.test" }],
    ["schemaVersion 2", { schemaVersion: 2 }],
  ])("%s is rejected", (_label, overrides) => {
    expect(codeOf(() => defineToolbox({ manifest: { ...manifest([entry("acme.echo")]), ...(overrides as object) } as ToolboxManifestInput, tools })).code).toBe("TOOLBOX_MANIFEST_INVALID");
  });

  it.each([
    ["permissionClasses", { permissionClasses: ["external_side_effect"] }],
    ["inputSchema", { inputSchema: { type: "object" } }],
    ["outputSchema", { outputSchema: { type: "object" } }],
    ["retrySafety", { retrySafety: "safe" }],
    ["idempotency", { idempotency: "execution_id" }],
    ["handler", { handler: "module:./evil.js" }],
    ["approval", { approval: { required: false } }],
    ["latest tool version", { toolRef: { id: "acme.echo", version: "latest" } }],
    ["tool version range", { toolRef: { id: "acme.echo", version: "^1" } }],
    ["unknown example field", { examples: [{ title: "x", input: {}, code: "() => 1" }] }],
    ["empty tags", { tags: [] }],
    ["empty whenToUse", { whenToUse: [] }],
    ["empty whenNotToUse", { whenNotToUse: [] }],
    ["empty examples", { examples: [] }],
    ["duplicate tags", { tags: ["a", "a"] }],
    ["non-slug category", { category: "Text Tools" }],
    ["replacement on an active entry", { replacementRef: { id: "acme.other", version: "1.0.0" } }],
    ["unknown status", { status: "beta" }],
  ])("an entry with %s is rejected (authority fields cannot ride on discovery metadata)", (_label, overrides) => {
    expect(codeOf(() => defineToolbox({ manifest: manifest([{ ...entry("acme.echo"), ...(overrides as object) } as ToolboxEntryInput]), tools })).code).toBe("TOOLBOX_MANIFEST_INVALID");
  });

  it("a deprecated entry whose replacement is not in the Toolbox, or is itself, is rejected", () => {
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo", "1.0.0", { status: "deprecated", replacementRef: { id: "acme.missing", version: "1.0.0" } })]), tools })).code).toBe("TOOLBOX_MANIFEST_INVALID");
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo", "1.0.0", { status: "deprecated", replacementRef: { id: "acme.echo", version: "1.0.0" } })]), tools })).code).toBe("TOOLBOX_MANIFEST_INVALID");
  });

  it("a duplicate entry ref is rejected", () => {
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo"), entry("acme.echo")]), tools })).code).toBe("TOOLBOX_MANIFEST_INVALID");
  });

  it("a non-JSON manifest (function, accessor, class instance) is rejected before parsing", () => {
    expect(codeOf(() => defineToolbox({ manifest: { ...manifest([entry("acme.echo")]), name: (() => "x") as unknown as string }, tools })).code).toBe("TOOLBOX_MANIFEST_INVALID");
    expect(codeOf(() => defineToolbox({ manifest: Object.defineProperty(manifest([entry("acme.echo")]), "name", { get: () => "x", enumerable: true }), tools })).code).toBe("TOOLBOX_MANIFEST_INVALID");
    expect(codeOf(() => defineToolbox({ manifest: { ...manifest([entry("acme.echo")]), entries: [{ ...entry("acme.echo"), examples: [{ title: "d", input: { at: new Date(0) as unknown as string } }] }] }, tools })).code).toBe("TOOLBOX_MANIFEST_INVALID");
  });
});

describe("defineToolbox: one-to-one entries and admissible Tools", () => {
  it("an entry without a Tool (orphan catalog entry) is rejected", () => {
    const failure = codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo"), entry("acme.ghost")]), tools: [makeTool("acme.echo")] }));
    expect(failure).toEqual({ code: "TOOLBOX_ENTRY_MISMATCH", issues: ["entry acme.ghost@1.0.0 has no Tool definition"] });
  });

  it("a Tool without an entry (undocumented executable Tool) is rejected", () => {
    const failure = codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [makeTool("acme.echo"), makeTool("acme.hidden")] }));
    expect(failure).toEqual({ code: "TOOLBOX_ENTRY_MISMATCH", issues: ["Tool acme.hidden@1.0.0 has no manifest entry"] });
  });

  it("a wrong Tool version is both an orphan entry and an undocumented Tool", () => {
    const failure = codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo", "1.0.0")]), tools: [makeTool("acme.echo", "1.0.1")] }));
    expect(failure.code).toBe("TOOLBOX_ENTRY_MISMATCH");
    expect(failure.issues).toEqual(["entry acme.echo@1.0.0 has no Tool definition", "Tool acme.echo@1.0.1 has no manifest entry"]);
  });

  it("a duplicate Tool definition is rejected", () => {
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [makeTool("acme.echo"), makeTool("acme.echo")] })).code).toBe("TOOLBOX_TOOL_INVALID");
  });

  it("an invalid Tool definition fails through the canonical Tool Registry checks", () => {
    const broken = { ...makeTool("acme.echo"), handler: {} } as unknown as ToolDefinition;
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [broken] })).code).toBe("TOOLBOX_TOOL_INVALID");
    const badSchema = { ...makeTool("acme.echo"), spec: { ...makeTool("acme.echo").spec, inputSchema: { type: "object", madeUpKeyword: 1 } } } as unknown as ToolDefinition;
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [badSchema] })).code).toBe("TOOLBOX_TOOL_INVALID");
  });

  it("Toolbox Tools need an exact version, a substantive description, and read_only/write_draft permission classes", () => {
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [makeTool("acme.echo", "1")] })).code).toBe("TOOLBOX_TOOL_INVALID");
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [makeTool("acme.echo", "1.0.0", { description: "Echo." })] })).code).toBe("TOOLBOX_TOOL_INVALID");
    const { description: _omitted, ...withoutDescription } = makeTool("acme.echo").spec;
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [defineTool({ ...makeTool("acme.echo"), spec: withoutDescription })] })).code).toBe("TOOLBOX_TOOL_INVALID");
    for (const permissionClass of ["external_side_effect", "destructive", "sensitive_data"]) {
      expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [makeTool("acme.echo", "1.0.0", { permissionClasses: ["read_only", permissionClass] })] })).code).toBe("TOOLBOX_TOOL_INVALID");
    }
    expect(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [makeTool("acme.echo", "1.0.0", { permissionClasses: ["write_draft"] })] })).not.toThrow();
  });

  it("an empty Tool list or a missing input object is rejected", () => {
    expect(codeOf(() => defineToolbox({ manifest: manifest([entry("acme.echo")]), tools: [] })).code).toBe("TOOLBOX_TOOL_INVALID");
    expect(codeOf(() => defineToolbox(null as never)).code).toBe("TOOLBOX_MANIFEST_INVALID");
  });
});

describe("immutability and mutation isolation", () => {
  it("the Toolbox, manifest, entries, and catalog results are frozen", () => {
    expect(Object.isFrozen(coreToolbox)).toBe(true);
    expect(Object.isFrozen(coreToolbox.manifest)).toBe(true);
    expect(Object.isFrozen(coreToolbox.manifest.entries[0]!.tags)).toBe(true);
    const listed = listToolboxEntries(coreToolbox);
    expect(Object.isFrozen(listed) && Object.isFrozen(listed[0]) && Object.isFrozen(listed[0]!.examples[0]!.input)).toBe(true);
    expect(() => {
      (coreToolbox.manifest.entries[0] as { category: string }).category = "hacked";
    }).toThrow(TypeError);
    for (const tool of selectToolboxTools(coreToolbox, [ref("records.dedupe")])) {
      expect(Object.isFrozen(tool) && Object.isFrozen(tool.spec) && Object.isFrozen(tool.spec.permissionClasses)).toBe(true);
    }
  });

  it("mutating the caller's manifest, entries, spec, or handler object after definition changes nothing", async () => {
    const callerEntry = entry("acme.echo");
    const callerManifest = manifest([callerEntry]);
    const callerHandler = { execute: async () => ({ ok: true as const, output: { handler: "original" } }) };
    const callerSpec = { schemaVersion: 1 as const, id: "acme.echo", version: "1.0.0", name: "Echo", description: DESCRIPTION, inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: ["read_only" as const] };
    const toolbox = defineToolbox({ manifest: callerManifest, tools: [{ spec: callerSpec, handler: callerHandler, retrySafety: "safe" }] });
    const fingerprint = toolbox.fingerprint;

    callerManifest.name = "Mutated";
    callerManifest.entries.push(entry("acme.extra"));
    callerEntry.tags.push("injected");
    callerEntry.category = "mutated";
    (callerSpec.permissionClasses as string[]).push("external_side_effect");
    callerSpec.name = "Mutated";
    callerHandler.execute = async () => ({ ok: true as const, output: { handler: "replaced" } });

    expect(toolbox.manifest.name).toBe("Test Toolbox");
    expect(toolbox.manifest.entries).toHaveLength(1);
    expect(getToolboxEntry(toolbox, { id: "acme.echo", version: "1.0.0" })).toMatchObject({ category: "testing", tags: ["echo"], permissionClasses: ["read_only"], name: "Echo" });
    expect(toolbox.fingerprint).toBe(fingerprint);
    const [tool] = selectToolboxTools(toolbox, [{ id: "acme.echo", version: "1.0.0" }]);
    expect(tool!.spec.permissionClasses).toEqual(["read_only"]);
    expect(await tool!.handler.execute({ toolExecutionId: "x", tool: { id: "acme.echo", version: "1.0.0" }, input: {} })).toEqual({ ok: true, output: { handler: "original" } });
    expect(Object.isFrozen(tool!.handler)).toBe(true);
  });

  it("two custom Toolboxes share no catalog, Tools, metadata, or search index", () => {
    const one = defineToolbox({ manifest: manifest([entry("acme.echo", "1.0.0", { tags: ["alpha"] })]), tools: [makeTool("acme.echo")] });
    const two = defineToolbox({ manifest: manifest([entry("acme.echo", "1.0.0", { tags: ["beta"] })], { id: "acme.second" }), tools: [makeTool("acme.echo")] });
    expect(searchToolbox(one, { query: "alpha" })).toHaveLength(1);
    expect(searchToolbox(two, { query: "alpha" })).toHaveLength(0);
    expect(getToolboxEntry(two, { id: "acme.echo", version: "1.0.0" })!.tags).toEqual(["beta"]);
    expect(selectToolboxTools(one, [{ id: "acme.echo", version: "1.0.0" }])[0]).not.toBe(selectToolboxTools(two, [{ id: "acme.echo", version: "1.0.0" }])[0]);
    expect(() => selectToolboxTools(one, [ref("records.dedupe")])).toThrow(ToolboxError);
  });

  it("a look-alike object is not a Toolbox: catalog functions refuse it", () => {
    const forged = { ref: coreToolbox.ref, manifest: coreToolbox.manifest, fingerprint: coreToolbox.fingerprint };
    expect(codeOf(() => listToolboxEntries(forged)).code).toBe("TOOLBOX_QUERY_INVALID");
    expect(codeOf(() => selectToolboxTools(forged, [ref("records.dedupe")])).code).toBe("TOOLBOX_QUERY_INVALID");
  });
});
