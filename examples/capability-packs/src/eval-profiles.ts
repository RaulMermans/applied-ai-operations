import {
  createEvaluatorRegistry,
  deterministicGraders,
  runEvalDataset,
  type EvalEvidenceBundle,
} from "@aao/evaluation";
import type {
  EvalCase,
  EvalCategory,
  EvalDataset,
  EvalDatasetRun,
  EvalDefinition,
  EvalTargetType,
} from "@aao/contracts";
import type { JsonValue } from "@aao/framework";

export const EVAL_PROFILES = Object.freeze({
  companyResearch: "aao.company-research.evals@1.0.0",
  documentIntelligence: "aao.document-intelligence.evals@1.0.0",
  operationalRequest: "aao.operational-request.evals@1.0.0",
} as const);

const g = (id: string, version = "1.0.0") => ({ id, version });
const OUTCOME = g("aao.run-outcome");
const TRAJECTORY = g("aao.trajectory");
const TOOL_USAGE = g("aao.tool-usage");
const MODEL = g("aao.model-call");
const TRACE = g("aao.trace-contract");
const APPROVAL_COMPLIANCE = g("aao.approval-compliance", "2.0.0");

function createEvalDef(
  id: string,
  graderRef: { id: string; version: string },
  targetType: EvalTargetType,
  categories: EvalCategory[],
  config: Record<string, JsonValue>
): EvalDefinition {
  return {
    schemaVersion: 2,
    id: `pack-eval.${id}`,
    version: "1.0.0",
    name: id,
    categories,
    supportedModes: ["RUNTIME"],
    targetType,
    graderRef,
    config,
  };
}

export interface PackEvalDatasetPackage {
  readonly dataset: EvalDataset;
  readonly definitions: readonly EvalDefinition[];
}

/**
 * Builds the canonical evaluation dataset and definitions for a given Capability Pack evaluation profile.
 */
export function buildPackEvalDataset(profileRef: string, evidenceKey: string): PackEvalDatasetPackage {
  const definitions: EvalDefinition[] = [];
  const cases: EvalCase[] = [];

  switch (profileRef) {
    case EVAL_PROFILES.companyResearch: {
      const outcomeDef = createEvalDef("cr-outcome", OUTCOME, "run", ["capability"], {
        expectedStatus: "COMPLETED",
      });
      const trajectoryDef = createEvalDef("cr-trajectory", TRAJECTORY, "trajectory", ["trajectory"], {
        forbiddenEvents: [{ type: "tool.call.blocked" }],
      });
      const toolDef = createEvalDef("cr-tool-usage", TOOL_USAGE, "tool_use", ["tool_use"], {
        requiredTools: [
          { id: "public_web.search", version: "1.0.0" },
          { id: "records.dedupe", version: "1.0.0" },
          { id: "public_web.fetch_pages", version: "1.0.0" },
          { id: "records.project", version: "1.0.0" },
        ],
      });
      const modelDef = createEvalDef("cr-model-call", MODEL, "run", ["capability"], {
        expectedCalls: { min: 2, max: 2 },
      });
      const traceDef = createEvalDef("cr-trace", TRACE, "run", ["trace_contract"], {
        expectedRunStatus: "COMPLETED",
        compareWithExecution: true,
      });

      definitions.push(outcomeDef, trajectoryDef, toolDef, modelDef, traceDef);
      cases.push(
        { id: "cr-outcome-case", evalRef: { id: outcomeDef.id, version: outcomeDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "cr-trajectory-case", evalRef: { id: trajectoryDef.id, version: trajectoryDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "cr-tool-case", evalRef: { id: toolDef.id, version: toolDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "cr-model-case", evalRef: { id: modelDef.id, version: modelDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "cr-trace-case", evalRef: { id: traceDef.id, version: traceDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } }
      );
      break;
    }

    case EVAL_PROFILES.documentIntelligence: {
      const outcomeDef = createEvalDef("di-outcome", OUTCOME, "run", ["capability"], {
        expectedStatus: "COMPLETED",
      });
      const trajectoryDef = createEvalDef("di-trajectory", TRAJECTORY, "trajectory", ["trajectory"], {
        forbiddenEvents: [{ type: "tool.call.blocked" }],
      });
      const toolDef = createEvalDef("di-tool-usage", TOOL_USAGE, "tool_use", ["tool_use"], {
        requiredTools: [{ id: "document.extract_text", version: "1.0.0" }],
      });
      const modelDef = createEvalDef("di-model-call", MODEL, "run", ["capability"], {
        expectedCalls: { min: 1, max: 1 },
      });
      const traceDef = createEvalDef("di-trace", TRACE, "run", ["trace_contract"], {
        expectedRunStatus: "COMPLETED",
        compareWithExecution: true,
      });

      definitions.push(outcomeDef, trajectoryDef, toolDef, modelDef, traceDef);
      cases.push(
        { id: "di-outcome-case", evalRef: { id: outcomeDef.id, version: outcomeDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "di-trajectory-case", evalRef: { id: trajectoryDef.id, version: trajectoryDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "di-tool-case", evalRef: { id: toolDef.id, version: toolDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "di-model-case", evalRef: { id: modelDef.id, version: modelDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "di-trace-case", evalRef: { id: traceDef.id, version: traceDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } }
      );
      break;
    }

    case EVAL_PROFILES.operationalRequest: {
      const outcomeDef = createEvalDef("or-outcome", OUTCOME, "run", ["capability"], {
        expectedStatus: "COMPLETED",
      });
      const approvalDef = createEvalDef("or-approval", APPROVAL_COMPLIANCE, "approval", ["safety"], {
        approvalRequired: true,
        expectedResolution: "approved",
        guardApprovalNodeId: "require_approval",
        noToolBeforeApproval: true,
      });
      const toolDef = createEvalDef("or-tool-usage", TOOL_USAGE, "tool_use", ["tool_use"], {
        requiredTools: [{ id: "operations.create_change_draft", version: "1.0.0" }],
      });
      const modelDef = createEvalDef("or-model-call", MODEL, "run", ["capability"], {
        expectedCalls: { min: 1, max: 1 },
      });
      const traceDef = createEvalDef("or-trace", TRACE, "run", ["trace_contract"], {
        expectedRunStatus: "COMPLETED",
        compareWithExecution: true,
      });

      definitions.push(outcomeDef, approvalDef, toolDef, modelDef, traceDef);
      cases.push(
        { id: "or-outcome-case", evalRef: { id: outcomeDef.id, version: outcomeDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "or-approval-case", evalRef: { id: approvalDef.id, version: approvalDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "or-tool-case", evalRef: { id: toolDef.id, version: toolDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "or-model-case", evalRef: { id: modelDef.id, version: modelDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "or-trace-case", evalRef: { id: traceDef.id, version: traceDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } }
      );
      break;
    }

    default:
      throw new Error(`Unknown pack eval profile: ${profileRef}`);
  }

  const dataset: EvalDataset = {
    schemaVersion: 2,
    id: `pack-eval-dataset.${profileRef.replace(/[@.]/g, "-")}`,
    version: "1.0.0",
    name: `Capability Pack Evaluation Dataset for ${profileRef}`,
    cases,
  };

  return { dataset, definitions };
}

export interface EvaluatePackRunResult {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly allMatched: boolean;
  readonly run: EvalDatasetRun;
}

/**
 * Runs evaluation for an activated pack run against the canonical Evaluation Runtime.
 */
export async function evaluatePackRun(options: {
  readonly profileRef: string;
  readonly evidenceKey: string;
  readonly evidenceMap: ReadonlyMap<string, EvalEvidenceBundle>;
}): Promise<EvaluatePackRunResult> {
  const { dataset, definitions } = buildPackEvalDataset(options.profileRef, options.evidenceKey);
  const registry = createEvaluatorRegistry(deterministicGraders());
  const evidenceResolver = {
    resolve: (ref: string) => options.evidenceMap.get(ref),
  };

  const outcome = await runEvalDataset({
    dataset,
    definitions,
    registry,
    evidenceResolver,
  });

  if (!outcome.ok) {
    throw new Error(`Eval dataset execution failed: ${outcome.code} (${JSON.stringify(outcome.issues)})`);
  }

  const cases = outcome.run.cases;
  const passedCases = cases.filter((c) => c.result.status === "passed").length;
  const failedCases = cases.filter((c) => c.result.status !== "passed").length;
  const allMatched = cases.every((c) => c.matchesExpectation === true);

  return {
    totalCases: cases.length,
    passedCases,
    failedCases,
    allMatched,
    run: outcome.run,
  };
}
