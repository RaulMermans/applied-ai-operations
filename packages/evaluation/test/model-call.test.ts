import { describe, expect, it } from "vitest";
import { createModelCallGrader } from "../src/index.js";
import { loadFixture } from "./support/evals.js";
import { def, grade, verdict } from "./support/inline.js";
import { d, traceOf } from "./support/synthetic.js";

/** `aao.model-call`: canonical model Trace evidence only — invocation count, trusted identity, usage, outcome, normalized failure. */
const call = (config: object) => def("aao.model-call", "run", config as never);
const identityA = { provider: "provider-a", model: "model-a" };

describe("aao.model-call", () => {
  it("identity, usage, count, and outcome over a recorded provider Trace", async () => {
    const evidence = loadFixture("portability-provider-a");
    expect(verdict(await grade(call({ expectedCalls: { min: 1, max: 1 }, expectedIdentity: identityA, expectedUsage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }, expectedOutcome: "completed" }), evidence))).toEqual({ status: "passed", failed: [] });
    expect(verdict(await grade(call({ expectedIdentity: { provider: "provider-b", model: "model-b" } }), evidence))).toEqual({ status: "failed", failed: ["model.identity:MODEL_IDENTITY_MISMATCH"] });
    expect(verdict(await grade(call({ expectedUsage: { totalTokens: 1 } }), evidence))).toEqual({ status: "failed", failed: ["model.usage:MODEL_USAGE_MISMATCH"] });
    expect(verdict(await grade(call({ expectedCalls: { max: 0 } }), evidence))).toEqual({ status: "failed", failed: ["model.call-count:MODEL_CALL_COUNT_MISMATCH"] });
    expect(verdict(await grade(call({ expectedOutcome: "failed" }), evidence))).toEqual({ status: "failed", failed: ["model.outcome:MODEL_OUTCOME_MISMATCH"] });
  });

  it("an obligation a complete Trace does not show fails; missing Trace is an error, never a pass", async () => {
    expect(verdict(await grade(call({ expectedIdentity: identityA }), loadFixture("flagship-approved")))).toEqual({ status: "failed", failed: ["model.identity:MODEL_IDENTITY_MISMATCH"] });
    expect(verdict(await grade(call({ expectedCalls: { min: 1 } }), loadFixture("execution-only")))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_MISSING" });
    expect(verdict(await grade(call({ expectedCalls: { min: 1 } }), loadFixture("corrupt-trace-gap")))).toMatchObject({ status: "error", errorCode: "EVAL_EVIDENCE_INVALID" });
  });

  it("normalized failures: code and adapter reason", async () => {
    const identity = { runId: "run.model-call.failed", workflowId: "eval.synthetic", workflowVersion: "1.0.0" };
    const failed = { ...d.modelStarted("answer", 1, "inv.failed", "binding.x", identityA) };
    const trace = await traceOf(identity, [
      [0, d.runStarted("answer", 2)],
      [1, d.nodeStarted("answer", 1, "model")],
      [2, failed],
      [3, { type: "model.call.failed", nodeId: "answer", span: { kind: "model", invocationId: "inv.failed", attempt: 1 }, parentSpan: { kind: "node", nodeId: "answer", step: 1, attempt: 1 }, key: { step: 1 }, payload: { invocationId: "inv.failed", attempt: 1, modelBindingId: "binding.x", code: "MODEL_INVOCATION_FAILED", adapterReason: "provider_error" } }],
      [4, d.nodeFailed("answer", 1, "model", 1, "NODE_EXECUTION_FAILED", "EXECUTION")],
      [5, d.runFailed("NODE_EXECUTION_FAILED", "EXECUTION", 1, "answer")],
    ]);
    const evidence = { origin: "recorded" as const, runId: identity.runId, trace };
    expect(verdict(await grade(call({ expectedOutcome: "failed", expectedFailure: { failureCode: "MODEL_INVOCATION_FAILED", adapterReason: "provider_error" } }), evidence))).toEqual({ status: "passed", failed: [] });
    expect(verdict(await grade(call({ expectedOutcome: "failed", expectedFailure: { adapterReason: "unsupported_response" } }), evidence))).toEqual({ status: "failed", failed: ["model.failure:MODEL_FAILURE_MISMATCH"] });
  });

  it("config is strict and bounded", () => {
    const validate = (config: object) => createModelCallGrader().validateConfig(config as never).ok;
    expect(validate({})).toBe(false);
    expect(validate({ expectedFailure: { failureCode: "X" } })).toBe(false);
    expect(validate({ expectedOutcome: "failed", expectedFailure: {} })).toBe(false);
    expect(validate({ expectedIdentity: identityA, provider: "x" })).toBe(false);
    expect(validate({ expectedCalls: {} })).toBe(false);
    expect(validate({ expectedIdentity: identityA })).toBe(true);
  });
});
