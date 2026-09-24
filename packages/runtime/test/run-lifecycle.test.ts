import { describe, expect, it } from "vitest";
import type { RunStatus } from "@aao/contracts";
import { IllegalRunTransitionError, createRunRecord, isLegalRunTransition, setCurrentNodeId, transitionRunRecord } from "../src/run-lifecycle.js";
import { buildTestClock } from "./fixtures.js";

const ALL_STATUSES: RunStatus[] = [
  "CREATED",
  "VALIDATING",
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "RETRYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

const LEGAL_TRANSITIONS: [RunStatus, RunStatus][] = [
  ["CREATED", "VALIDATING"],
  ["VALIDATING", "QUEUED"],
  ["VALIDATING", "FAILED"],
  ["QUEUED", "RUNNING"],
  ["QUEUED", "CANCELLED"],
  ["RUNNING", "WAITING_FOR_APPROVAL"],
  ["RUNNING", "RETRYING"],
  ["RUNNING", "COMPLETED"],
  ["RUNNING", "FAILED"],
  ["RUNNING", "CANCELLED"],
  ["WAITING_FOR_APPROVAL", "RUNNING"],
  ["WAITING_FOR_APPROVAL", "FAILED"],
  ["WAITING_FOR_APPROVAL", "CANCELLED"],
  ["RETRYING", "RUNNING"],
  ["RETRYING", "FAILED"],
  ["RETRYING", "CANCELLED"],
];

const TERMINAL_STATUSES: RunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

describe("isLegalRunTransition", () => {
  it.each(LEGAL_TRANSITIONS)("accepts every frozen legal transition: %s -> %s", (from, to) => {
    expect(isLegalRunTransition(from, to)).toBe(true);
  });

  it("rejects every transition not in the frozen legal set", () => {
    const legal = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}=>${to}`));
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const key = `${from}=>${to}`;
        expect(isLegalRunTransition(from, to), key).toBe(legal.has(key));
      }
    }
  });

  it.each(TERMINAL_STATUSES)("rejects every outgoing transition from the terminal status %s", (terminal) => {
    for (const to of ALL_STATUSES) {
      expect(isLegalRunTransition(terminal, to)).toBe(false);
    }
  });
});

describe("createRunRecord", () => {
  it("builds a CREATED run with createdAt and updatedAt equal, both from the clock", () => {
    const clock = buildTestClock("2026-02-01T00:00:00.000Z");
    const run = createRunRecord({ runId: "run.a", workflowId: "wf.a", workflowVersion: "1.0.0" }, clock);
    expect(run.status).toBe("CREATED");
    expect(run.createdAt).toBe("2026-02-01T00:00:00.000Z");
    expect(run.updatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(run.currentNodeId).toBeUndefined();
  });

  it("never invents another run identity — runId/workflowId/workflowVersion are exactly the caller's values", () => {
    const clock = buildTestClock();
    const run = createRunRecord({ runId: "run.b", workflowId: "wf.b", workflowVersion: "2.3.4" }, clock);
    expect(run.runId).toBe("run.b");
    expect(run.workflowId).toBe("wf.b");
    expect(run.workflowVersion).toBe("2.3.4");
  });
});

describe("transitionRunRecord", () => {
  it("applies a legal transition immutably, preserving createdAt and advancing updatedAt", () => {
    const clock = buildTestClock("2026-02-01T00:00:00.000Z");
    const run = createRunRecord({ runId: "run.c", workflowId: "wf.c", workflowVersion: "1.0.0" }, clock);
    const next = transitionRunRecord(run, "VALIDATING", clock.now());
    expect(next.status).toBe("VALIDATING");
    expect(next.createdAt).toBe(run.createdAt);
    expect(next.updatedAt).toBe("2026-02-01T00:00:01.000Z");
    expect(next).not.toBe(run);
    expect(run.status).toBe("CREATED"); // input never mutated
  });

  it("throws IllegalRunTransitionError for a transition outside the frozen legal set", () => {
    const clock = buildTestClock();
    const run = createRunRecord({ runId: "run.d", workflowId: "wf.d", workflowVersion: "1.0.0" }, clock);
    expect(() => transitionRunRecord(run, "COMPLETED", clock.now())).toThrow(IllegalRunTransitionError);
  });

  it.each(TERMINAL_STATUSES)("throws for any outgoing transition attempted from the terminal status %s", (terminal) => {
    const clock = buildTestClock();
    const run = { ...createRunRecord({ runId: "run.e", workflowId: "wf.e", workflowVersion: "1.0.0" }, clock), status: terminal };
    expect(() => transitionRunRecord(run, "RUNNING", clock.now())).toThrow(IllegalRunTransitionError);
  });

  it("rejects a malformed timestamp rather than silently accepting it", () => {
    const clock = buildTestClock();
    const run = createRunRecord({ runId: "run.f", workflowId: "wf.f", workflowVersion: "1.0.0" }, clock);
    expect(() => transitionRunRecord(run, "VALIDATING", "not-a-timestamp")).toThrow();
  });

  it("advances updatedAt monotonically (non-decreasing) across a realistic lifecycle walk", () => {
    const clock = buildTestClock("2026-02-01T00:00:00.000Z");
    let run = createRunRecord({ runId: "run.g", workflowId: "wf.g", workflowVersion: "1.0.0" }, clock);
    const updatedAts = [run.updatedAt];
    for (const status of ["VALIDATING", "QUEUED", "RUNNING", "COMPLETED"] as const) {
      run = transitionRunRecord(run, status, clock.now());
      updatedAts.push(run.updatedAt);
    }
    for (let i = 1; i < updatedAts.length; i += 1) {
      expect(updatedAts[i]! >= updatedAts[i - 1]!).toBe(true);
    }
  });
});

describe("transitionRunRecord temporal monotonicity", () => {
  function runAt(updatedAt: string) {
    return { ...createRunRecord({ runId: "run.t", workflowId: "wf.t", workflowVersion: "1.0.0" }, { now: () => updatedAt }) };
  }

  it("accepts a later timestamp", () => {
    const next = transitionRunRecord(runAt("2026-09-24T10:00:00Z"), "VALIDATING", "2026-09-24T10:00:01Z");
    expect(next.updatedAt).toBe("2026-09-24T10:00:01Z");
  });

  it("accepts an equal timestamp", () => {
    const next = transitionRunRecord(runAt("2026-09-24T10:00:00Z"), "VALIDATING", "2026-09-24T10:00:00Z");
    expect(next.status).toBe("VALIDATING");
  });

  it("accepts the same instant written with a different UTC offset", () => {
    const next = transitionRunRecord(runAt("2026-09-24T10:00:00Z"), "VALIDATING", "2026-09-24T12:00:00+02:00");
    expect(next.updatedAt).toBe("2026-09-24T12:00:00+02:00");
  });

  it("rejects an earlier instant, even when its raw string sorts later", () => {
    const run = runAt("2026-09-24T10:00:00Z");
    expect(() => transitionRunRecord(run, "VALIDATING", "2026-09-24T09:59:59Z")).toThrow(/backwards/);
    expect(() => transitionRunRecord(run, "VALIDATING", "2026-09-24T11:30:00+02:00")).toThrow(/backwards/);
  });

  it("still rejects a malformed timestamp through canonical validation", () => {
    expect(() => transitionRunRecord(runAt("2026-09-24T10:00:00Z"), "VALIDATING", "2026-09-24 10:00")).toThrow(/not a valid ISO timestamp/);
  });
});

describe("setCurrentNodeId", () => {
  it("sets currentNodeId immutably", () => {
    const clock = buildTestClock();
    const run = createRunRecord({ runId: "run.h", workflowId: "wf.h", workflowVersion: "1.0.0" }, clock);
    const next = setCurrentNodeId(run, "node.a");
    expect(next.currentNodeId).toBe("node.a");
    expect(run.currentNodeId).toBeUndefined();
  });

  it("clears currentNodeId by omitting the key entirely, not setting it to undefined", () => {
    const clock = buildTestClock();
    const run = setCurrentNodeId(createRunRecord({ runId: "run.i", workflowId: "wf.i", workflowVersion: "1.0.0" }, clock), "node.a");
    const cleared = setCurrentNodeId(run, undefined);
    expect(cleared.currentNodeId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(cleared, "currentNodeId")).toBe(false);
  });
});
