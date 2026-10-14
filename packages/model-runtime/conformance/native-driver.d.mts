import type { ModelConformanceDriver, ModelConformanceRecorders } from "./drivers.mjs";
export function createNativeModelDriver(options: { recorders: ModelConformanceRecorders }): ModelConformanceDriver & { adapterCalls(): number };
