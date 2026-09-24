import { describe, expect, it } from "vitest";
import type { NodeStatus } from "@aao/contracts";
import { IllegalNodeTransitionError, initializeNodeStatuses, isLegalNodeTransition, transitionNodeStatus } from "../src/node-lifecycle.js";

const ALL_STATUSES: NodeStatus[] = ["PENDING", "READY", "RUNNING", "WAITING", "SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"];

describe("isLegalNodeTransition", () => {
  it("accepts the Runtime V1 lifecycle: PENDING -> READY -> RUNNING -> SUCCEEDED", () => {
    expect(isLegalNodeTransition("PENDING", "READY")).toBe(true);
    expect(isLegalNodeTransition("READY", "RUNNING")).toBe(true);
    expect(isLegalNodeTransition("RUNNING", "SUCCEEDED")).toBe(true);
  });

  it("accepts RUNNING -> FAILED", () => {
    expect(isLegalNodeTransition("RUNNING", "FAILED")).toBe(true);
  });

  it("rejects every transition out of a terminal-for-V1 status (SUCCEEDED, FAILED, WAITING, SKIPPED, CANCELLED)", () => {
    for (const from of ["SUCCEEDED", "FAILED", "WAITING", "SKIPPED", "CANCELLED"] as const) {
      for (const to of ALL_STATUSES) {
        expect(isLegalNodeTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("rejects skipping a stage (e.g. PENDING -> RUNNING directly)", () => {
    expect(isLegalNodeTransition("PENDING", "RUNNING")).toBe(false);
    expect(isLegalNodeTransition("PENDING", "SUCCEEDED")).toBe(false);
    expect(isLegalNodeTransition("READY", "SUCCEEDED")).toBe(false);
  });

  it("rejects going backwards", () => {
    expect(isLegalNodeTransition("RUNNING", "READY")).toBe(false);
    expect(isLegalNodeTransition("READY", "PENDING")).toBe(false);
  });
});

describe("initializeNodeStatuses", () => {
  it("starts every node PENDING", () => {
    const statuses = initializeNodeStatuses(["a", "b", "c"]);
    expect(statuses).toEqual({ a: "PENDING", b: "PENDING", c: "PENDING" });
  });

  it("builds an empty map for an empty node id list", () => {
    expect(initializeNodeStatuses([])).toEqual({});
  });
});

describe("transitionNodeStatus", () => {
  it("applies a legal transition immutably", () => {
    const statuses = initializeNodeStatuses(["a"]);
    const next = transitionNodeStatus(statuses, "a", "READY");
    expect(next).toEqual({ a: "READY" });
    expect(statuses).toEqual({ a: "PENDING" }); // input never mutated
    expect(next).not.toBe(statuses);
  });

  it("leaves every other node's status untouched", () => {
    const statuses = initializeNodeStatuses(["a", "b"]);
    const next = transitionNodeStatus(statuses, "a", "READY");
    expect(next.b).toBe("PENDING");
  });

  it("throws IllegalNodeTransitionError for an illegal transition", () => {
    const statuses = initializeNodeStatuses(["a"]);
    expect(() => transitionNodeStatus(statuses, "a", "RUNNING")).toThrow(IllegalNodeTransitionError);
  });

  it("throws for an unknown node id", () => {
    const statuses = initializeNodeStatuses(["a"]);
    expect(() => transitionNodeStatus(statuses, "does-not-exist", "READY")).toThrow(/unknown node/);
  });

  it("supports the full Runtime V1 walk to SUCCEEDED", () => {
    let statuses = initializeNodeStatuses(["a"]);
    statuses = transitionNodeStatus(statuses, "a", "READY");
    statuses = transitionNodeStatus(statuses, "a", "RUNNING");
    statuses = transitionNodeStatus(statuses, "a", "SUCCEEDED");
    expect(statuses.a).toBe("SUCCEEDED");
  });

  it("supports the full Runtime V1 walk to FAILED", () => {
    let statuses = initializeNodeStatuses(["a"]);
    statuses = transitionNodeStatus(statuses, "a", "READY");
    statuses = transitionNodeStatus(statuses, "a", "RUNNING");
    statuses = transitionNodeStatus(statuses, "a", "FAILED");
    expect(statuses.a).toBe("FAILED");
  });
});
