import type { GatePipelineOutcome } from "./host.mjs";
export function parseArgs(argv: string[]): { format: "text" | "json"; verbose: boolean; gitSha?: string };
export function renderGateOutcome(outcome: GatePipelineOutcome, options: { format: "text" | "json"; verbose?: boolean }): { exitCode: number; output: string };
export function runEvalCi(options?: { argv?: string[]; root?: string }): Promise<{ exitCode: number; output: string }>;
