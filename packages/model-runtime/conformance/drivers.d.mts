export interface ModelConformanceScenario {
  readonly id: string;
  readonly kind: string;
  readonly parameters: Record<string, unknown>;
}
export interface ModelConformanceEvidence {
  readonly origin: "live_run";
  readonly runId: string;
  readonly trace: readonly unknown[];
  readonly execution: unknown;
}
export interface ModelConformanceDriver {
  readonly id: string;
  readonly kind: "model";
  readonly support: Readonly<Record<string, "SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE">>;
  readonly sensitiveMarkers: readonly string[];
  executeScenario(scenario: ModelConformanceScenario): Promise<ModelConformanceEvidence>;
}
export interface ModelConformanceRecorders {
  createInMemoryTraceStore(): unknown;
  createTraceRecorder(options: { store: never; clock: { now(): string } }): unknown;
}
