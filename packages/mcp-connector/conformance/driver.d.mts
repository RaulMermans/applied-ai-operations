import type { ConformanceEvidence, ConformanceRecorders, ConformanceScenario } from "../../tool-runtime/conformance/driver.mjs";

export interface McpConformanceDriver {
  readonly id: string;
  readonly kind: "tool";
  readonly support: Readonly<Record<string, "SUPPORTED" | "UNSUPPORTED" | "NOT_APPLICABLE">>;
  readonly sensitiveMarkers: readonly string[];
  serverCalls(scenarioId: string): number | undefined;
  executeScenario(scenario: ConformanceScenario): Promise<ConformanceEvidence>;
}
export function createMcpConnectorDriver(options: { recorders: ConformanceRecorders }): McpConformanceDriver;
