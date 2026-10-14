import { describe, expect, it } from "vitest";
import { EvalResultSchema } from "@aao/contracts";
import { EvalInputError, EvaluatorRegistryError, createEvaluatorRegistry, deterministicGraders, evaluate, evidenceFingerprint, zodConfig, type EvalGrader } from "../src/index.js";
import { z } from "zod";
import { definition, loadFixture } from "./support/evals.js";
import { def, grade, verdict } from "./support/inline.js";

const stub = (overrides: Partial<EvalGrader> = {}): EvalGrader => ({
  id: "test.stub",
  version: "1.0.0",
  supportedModes: ["OFFLINE"],
  supportedTargetTypes: ["run"],
  validateConfig: zodConfig(z.object({ ok: z.boolean() }).strict()),
  evaluate: () => ({ kind: "judged", assertions: [{ id: "stub", status: "passed", evidenceRefs: [] }] }),
  ...overrides,
});
const stubDefinition = def("test.stub", "run", { ok: true }, { supportedModes: ["OFFLINE"] });
const evidence = loadFixture("flagship-approved");

describe("Evaluator Registry", () => {
  it("registers explicitly and resolves by exact id + version", () => {
    const registry = createEvaluatorRegistry([stub()]);
    expect(registry.resolve({ id: "test.stub", version: "1.0.0" }).ok).toBe(true);
    expect(registry.resolve({ id: "test.unknown", version: "1.0.0" })).toEqual({ ok: false, code: "EVAL_GRADER_NOT_FOUND" });
    expect(registry.resolve({ id: "test.stub", version: "1.0.1" })).toEqual({ ok: false, code: "EVAL_GRADER_VERSION_MISMATCH" });
    expect(registry.list()).toEqual([{ id: "test.stub", version: "1.0.0" }]);
  });

  it("rejects duplicate registration and invalid graders; two versions of one grader coexist", () => {
    const registry = createEvaluatorRegistry([stub()]);
    expect(() => registry.register(stub())).toThrow(EvaluatorRegistryError);
    expect(() => registry.register(stub({ version: "latest" }))).toThrow(EvaluatorRegistryError);
    expect(() => registry.register(stub({ version: "2.0.0", supportedModes: [] }))).toThrow(EvaluatorRegistryError);
    expect(() => registry.register(stub({ version: "2.0.0", supportedTargetTypes: ["gpa" as never] }))).toThrow(EvaluatorRegistryError);
    registry.register(stub({ version: "2.0.0" }));
    expect(registry.list()).toHaveLength(2);
  });

  it("is constructible (no singleton) and snapshots declared capabilities", () => {
    const declared = stub();
    const a = createEvaluatorRegistry([declared]);
    expect(createEvaluatorRegistry().list()).toEqual([]);
    (declared.supportedTargetTypes as string[]).push("approval");
    const resolved = a.resolve({ id: "test.stub", version: "1.0.0" });
    expect(resolved.ok && resolved.grader.supportedTargetTypes).toEqual(["run"]);
  });

  it("ships the ten deterministic graders (approval-compliance at 2.0.0 only) and no model judge by default", () => {
    expect(createEvaluatorRegistry(deterministicGraders()).list().map((ref) => `${ref.id}@${ref.version}`)).toEqual([
      "aao.approval-compliance@2.0.0", "aao.authorization-compliance@1.0.0", "aao.metrics-threshold@1.0.0", "aao.model-call@1.0.0", "aao.retry-behavior@1.0.0", "aao.run-outcome@1.0.0", "aao.state-assertion@1.0.0", "aao.tool-usage@1.0.0", "aao.trace-contract@1.0.0", "aao.trajectory@1.0.0",
    ]);
  });
});

describe("evaluate(): definition, grader, mode, and target checks happen before any grading", () => {
  const registry = () => createEvaluatorRegistry([stub()]);

  it("unknown grader / wrong version / unsupported mode / unsupported target / invalid config are error results, and the grader never runs", async () => {
    let calls = 0;
    const counted = createEvaluatorRegistry([stub({ evaluate: () => { calls += 1; return { kind: "judged", assertions: [{ id: "stub", status: "passed", evidenceRefs: [] }] }; } })]);
    const cases: Array<[Parameters<typeof def>[3] | undefined, string, Parameters<typeof grade>[1]?, ("OFFLINE" | "RUNTIME")?]> = [
      [{ graderRef: { id: "test.missing", version: "1.0.0" } }, "EVAL_GRADER_NOT_FOUND"],
      [{ graderRef: { id: "test.stub", version: "9.9.9" } }, "EVAL_GRADER_VERSION_MISMATCH"],
      [{ supportedModes: ["RUNTIME"] }, "EVAL_MODE_UNSUPPORTED", { ...evidence, origin: "live_run" }, "RUNTIME"],
      [{ targetType: "approval" }, "EVAL_TARGET_UNSUPPORTED"],
      [{ config: { ok: "yes" } }, "EVAL_INVALID_DEFINITION"],
      [{ config: { ok: true, extra: 1 } }, "EVAL_INVALID_DEFINITION"],
    ];
    for (const [overrides, code, bundle, mode] of cases) {
      const result = await grade({ ...stubDefinition, ...overrides }, bundle ?? evidence, { registry: counted, ...(mode ? { mode } : {}) });
      expect(verdict(result), code).toEqual({ status: "error", errorCode: code, failed: [] });
      expect(EvalResultSchema.safeParse(result).success).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it("a definition that cannot be identified is rejected as input, not graded", async () => {
    await expect(evaluate({ definition: { ...stubDefinition, schemaVersion: 1 } as never, mode: "OFFLINE", evidence, registry: registry() })).rejects.toThrow(EvalInputError);
    await expect(evaluate({ definition: stubDefinition, mode: "LIVE" as never, evidence, registry: registry() })).rejects.toThrow(EvalInputError);
    await expect(evaluate({ definition: stubDefinition, mode: "OFFLINE", evidence, registry: registry(), caseId: "case.001" })).rejects.toThrow(EvalInputError);
  });

  it("RUNTIME judges live-run evidence and OFFLINE judges recorded evidence — never mixed", async () => {
    const live = def("aao.run-outcome", "run", { expectedStatus: "COMPLETED" });
    expect(verdict(await grade(live, evidence, { mode: "RUNTIME" }))).toEqual({ status: "error", errorCode: "EVAL_MODE_UNSUPPORTED", failed: [] });
    expect(verdict(await grade(live, { ...evidence, origin: "live_run" }, { mode: "OFFLINE" }))).toEqual({ status: "error", errorCode: "EVAL_MODE_UNSUPPORTED", failed: [] });
    expect((await grade(live, { ...evidence, origin: "live_run" }, { mode: "RUNTIME" })).status).toBe("passed");
  });

  it("evidence from two different Runs, or non-JSON evidence, is untrustworthy (error)", async () => {
    const other = loadFixture("approval-rejected");
    const mixed = { ...evidence, metrics: other.metrics };
    expect((await grade(definition("tool.lookup-required"), mixed)).errorCode).toBe("EVAL_EVIDENCE_INVALID");
    expect((await grade(definition("tool.lookup-required"), { ...evidence, subject: { id: "s", content: "x", context: { when: new Date() } } } as never)).errorCode).toBe("EVAL_EVIDENCE_INVALID");
    expect((await grade(definition("tool.lookup-required"), { ...evidence, extra: 1 } as never)).errorCode).toBe("EVAL_EVIDENCE_INVALID");
  });
});

describe("defensive grader boundary", () => {
  it("a throwing grader yields error EVAL_GRADER_ERROR with no stack or message, never failed", async () => {
    const registry = createEvaluatorRegistry([stub({ evaluate: () => { throw new Error("boom at /secret/path SECRET_STACK_TEXT"); } })]);
    const result = await grade(stubDefinition, evidence, { registry });
    expect(verdict(result)).toEqual({ status: "error", errorCode: "EVAL_GRADER_ERROR", failed: [] });
    expect(JSON.stringify(result)).not.toMatch(/boom|SECRET_STACK_TEXT|secret\/path/);
  });

  it("an out-of-contract verdict (no assertions, bad score, free-text reason) is a grader error", async () => {
    for (const bad of [
      { kind: "judged", assertions: [] },
      { kind: "judged", assertions: [{ id: "a", status: "passed", evidenceRefs: [] }], score: 2 },
      { kind: "judged", assertions: [{ id: "a", status: "failed", reasonCode: "value was hunter2", evidenceRefs: [] }] },
      { kind: "judged", assertions: [{ id: "a", status: "passed", evidenceRefs: ["/etc/passwd"] }] },
      { kind: "maybe" },
      undefined,
    ]) {
      const registry = createEvaluatorRegistry([stub({ evaluate: () => bad as never })]);
      expect((await grade(stubDefinition, evidence, { registry })).errorCode).toBe("EVAL_GRADER_ERROR");
    }
  });

  it("graders receive deep-frozen copies: mutation attempts fail and the host's evidence is unchanged", async () => {
    const host = loadFixture("flagship-approved");
    const before = JSON.stringify(host);
    const attempts: string[] = [];
    const registry = createEvaluatorRegistry([stub({
      evaluate: ({ evidence: frozen }) => {
        const tryMutate = (label: string, mutate: () => void) => { try { mutate(); attempts.push(`${label}:mutated`); } catch { attempts.push(`${label}:refused`); } };
        tryMutate("state", () => { (frozen.execution!.state as { revision: number }).revision = 99; });
        tryMutate("values", () => { (frozen.execution!.state.values as Record<string, unknown>).injected = true; });
        tryMutate("run", () => { (frozen.execution!.run as { status: string }).status = "FAILED"; });
        tryMutate("trace", () => { (frozen.trace as unknown[]).push({}); });
        tryMutate("event", () => { (frozen.trace![0] as { type: string }).type = "run.failed"; });
        tryMutate("metrics", () => { (frozen.metrics as { durationMs: number }).durationMs = 0; });
        tryMutate("audit", () => { (frozen.audit as unknown[]).length = 0; });
        return { kind: "judged", assertions: [{ id: "stub", status: "passed", evidenceRefs: [] }] };
      },
    })]);
    expect((await grade(stubDefinition, host, { registry })).status).toBe("passed");
    expect(attempts).toEqual(["state:refused", "values:refused", "run:refused", "trace:refused", "event:refused", "metrics:refused", "audit:refused"]);
    expect(JSON.stringify(host)).toBe(before);
  });
});

describe("deterministic identity", () => {
  it("same definition, grader version, evidence, mode, and case identity → deep-equal results", async () => {
    const a = await grade(definition("approval.required-and-approved"), loadFixture("flagship-approved"));
    const b = await grade(definition("approval.required-and-approved"), loadFixture("flagship-approved"));
    expect(a).toEqual(b);
    expect(a.resultId).toMatch(/^evr\.[a-f0-9]{64}$/);
    expect(a.evidenceFingerprint).toBe(evidenceFingerprint(loadFixture("flagship-approved")));
  });

  it("changed evidence → different fingerprint and result id; the source pointer is not evidence", async () => {
    const base = loadFixture("flagship-approved");
    const changed = { ...base, execution: { ...base.execution!, state: { ...base.execution!.state, revision: 3 } } };
    const a = await grade(definition("tool.lookup-required"), base);
    const b = await grade(definition("tool.lookup-required"), changed);
    expect(a.evidenceFingerprint).not.toBe(b.evidenceFingerprint);
    expect(a.resultId).not.toBe(b.resultId);
    expect(evidenceFingerprint({ ...base, source: "fixture://elsewhere" })).toBe(evidenceFingerprint(base));
  });

  it("result identity covers eval version, grader version, mode, and case; no wall clock participates", async () => {
    const base = definition("tool.lookup-required");
    const a = await grade(base, evidence);
    const b = await grade({ ...base, version: "1.0.1" }, evidence);
    const c = await grade(base, { ...evidence, origin: "live_run" }, { mode: "RUNTIME" });
    expect(new Set([a.resultId, b.resultId, c.resultId]).size).toBe(3);
    expect(Object.keys(a)).not.toContain("evaluatedAt");
  });
});
