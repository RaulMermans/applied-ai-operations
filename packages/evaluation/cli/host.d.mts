import type { EvalBaseline, EvalComparisonReport, EvalDataset, EvalDefinition, EvalGateDecision, EvalGatePolicy, EvalReportMetadata, EvalSuiteReport } from "@aao/contracts";
import type { EvalEvidenceBundle } from "../src/index.js";

export const repositoryRoot: string;
export const FOUNDATION: Readonly<{ definitions: string; dataset: string; fixtures: string; policy: string; baseline: string }>;
export class EvalHostError extends Error {
  readonly code: string;
  readonly detail: string;
}
export interface FoundationInputs {
  definitions: EvalDefinition[];
  dataset: EvalDataset;
  fixtures: Map<string, EvalEvidenceBundle>;
  policy: EvalGatePolicy;
  baseline: EvalBaseline;
}
export function loadFoundationInputs(root?: string, paths?: typeof FOUNDATION): FoundationInputs;
export function operationalAggregate(cases: EvalDataset["cases"], fixtures: Map<string, EvalEvidenceBundle>): unknown;
export function runFoundationSuite(params: { definitions: unknown[]; dataset: EvalDataset; fixtures: Map<string, EvalEvidenceBundle>; caseIds?: string[]; metadata?: EvalReportMetadata }): Promise<EvalSuiteReport>;
export type GatePipelineOutcome =
  | { ok: true; suite: EvalSuiteReport; decision: EvalGateDecision; comparison: EvalComparisonReport }
  | { ok: false; error: { code: string; detail: string }; suite?: EvalSuiteReport };
export function runGatePipeline(inputs: FoundationInputs & { caseIds?: string[]; metadata?: EvalReportMetadata }): Promise<GatePipelineOutcome>;
