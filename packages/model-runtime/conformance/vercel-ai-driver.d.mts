import type { ModelConformanceDriver, ModelConformanceRecorders } from "./drivers.mjs";
export function createVercelAiDriver(options: { recorders: ModelConformanceRecorders }): ModelConformanceDriver & { providerCalls(scenarioId: string): number | undefined };
