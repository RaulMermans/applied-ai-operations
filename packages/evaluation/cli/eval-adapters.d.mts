import type { AdapterConformanceReport, AdapterPortabilityResult, AdapterVerificationDriver } from "../src/index.js";
export const CONFORMANCE: Readonly<{ definitions: string; dataset: string }>;
export const recorders: Readonly<Record<string, unknown>>;
export function conformanceDrivers(): Array<{ driver: AdapterVerificationDriver; reference: boolean }>;
export type AdapterConformanceOutcome =
  | { ok: true; passed: boolean; reports: AdapterConformanceReport[]; portability: Array<AdapterPortabilityResult & { kind: string; reference: string }> }
  | { ok: false; error: { code: string; detail: string } };
export function runAdapterConformance(options?: { root?: string; drivers?: Array<{ driver: AdapterVerificationDriver; reference: boolean }> }): Promise<AdapterConformanceOutcome>;
export function renderConformance(outcome: AdapterConformanceOutcome, format: string): { exitCode: number; output: string };
