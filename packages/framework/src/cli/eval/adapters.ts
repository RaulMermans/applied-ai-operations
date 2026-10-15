// `aao eval adapters` (alias: `pnpm eval:adapters`) and `aao adapters matrix`.
// These run the official adapter conformance through the public contract
// (Sprint 18 verification, Sprint 20 public contract, ADR-025).
//
// The official subjects are imported through explicit package exports
// (`@aao/mcp-connector/conformance`, `@aao/model-runtime/vercel-ai/conformance`),
// never by repository path. The canonical suite ships with @aao/adapters,
// so no evals/ files are read. Each subject runs through the same public
// `verifyAdapterConformance` a third-party adapter uses. The native AAO
// references are the semantic baseline: an adapter must reach the same
// semantic verdict on every case both execute. Everything is local and
// mocked: `ai/test` models and a stdio MCP child process, with no network,
// credentials, live providers, or external side effects.
//
// Exit codes: 0 = every report is complete canonical evidence for its
// manifest (`adapterConformancePassed`) and there is no semantic divergence;
// 1 = otherwise, an incomplete report, or verification could not run.
// UNSUPPORTED and NOT_APPLICABLE are reported, never counted as passes.
import { adapterConformancePassed, buildAdapterCompatibilityMatrix, type AdapterCompatibilityMatrix, type AdapterConformanceReport, type DeferredAdapterEntry } from "@aao/adapters";
import { compareAdapterConformance, type AdapterPortabilityResult } from "@aao/evaluation";
import { createMcpConformanceSubject } from "@aao/mcp-connector/conformance";
import { createVercelAiConformanceSubject } from "@aao/model-runtime/vercel-ai/conformance";
import { nativeModelReference, nativeToolReference, verifyAdapterConformance, type AdapterConformanceSubject } from "../../conformance/index.js";
import type { CommandOutput } from "../output.js";

export interface ConformanceSubjectEntry {
  subject: AdapterConformanceSubject;
  /** Marks the native semantic reference for its kind. */
  reference: boolean;
}

/** Explicit, static subject list: no discovery, no registry, no dynamic import. */
export function officialConformanceSubjects(): ConformanceSubjectEntry[] {
  return [
    { subject: nativeToolReference(), reference: true },
    { subject: createMcpConformanceSubject(), reference: false },
    { subject: nativeModelReference(), reference: true },
    { subject: createVercelAiConformanceSubject(), reference: false },
  ];
}

/** Substrates with no AAO adapter: listed outside the conformance vocabulary, never as UNSUPPORTED. */
export const DEFERRED_ADAPTERS: readonly DeferredAdapterEntry[] = Object.freeze([
  { id: "langgraph", kind: "agent_runtime", status: "DEFERRED", reason: "Sprint 0A research only. No AAO agent_runtime adapter exists, and the native bounded Agent Runtime is the reference semantics." },
]);

export type AdapterConformanceOutcome =
  | { ok: true; passed: boolean; reports: AdapterConformanceReport[]; portability: Array<AdapterPortabilityResult & { kind: string; reference: string }>; matrix: AdapterCompatibilityMatrix }
  | { ok: false; error: { code: string; detail: string } };

export async function runAdapterConformance(options: { subjects?: ConformanceSubjectEntry[] } = {}): Promise<AdapterConformanceOutcome> {
  const subjects = options.subjects ?? officialConformanceSubjects();
  const reports: AdapterConformanceReport[] = [];
  for (const { subject } of subjects) reports.push(await verifyAdapterConformance({ subject }));
  const portability: Array<AdapterPortabilityResult & { kind: string; reference: string }> = [];
  for (const kind of ["tool_provider", "model"]) {
    const reference = reports.find((report, index) => report.adapter.kind === kind && subjects[index]!.reference);
    const candidates = reports.filter((report, index) => report.adapter.kind === kind && !subjects[index]!.reference);
    if (reference && candidates.length > 0) portability.push({ kind, reference: reference.adapter.id, ...compareAdapterConformance({ reference, candidates }) });
  }
  const matrix = buildAdapterCompatibilityMatrix({ entries: subjects.map(({ subject, reference }, index) => ({ manifest: subject.manifest, report: reports[index], reference })), deferred: DEFERRED_ADAPTERS });
  // The matrix above refuses any report that is not complete canonical evidence. PASS also needs a
  // complete report per adapter (never only an intact one) and no semantic divergence.
  const passed = reports.every((report, index) => adapterConformancePassed(report, subjects[index]!.subject.manifest)) && portability.every((entry) => entry.consistent);
  return { ok: true, passed, reports, portability, matrix };
}

export function renderConformance(outcome: AdapterConformanceOutcome, format: "text" | "json"): CommandOutput {
  if (!outcome.ok) return { exitCode: 1, output: format === "json" ? `${JSON.stringify({ passed: false, error: outcome.error }, null, 2)}\n` : `AAO Adapter Conformance\n\nERROR ${outcome.error.code}: ${outcome.error.detail}\n` };
  if (format === "json") return { exitCode: outcome.passed ? 0 : 1, output: `${JSON.stringify({ passed: outcome.passed, reports: outcome.reports, portability: outcome.portability }, null, 2)}\n` };
  const lines = ["AAO Adapter Conformance (contract v1, conformance v1)", ""];
  for (const report of outcome.reports) {
    const { passed, failed, unsupported, notApplicable } = report.summary;
    lines.push(`${report.adapter.id}@${report.adapter.version} (${report.adapter.kind}): ${passed} passed, ${failed} failed, ${unsupported} unsupported, ${notApplicable} not applicable`);
    for (const scenario of report.scenarios) lines.push(`  ${scenario.status.padEnd(14)} ${scenario.scenarioId}`);
  }
  lines.push("");
  for (const entry of outcome.portability) lines.push(`Portability (${entry.kind}, reference ${entry.reference}): ${entry.cases.length} shared cases, ${entry.consistent ? "same semantic verdicts" : `${entry.findings.length} divergence(s)`}`);
  for (const deferred of outcome.matrix.deferred) lines.push(`Deferred: ${deferred.id} (${deferred.kind}): not an implemented adapter`);
  lines.push("", outcome.passed ? "PASS" : "FAIL");
  return { exitCode: outcome.passed ? 0 : 1, output: `${lines.join("\n")}\n` };
}

const MARKDOWN_HEADER = `<!-- GENERATED by \`aao adapters matrix --format markdown\` from adapter manifests and fresh conformance reports. Do not edit by hand. -->

# Adapter compatibility matrix

Generated evidence for the official AAO adapters under adapter contract v1 and conformance suite v1 ([ADR-025](../decisions/ADR-025-adapter-and-portability-contract.md), [adapter contract](../architecture/adapter-contract.md)). Every "Conformance" cell comes from running the canonical scenarios through \`verifyAdapterConformance\`. None is typed by hand, and an adapter appears only with a complete canonical report for its own manifest, so a partial report cannot produce a cell. "Declared" is what the adapter's manifest claims. "Conformance" is what was verified.

**This matrix is not runtime authority.** It cannot enable an adapter, authorize an actor, or grant a permission. A compatible adapter can still be unauthorized for a Run. Governance, Authorization, the Tool support gate, and Approval decide that.
`;

/** Human-readable rendering of the generated matrix. Only formatting happens here: every status comes from the matrix. */
export function renderMatrixMarkdown(matrix: AdapterCompatibilityMatrix): string {
  const lines = [MARKDOWN_HEADER, `Conformance dataset: \`${matrix.datasetRef.id}@${matrix.datasetRef.version}\`.`, ""];
  lines.push("| Adapter | Version | Kind | Contract | Native reference | Capability | Declared | Conformance |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const adapter of matrix.adapters) {
    for (const row of adapter.capabilities) lines.push(`| \`${adapter.id}\` | ${adapter.version} | ${adapter.kind} | v${adapter.adapterContractVersion} | ${adapter.reference ? "yes" : "no"} | \`${row.capability}\` | ${row.declared} | ${row.conformance} |`);
  }
  lines.push("", "## Base invariants", "", "Scenarios that every adapter of the kind must pass, whatever it declares.", "", "| Adapter | Scenario | Conformance |", "| --- | --- | --- |");
  for (const adapter of matrix.adapters) for (const invariant of adapter.baseInvariants) lines.push(`| \`${adapter.id}\` | \`${invariant.scenarioId}\` | ${invariant.status} |`);
  lines.push("", "## Known limitations", "", "Declared by each manifest. They are informational and never change behavior.", "", "| Adapter | Limitation | Description |", "| --- | --- | --- |");
  for (const adapter of matrix.adapters) for (const limitation of adapter.limitations) lines.push(`| \`${adapter.id}\` | \`${limitation.code}\` | ${limitation.description ?? ""} |`);
  lines.push("", "## Deferred, not implemented", "", "These substrates are outside the conformance vocabulary. No adapter exists, so there is nothing to verify, and they are not reported as UNSUPPORTED.", "", "| Substrate | Kind | Status | Reason |", "| --- | --- | --- | --- |");
  for (const entry of matrix.deferred) lines.push(`| ${entry.id} | ${entry.kind} | ${entry.status} | ${entry.reason} |`);
  return `${lines.join("\n")}\n`;
}

/** The command: verification errors are reported as a bounded code, never a stack or a raw driver error. */
export async function runEvalAdapters(options: { format?: "text" | "json"; subjects?: ConformanceSubjectEntry[] } = {}): Promise<CommandOutput> {
  const format = options.format ?? "text";
  try {
    return renderConformance(await runAdapterConformance(options), format);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return renderConformance({ ok: false, error: { code: typeof code === "string" ? code : "ADAPTER_DRIVER_ERROR", detail: "adapter verification could not run" } }, format);
  }
}

/** `aao adapters matrix`: the generated compatibility matrix as JSON (`docs/generated/adapter-compatibility.json`) or Markdown. */
export async function runAdaptersMatrix(options: { format?: "json" | "markdown"; subjects?: ConformanceSubjectEntry[] } = {}): Promise<CommandOutput> {
  try {
    const outcome = await runAdapterConformance(options);
    if (!outcome.ok) return { exitCode: 1, output: `ERROR ${outcome.error.code}: ${outcome.error.detail}\n` };
    const output = options.format === "markdown" ? renderMatrixMarkdown(outcome.matrix) : `${JSON.stringify(outcome.matrix, null, 2)}\n`;
    return { exitCode: outcome.passed ? 0 : 1, output };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return { exitCode: 1, output: `ERROR ${typeof code === "string" ? code : "ADAPTER_DRIVER_ERROR"}: the compatibility matrix could not be generated\n` };
  }
}
