import { describe, expect, it } from "vitest";
import type { RunState } from "@aao/contracts";
import { applyStatePatch, cloneRunState } from "../src/state.js";

function state(revision: number, values: RunState["values"]): RunState {
  return { runId: "test.run", revision, values };
}

describe("applyStatePatch", () => {
  it("performs a shallow top-level merge, replacing matching keys wholesale", () => {
    const current = state(0, { request: "hello", classification: "unknown" });
    const next = applyStatePatch(current, { classification: "sales" });
    expect(next.values).toEqual({ request: "hello", classification: "sales" });
  });

  it("replaces nested objects entirely rather than deep-merging them", () => {
    const current = state(0, { profile: { name: "a", age: 1 } });
    const next = applyStatePatch(current, { profile: { name: "b" } });
    expect(next.values).toEqual({ profile: { name: "b" } });
  });

  it("increments revision by exactly one when a patch is applied", () => {
    const current = state(0, {});
    const next = applyStatePatch(current, { x: 1 });
    expect(next.revision).toBe(1);
  });

  it("does not increment revision when no patch is given", () => {
    const current = state(3, { x: 1 });
    const next = applyStatePatch(current, undefined);
    expect(next.revision).toBe(3);
    expect(next).toBe(current);
  });

  it("does not mutate the input state's values", () => {
    const current = state(0, { x: 1 });
    const snapshot = JSON.parse(JSON.stringify(current));
    applyStatePatch(current, { x: 2 });
    expect(current).toEqual(snapshot);
  });

  it("does not let a later mutation of the returned state affect the input state", () => {
    const current = state(0, { nested: { a: 1 } });
    const next = applyStatePatch(current, { other: 2 });
    (next.values.nested as { a: number }).a = 999;
    expect((current.values.nested as { a: number }).a).toBe(1);
  });

  it("supports multiple sequential patches without cross-contaminating earlier snapshots", () => {
    const s0 = state(0, { value: 2 });
    const s1 = applyStatePatch(s0, { value: 4 });
    const s2 = applyStatePatch(s1, { result: 8 });
    expect(s0.values).toEqual({ value: 2 });
    expect(s1.values).toEqual({ value: 4 });
    expect(s2.values).toEqual({ value: 4, result: 8 });
    expect(s0.revision).toBe(0);
    expect(s1.revision).toBe(1);
    expect(s2.revision).toBe(2);
  });
});

describe("cloneRunState", () => {
  it("produces a deep, independent copy", () => {
    const original = state(1, { nested: { a: 1 } });
    const cloned = cloneRunState(original);
    (cloned.values.nested as { a: number }).a = 999;
    expect((original.values.nested as { a: number }).a).toBe(1);
    expect(cloned.runId).toBe(original.runId);
    expect(cloned.revision).toBe(original.revision);
  });
});
