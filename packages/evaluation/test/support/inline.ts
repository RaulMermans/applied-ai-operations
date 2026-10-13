import type { EvalDefinition, EvalMode, EvalTargetType, JsonObject } from "@aao/contracts";
import { evaluate, type EvalEvidenceBundle, type EvaluatorRegistry } from "../../src/index.js";
import { registry as defaultRegistry } from "./evals.js";

/** An inline definition for focused grader tests. */
export function def(grader: string, targetType: EvalTargetType, config: JsonObject, overrides: Partial<EvalDefinition> = {}): EvalDefinition {
  return { schemaVersion: 2, id: `test.${grader.replace(/^aao\./, "")}`, version: "1.0.0", name: `Test ${grader}`, supportedModes: ["OFFLINE", "RUNTIME"], targetType, graderRef: { id: grader, version: "1.0.0" }, config, ...overrides };
}

export function grade(definition: EvalDefinition, evidence: EvalEvidenceBundle, options: { mode?: EvalMode; registry?: EvaluatorRegistry } = {}) {
  return evaluate({ definition, mode: options.mode ?? (evidence.origin === "live_run" ? "RUNTIME" : "OFFLINE"), evidence, registry: options.registry ?? defaultRegistry() });
}

/** Status plus the failing assertions' reason codes: a compact verdict for assertions in tests. */
export function verdict(result: { status: string; errorCode?: string; assertions: Array<{ id: string; status: string; reasonCode?: string }> }) {
  return { status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}), failed: result.assertions.filter((entry) => entry.status === "failed").map((entry) => `${entry.id}:${entry.reasonCode}`) };
}
