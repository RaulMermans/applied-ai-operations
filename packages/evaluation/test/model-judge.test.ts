import { describe, expect, it } from "vitest";
import { createEvaluatorRegistry, createModelJudgeGrader, deterministicGraders, MAX_EVAL_SUBJECT_BYTES, MODEL_JUDGE_LIMITS, type EvalEvidenceBundle, type ModelJudgePort, type ModelJudgeRequest, type ModelJudgeResult } from "../src/index.js";
import { def, grade, verdict } from "./support/inline.js";

const SECRET = "SECRET_DO_NOT_PERSIST";
const rubric = { criteria: "The summary is faithful to the source and names the account.", dimensions: [{ id: "faithfulness", description: "No unsupported claims", minScore: 0.7 }, { id: "clarity", description: "Readable" }] };
const judgeDefinition = (overrides: object = {}) => def("aao.model-judge", "artifact", { rubric, passThreshold: 0.8, ...overrides } as never);
const subjectEvidence = (content = `Summary of account-a. ${SECRET}`): EvalEvidenceBundle => ({ origin: "recorded", runId: "run.judge", subject: { id: "summary.run-judge", content, context: { sourceDocument: "doc.42", note: SECRET } } });

/** Deterministic fake judge: records requests, returns scripted output. */
function fakeJudge(output: ModelJudgeResult | (() => Promise<unknown>) | Record<string, unknown>) {
  const requests: ModelJudgeRequest[] = [];
  const port: ModelJudgePort = { judge: async (request) => { requests.push(request); return typeof output === "function" ? ((await output()) as ModelJudgeResult) : (output as ModelJudgeResult); } };
  return { port, requests, registry: createEvaluatorRegistry([...deterministicGraders(), createModelJudgeGrader({ judge: port, timeoutMs: 200 })]) };
}

describe("bounded, optional, provider-independent model judge", () => {
  it("is not registered by default: the Evaluation Runtime needs no model", async () => {
    expect((await grade(judgeDefinition(), subjectEvidence())).errorCode).toBe("EVAL_GRADER_NOT_FOUND");
  });

  it("structured pass: one call, normalized score, assertions only", async () => {
    const judge = fakeJudge({ passed: true, score: 0.86, dimensionScores: [{ id: "faithfulness", score: 0.9 }, { id: "clarity", score: 0.6 }], confidence: 0.7 });
    const result = await grade(judgeDefinition(), subjectEvidence(), { registry: judge.registry });
    expect(judge.requests).toHaveLength(1);
    expect(result).toMatchObject({ status: "passed", score: 0.86 });
    expect(result.assertions.map((entry) => [entry.id, entry.status, entry.score])).toEqual([["judge.verdict", "passed", 0.86], ["judge.dimension:faithfulness", "passed", 0.9]]);
    expect(result.evidenceRefs).toEqual(["subject://summary.run-judge"]);
  });

  it("the judge receives only the explicit rubric and subject — never Trace, state, Audit, or Metrics", async () => {
    const judge = fakeJudge({ passed: true, score: 1, dimensionScores: [{ id: "faithfulness", score: 1 }] });
    await grade(judgeDefinition(), { ...subjectEvidence(), trace: [], metrics: { hidden: true } } as never, { registry: judge.registry });
    await grade(judgeDefinition(), subjectEvidence(), { registry: judge.registry });
    const request = judge.requests.at(-1)!;
    expect(Object.keys(request).sort()).toEqual(["rubric", "subject"]);
    expect(Object.keys(request.subject).sort()).toEqual(["content", "context", "id"]);
    expect(Object.isFrozen(request) && Object.isFrozen(request.subject)).toBe(true);
    expect(request.rubric.dimensions).toEqual([{ id: "faithfulness", description: "No unsupported claims" }, { id: "clarity", description: "Readable" }]);
  });

  it("structured fail: judge says not passed, score below threshold, or a gated dimension below its minimum", async () => {
    expect(verdict(await grade(judgeDefinition(), subjectEvidence(), { registry: fakeJudge({ passed: false, score: 0.4, dimensionScores: [{ id: "faithfulness", score: 0.4 }] }).registry }))).toEqual({ status: "failed", failed: ["judge.verdict:JUDGE_CRITERIA_NOT_MET", "judge.dimension:faithfulness:JUDGE_DIMENSION_BELOW_MINIMUM"] });
    expect(verdict(await grade(judgeDefinition(), subjectEvidence(), { registry: fakeJudge({ passed: true, score: 0.79, dimensionScores: [{ id: "faithfulness", score: 0.9 }] }).registry }))).toEqual({ status: "failed", failed: ["judge.verdict:JUDGE_SCORE_BELOW_THRESHOLD"] });
    expect(verdict(await grade(judgeDefinition(), subjectEvidence(), { registry: fakeJudge({ passed: true, score: 0.9, dimensionScores: [{ id: "faithfulness", score: 0.5 }] }).registry }))).toEqual({ status: "failed", failed: ["judge.dimension:faithfulness:JUDGE_DIMENSION_BELOW_MINIMUM"] });
  });

  it("adapter failure, timeout, out-of-range score, reasoning fields, or unknown dimensions are errors — never failed", async () => {
    const outputs: Array<ModelJudgeResult | (() => Promise<unknown>) | Record<string, unknown>> = [
      () => Promise.reject(new Error("provider 500 SECRET_PROVIDER_TEXT")),
      () => new Promise(() => undefined),
      { passed: true, score: 1.2, dimensionScores: [{ id: "faithfulness", score: 1 }] },
      { passed: true, score: 0.9, dimensionScores: [{ id: "faithfulness", score: 1 }], reasoning: "Let me think step by step..." },
      { passed: true, score: 0.9, dimensionScores: [{ id: "faithfulness", score: 1 }], chainOfThought: "..." },
      { passed: true, score: 0.9, dimensionScores: [{ id: "faithfulness", score: 1 }, { id: "invented", score: 1 }] },
      { passed: true, score: 0.9 },
      { passed: true, score: 0.9, dimensionScores: [{ id: "faithfulness", score: 1 }], defects: [{ code: "free text defect" }] },
    ];
    for (const output of outputs) {
      const judge = fakeJudge(output);
      const result = await grade(judgeDefinition(), subjectEvidence(), { registry: judge.registry });
      expect(verdict(result)).toEqual({ status: "error", errorCode: "EVAL_MODEL_JUDGE_ERROR", failed: [] });
      expect(judge.requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/SECRET_PROVIDER_TEXT|step by step/);
    }
  });

  it("bounds: subject size, rubric size, dimension count, timeout cap", async () => {
    const judge = fakeJudge({ passed: true, score: 1, dimensionScores: [{ id: "faithfulness", score: 1 }] });
    expect((await grade(judgeDefinition(), subjectEvidence("x".repeat(MAX_EVAL_SUBJECT_BYTES + 1)), { registry: judge.registry })).errorCode).toBe("EVAL_EVIDENCE_INVALID");
    expect((await grade(judgeDefinition({ rubric: { ...rubric, criteria: "x".repeat(MODEL_JUDGE_LIMITS.maxCriteriaChars + 1) } }), subjectEvidence(), { registry: judge.registry })).errorCode).toBe("EVAL_INVALID_DEFINITION");
    const dimensions = Array.from({ length: MODEL_JUDGE_LIMITS.maxDimensions + 1 }, (_, index) => ({ id: `d${index}`, description: "d" }));
    expect((await grade(judgeDefinition({ rubric: { criteria: "c", dimensions } }), subjectEvidence(), { registry: judge.registry })).errorCode).toBe("EVAL_INVALID_DEFINITION");
    expect((await grade(judgeDefinition(), { origin: "recorded", runId: "run.judge" }, { registry: judge.registry })).errorCode).toBe("EVAL_EVIDENCE_MISSING");
    expect(judge.requests).toHaveLength(0);
  });

  it("persists no subject, context, rubric text, defects, or reasoning (SECRET_DO_NOT_PERSIST)", async () => {
    const judge = fakeJudge({ passed: true, score: 0.95, dimensionScores: [{ id: "faithfulness", score: 0.95 }], defects: [{ code: SECRET }] });
    const result = await grade(judgeDefinition(), subjectEvidence(), { registry: judge.registry });
    expect(result.status).toBe("passed");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("Summary of account-a");
    expect(serialized).not.toContain("doc.42");
    expect(serialized).not.toContain("faithful to the source");
  });

  it("cannot be used as a safety authority: permission, Approval, Tool-use, and state targets are unsupported", async () => {
    const judge = fakeJudge({ passed: true, score: 1, dimensionScores: [{ id: "faithfulness", score: 1 }] });
    for (const targetType of ["authorization", "approval", "tool_use", "state"] as const) {
      expect((await grade({ ...judgeDefinition(), targetType }, subjectEvidence(), { registry: judge.registry })).errorCode).toBe("EVAL_TARGET_UNSUPPORTED");
    }
    expect(judge.requests).toHaveLength(0);
  });
});
