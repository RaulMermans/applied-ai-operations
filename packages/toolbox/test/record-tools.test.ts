import { describe, expect, it } from "vitest";
import { CORE_TOOL_LIMITS } from "../src/index.js";
import { callHandler, execute, output } from "./support.js";

type Rec = Record<string, unknown>;
interface RecordsOut { status: string; data: { records: Rec[] }; meta: Record<string, unknown> }
interface CountOut { status: string; data: { groups: { kind: string; value?: unknown; count: number }[] }; meta: Record<string, unknown> }

const run = (id: string, input: unknown) => output<RecordsOut>(id, input);
const failureOf = async (id: string, input: unknown) => {
  const result = await execute(id, input);
  if (result.ok) throw new Error("expected a failure");
  return result.failure;
};
/** JSON.parse creates own "__proto__" keys, exactly as untrusted JSON input does. */
const parsed = (json: string) => JSON.parse(json) as Rec[];

describe("records.dedupe", () => {
  it("empty records: status empty", async () => {
    expect(await run("records.dedupe", { records: [], keys: ["id"] })).toEqual({ status: "empty", data: { records: [] }, meta: { inputCount: 0, outputCount: 0, duplicatesRemoved: 0, keys: ["id"], keep: "first" } });
  });

  it("single record and no duplicates pass through unchanged", async () => {
    expect((await run("records.dedupe", { records: [{ id: 1 }], keys: ["id"] })).data.records).toEqual([{ id: 1 }]);
  });

  it("keeps the first of each duplicate group by default, in original order", async () => {
    const records = [{ id: "b", n: 1 }, { id: "a", n: 2 }, { id: "b", n: 3 }, { id: "a", n: 4 }, { id: "c", n: 5 }];
    const result = await run("records.dedupe", { records, keys: ["id"] });
    expect(result.data.records).toEqual([{ id: "b", n: 1 }, { id: "a", n: 2 }, { id: "c", n: 5 }]);
    expect(result.meta).toMatchObject({ inputCount: 5, outputCount: 3, duplicatesRemoved: 2, keep: "first" });
  });

  it("keep: last keeps the last of each group, still in original relative order", async () => {
    const records = [{ id: "b", n: 1 }, { id: "a", n: 2 }, { id: "b", n: 3 }, { id: "a", n: 4 }, { id: "c", n: 5 }];
    expect((await run("records.dedupe", { records, keys: ["id"], keep: "last" })).data.records).toEqual([{ id: "b", n: 3 }, { id: "a", n: 4 }, { id: "c", n: 5 }]);
  });

  it("multiple keys: all must match", async () => {
    const records = [{ a: 1, b: 1 }, { a: 1, b: 2 }, { a: 1, b: 1, extra: true }];
    expect((await run("records.dedupe", { records, keys: ["a", "b"] })).data.records).toEqual([{ a: 1, b: 1 }, { a: 1, b: 2 }]);
  });

  it("missing and null are distinct; types are never coerced", async () => {
    const records = [{ id: null }, {}, { id: "1" }, { id: 1 }, { id: true }, { id: "true" }, { id: null }, {}, { id: 1 }];
    expect((await run("records.dedupe", { records, keys: ["id"] })).data.records).toEqual([{ id: null }, {}, { id: "1" }, { id: 1 }, { id: true }, { id: "true" }]);
  });

  it("object values compare canonically (key order ignored), arrays by order", async () => {
    const records = [{ k: { x: 1, y: 2 } }, { k: { y: 2, x: 1 } }, { k: [1, 2] }, { k: [2, 1] }];
    expect((await run("records.dedupe", { records, keys: ["k"] })).data.records).toEqual([{ k: { x: 1, y: 2 } }, { k: [1, 2] }, { k: [2, 1] }]);
  });

  it("is exact, never fuzzy: near-identical strings stay distinct", async () => {
    const records = [{ name: "Acme" }, { name: "acme" }, { name: "Acme " }, { name: "Acmé" }];
    expect((await run("records.dedupe", { records, keys: ["name"] })).data.records).toHaveLength(4);
  });

  it("keys: empty, duplicated, or over 64 are input-schema failures", async () => {
    for (const keys of [[], ["id", "id"], Array.from({ length: 65 }, (_, i) => `f${i}`), [""]]) {
      expect((await failureOf("records.dedupe", { records: [], keys })).code).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    }
  });
});

describe("records.project", () => {
  it("keeps listed fields in listed order and preserves record order", async () => {
    const result = await run("records.project", { records: [{ c: 3, a: 1, b: 2 }, { b: 5, a: 4 }], fields: ["b", "a"] });
    expect(result.data.records).toEqual([{ b: 2, a: 1 }, { b: 5, a: 4 }]);
    expect(result.data.records.map((record) => Object.keys(record))).toEqual([["b", "a"], ["b", "a"]]);
  });

  it("missing fields are omitted, never invented as null, and counted per field", async () => {
    const result = await run("records.project", { records: [{ a: 1 }, { a: null, b: 2 }, {}], fields: ["a", "b"] });
    expect(result.data.records).toEqual([{ a: 1 }, { a: null, b: 2 }, {}]);
    expect(result.meta).toEqual({ recordCount: 3, fields: ["a", "b"], missing: [{ field: "a", count: 1 }, { field: "b", count: 2 }] });
  });

  it("empty records: status empty; empty field list: schema failure", async () => {
    expect((await run("records.project", { records: [], fields: ["a"] })).status).toBe("empty");
    expect((await failureOf("records.project", { records: [{ a: 1 }], fields: [] })).code).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
  });

  it("does not evaluate paths or expressions: a dotted field name is an ordinary key", async () => {
    expect((await run("records.project", { records: [{ "a.b": 1, a: { b: 2 } }], fields: ["a.b"] })).data.records).toEqual([{ "a.b": 1 }]);
  });
});

describe("records.sort", () => {
  it("stable: equal keys keep input order", async () => {
    const records = [{ k: 1, id: "a" }, { k: 0, id: "b" }, { k: 1, id: "c" }, { k: 0, id: "d" }, { k: 1, id: "e" }];
    expect((await run("records.sort", { records, keys: [{ field: "k" }] })).data.records.map((record) => record.id)).toEqual(["b", "d", "a", "c", "e"]);
    expect((await run("records.sort", { records, keys: [{ field: "k", direction: "desc" }] })).data.records.map((record) => record.id)).toEqual(["a", "c", "e", "b", "d"]);
  });

  it("canonical order: booleans < numbers < strings (code units, no locale), then null, then missing", async () => {
    const records = [{ v: "b" }, {}, { v: null }, { v: 10 }, { v: "B" }, { v: true }, { v: -1.5 }, { v: false }, { v: "ä" }, { v: 2 }];
    const ascending = (await run("records.sort", { records, keys: [{ field: "v" }] })).data.records.map((record) => ("v" in record ? record.v : "<missing>"));
    expect(ascending).toEqual([false, true, -1.5, 2, 10, "B", "b", "ä", null, "<missing>"]);
  });

  it("desc reverses present values only: null and missing stay last", async () => {
    const records = [{}, { v: 1 }, { v: null }, { v: 3 }, { v: "x" }];
    const descending = (await run("records.sort", { records, keys: [{ field: "v", direction: "desc" }] })).data.records.map((record) => ("v" in record ? record.v : "<missing>"));
    expect(descending).toEqual(["x", 3, 1, null, "<missing>"]);
  });

  it("multiple keys: later keys break earlier ties", async () => {
    const records = [{ s: 2, n: "b" }, { s: 2, n: "a" }, { s: 5, n: "c" }];
    expect((await run("records.sort", { records, keys: [{ field: "s", direction: "desc" }, { field: "n" }] })).data.records).toEqual([{ s: 5, n: "c" }, { s: 2, n: "a" }, { s: 2, n: "b" }]);
  });

  it("refuses non-scalar sort values, repeated sort fields, and more than three keys", async () => {
    expect(await failureOf("records.sort", { records: [{ v: { x: 1 } }], keys: [{ field: "v" }] })).toMatchObject({ code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "UNSORTABLE_VALUE" });
    expect(await failureOf("records.sort", { records: [{ v: [1] }], keys: [{ field: "v" }] })).toMatchObject({ handlerFailureCode: "UNSORTABLE_VALUE" });
    expect(await failureOf("records.sort", { records: [], keys: [{ field: "v" }, { field: "v", direction: "desc" }] })).toMatchObject({ handlerFailureCode: "DUPLICATE_SORT_KEY" });
    const four = ["a", "b", "c", "d"].map((field) => ({ field }));
    expect((await failureOf("records.sort", { records: [], keys: four })).code).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    expect((await failureOf("records.sort", { records: [], keys: [{ field: "a", direction: "up" }] })).code).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
  });
});

describe("records.count_by", () => {
  it("distinguishes missing, null, and typed values with no sentinel collisions", async () => {
    const records = [{ s: "open" }, { s: "null" }, { s: null }, {}, { s: 1 }, { s: "1" }, { s: true }, { s: "open" }, {}, { s: null }];
    const result = await output<CountOut>("records.count_by", { records, field: "s" });
    expect(result.data.groups).toEqual([
      { kind: "string", value: "open", count: 2 },
      { kind: "null", count: 2 },
      { kind: "missing", count: 2 },
      { kind: "boolean", value: true, count: 1 },
      { kind: "number", value: 1, count: 1 },
      { kind: "string", value: "1", count: 1 },
      { kind: "string", value: "null", count: 1 },
    ]);
    expect(result.meta).toEqual({ recordCount: 10, groupCount: 7, field: "s" });
  });

  it("empty records: status empty with no groups; a non-scalar value is refused", async () => {
    expect(await output<CountOut>("records.count_by", { records: [], field: "s" })).toEqual({ status: "empty", data: { groups: [] }, meta: { recordCount: 0, groupCount: 0, field: "s" } });
    expect(await failureOf("records.count_by", { records: [{ s: { x: 1 } }], field: "s" })).toMatchObject({ handlerFailureCode: "UNGROUPABLE_VALUE" });
  });
});

describe("record bounds", () => {
  const ids = ["records.dedupe", "records.project", "records.sort", "records.count_by"] as const;
  const inputFor = (id: (typeof ids)[number], records: unknown[]) =>
    id === "records.dedupe" ? { records, keys: ["k"] } : id === "records.project" ? { records, fields: ["k"] } : id === "records.sort" ? { records, keys: [{ field: "k" }] } : { records, field: "k" };

  it("exactly the maximum record count is accepted; one more is an input-schema failure", async () => {
    const max = Array.from({ length: CORE_TOOL_LIMITS.maxRecords }, (_, i) => ({ k: i % 7 }));
    for (const id of ids) {
      expect((await execute(id, inputFor(id, max))).ok, id).toBe(true);
      expect((await failureOf(id, inputFor(id, [...max, { k: 0 }]))).code, id).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    }
  });

  it("too many fields per record, or oversized serialized records, fail explicitly", async () => {
    const wide = Object.fromEntries(Array.from({ length: CORE_TOOL_LIMITS.maxFieldsPerRecord + 1 }, (_, i) => [`f${i}`, i]));
    const heavy = Array.from({ length: 20 }, () => ({ k: 1, blob: "x".repeat(60_000) }));
    for (const id of ids) {
      expect((await failureOf(id, inputFor(id, [wide]))).code, id).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
      expect(await failureOf(id, inputFor(id, heavy)), id).toMatchObject({ code: "TOOL_EXECUTION_FAILED", handlerFailureCode: "INPUT_TOO_LARGE" });
    }
  });

  it("non-object records and non-finite numbers never reach a handler", async () => {
    for (const id of ids) expect((await failureOf(id, inputFor(id, [1, "x"]))).code, id).toBe("TOOL_INPUT_SCHEMA_MISMATCH");
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect((await failureOf("records.sort", { records: [{ k: value }], keys: [{ field: "k" }] })).code).toBe("INVALID_TOOL_REQUEST");
    }
  });
});

describe("prototype-pollution safety (mandatory regression)", () => {
  const hostile = '[{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":"p","k":1},{"__proto__":{"polluted":true},"constructor":"c","k":2},{"k":3}]';
  const handled = async (id: string, input: unknown) => {
    const result = await callHandler(id, input as never);
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);
    return result.output as unknown as RecordsOut;
  };

  it("Toolbox handlers treat __proto__, constructor, and prototype as ordinary own fields (handler level, keys intact)", async () => {
    const projected = await handled("records.project", { records: parsed(hostile), fields: ["__proto__", "constructor", "prototype"] });
    expect(JSON.stringify(projected.data.records)).toBe('[{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":"p"},{"__proto__":{"polluted":true},"constructor":"c"},{}]');
    expect(projected.data.records.every((record) => Object.getPrototypeOf(record) === Object.prototype && (record as Rec).polluted === undefined)).toBe(true);
    expect(projected.meta.missing).toEqual([{ field: "__proto__", count: 1 }, { field: "constructor", count: 1 }, { field: "prototype", count: 2 }]);

    expect((await handled("records.dedupe", { records: parsed(hostile), keys: ["__proto__"] })).data.records.map((record) => record.k)).toEqual([1, 3]);
    expect((await handled("records.dedupe", { records: parsed('[{"__proto__":{"a":1}},{"__proto__":{"a":2}},{}]'), keys: ["__proto__"] })).data.records).toHaveLength(3);
    const counted = (await handled("records.count_by", { records: parsed('[{"__proto__":"x"},{"__proto__":"x"},{}]'), field: "__proto__" })) as unknown as CountOut;
    expect(counted.data.groups).toEqual([{ kind: "string", value: "x", count: 2 }, { kind: "missing", count: 1 }]);
    const sorted = await handled("records.sort", { records: parsed('[{"__proto__":"b"},{"__proto__":"a"},{}]'), keys: [{ field: "__proto__" }] });
    expect(JSON.stringify(sorted.data.records)).toBe('[{"__proto__":"a"},{"__proto__":"b"},{}]');
    expect(await callHandler("records.sort", { records: parsed(hostile).slice(0, 1), keys: [{ field: "__proto__" }] } as never)).toEqual({ ok: false, code: "UNSORTABLE_VALUE" });
  });

  it("through the canonical Tool Runtime path, constructor and prototype arrive intact; __proto__ keys are stripped by Core request parsing before any handler", async () => {
    const projected = await run("records.project", { records: parsed(hostile), fields: ["__proto__", "constructor", "prototype"] });
    // Core's JsonValueSchema (zod) drops own "__proto__" keys when the Tool Runtime parses a request — safe, never polluting.
    expect(JSON.stringify(projected.data.records)).toBe('[{"constructor":{"prototype":{"polluted":true}},"prototype":"p"},{"constructor":"c"},{}]');
    expect(projected.data.records.every((record) => Object.getPrototypeOf(record) === Object.prototype)).toBe(true);
    const byPrototype = await output<CountOut>("records.count_by", { records: parsed(hostile), field: "prototype" });
    expect(byPrototype.data.groups).toEqual([{ kind: "missing", count: 2 }, { kind: "string", value: "p", count: 1 }]);
    expect(await failureOf("records.count_by", { records: parsed(hostile).slice(0, 1), field: "constructor" })).toMatchObject({ handlerFailureCode: "UNGROUPABLE_VALUE" });
    expect((await run("records.sort", { records: parsed('[{"prototype":"b"},{"prototype":"a"},{}]'), keys: [{ field: "prototype" }] })).data.records).toEqual(parsed('[{"prototype":"a"},{"prototype":"b"},{}]'));
  });

  it("a field missing from a record never reads through to Object.prototype", async () => {
    const result = await output<CountOut>("records.count_by", { records: [{}, {}], field: "toString" });
    expect(result.data.groups).toEqual([{ kind: "missing", count: 2 }]);
    expect((await run("records.project", { records: [{}], fields: ["constructor", "hasOwnProperty"] })).data.records).toEqual([{}]);
    expect((await run("records.dedupe", { records: [{}, {}], keys: ["constructor"] })).data.records).toEqual([{}]);
    expect((await run("records.sort", { records: [{ k: 1 }, {}], keys: [{ field: "valueOf" }] })).data.records).toEqual([{ k: 1 }, {}]);
  });

  it("no global prototype was polluted by any of the above", () => {
    expect(({} as Rec).polluted).toBeUndefined();
    expect((Object.prototype as Rec).polluted).toBeUndefined();
  });
});

describe("determinism", () => {
  it("every record Tool returns deep-equal results across repeated runs", async () => {
    const records = Array.from({ length: 200 }, (_, i) => ({ id: i % 37, group: ["a", "b", null, 3, true][i % 5], name: `n${(i * 7919) % 101}` }));
    const inputs: [string, unknown][] = [
      ["records.dedupe", { records, keys: ["id", "group"] }],
      ["records.project", { records, fields: ["name", "id"] }],
      ["records.sort", { records, keys: [{ field: "group" }, { field: "name", direction: "desc" }] }],
      ["records.count_by", { records, field: "group" }],
    ];
    for (const [id, input] of inputs) {
      const first = await output(id, input);
      for (let i = 0; i < 4; i += 1) expect(await output(id, input), id).toEqual(first);
    }
  });
});
