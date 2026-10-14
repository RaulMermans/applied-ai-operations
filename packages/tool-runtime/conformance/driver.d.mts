/** Structural driver shape (no @aao/evaluation dependency: execution packages never depend on Evaluation). */
export interface ConformanceScenario {
  readonly id: string;
  readonly kind: string;
  readonly parameters: Record<string, unknown>;
}
export interface ConformanceEvidence {
  readonly origin: "live_run";
  readonly runId: string;
  readonly trace: readonly unknown[];
  readonly execution: unknown;
  readonly audit: readonly unknown[];
}
/** The canonical evidence recorders (the @aao/observability factories), injected by the verification host. */
export interface ConformanceRecorders {
  createInMemoryTraceStore(): unknown;
  createTraceRecorder(options: { store: never; clock: { now(): string } }): unknown;
  createInMemoryAuditStore(): unknown;
  createAuditRecorder(options: { store: never; clock: { now(): string } }): unknown;
}
export interface ToolConformanceDriver {
  readonly id: string;
  readonly kind: "tool";
  readonly support: Readonly<Record<string, "SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE">>;
  readonly sensitiveMarkers: readonly string[];
  handlerCalls(): number;
  executeScenario(scenario: ConformanceScenario): Promise<ConformanceEvidence>;
}
export function createNativeToolDriver(options: { recorders: ConformanceRecorders }): ToolConformanceDriver;
export function toolWorkflowPlan(parameters: Record<string, unknown>, workflowId: string): unknown;
export function toolSpec(parameters: Record<string, unknown>): Record<string, unknown>;
export function runToolScenario(params: { scenario: ConformanceScenario; registeredTool: unknown; runId: string; workflowId: string; recorders: ConformanceRecorders }): Promise<ConformanceEvidence>;
