import { describe, expect, it } from "vitest";
import { validateRuntimeInput } from "../src/runtime-input-validation.js";
import { buildRequest, buildRunState } from "./fixtures.js";

describe("validateRuntimeInput", () => {
  it("accepts a well-formed request", () => {
    const failure = validateRuntimeInput(buildRequest({ runId: "run.one" }));
    expect(failure).toBeUndefined();
  });

  it("rejects a malformed runId", () => {
    const request = buildRequest({ runId: "run.one" });
    const failure = validateRuntimeInput({ ...request, runId: "" });
    expect(failure?.code).toBe("INVALID_RUNTIME_INPUT");
  });

  it("rejects a plan that does not match CompiledWorkflowPlanSchema", () => {
    const request = buildRequest({ runId: "run.one" });
    const failure = validateRuntimeInput({ ...request, plan: { not: "a plan" } as never });
    expect(failure?.code).toBe("INVALID_RUNTIME_INPUT");
  });

  it("rejects malformed initial state", () => {
    const request = buildRequest({ runId: "run.one" });
    const failure = validateRuntimeInput({ ...request, initialState: { revision: -1 } as never });
    expect(failure?.code).toBe("INVALID_RUNTIME_INPUT");
  });

  it("rejects a runId mismatch between the request and initialState without silently rewriting it", () => {
    const request = buildRequest({ runId: "run.one", initialState: buildRunState("run.two") });
    const failure = validateRuntimeInput(request);
    expect(failure?.code).toBe("INVALID_RUNTIME_INPUT");
    expect(failure?.message).toMatch(/does not match/);
  });

  it("rejects a registry that does not implement the NodeRegistry shape", () => {
    const request = buildRequest({ runId: "run.one" });
    const failure = validateRuntimeInput({ ...request, registry: {} as never });
    expect(failure?.code).toBe("INVALID_RUNTIME_INPUT");
  });

  it("rejects a non-positive-integer maxSteps", () => {
    const request = buildRequest({ runId: "run.one", options: { maxSteps: 0 } });
    const failure = validateRuntimeInput(request);
    expect(failure?.code).toBe("INVALID_RUNTIME_INPUT");
  });

  it("accepts a valid positive-integer maxSteps", () => {
    const request = buildRequest({ runId: "run.one", options: { maxSteps: 10 } });
    expect(validateRuntimeInput(request)).toBeUndefined();
  });
});
