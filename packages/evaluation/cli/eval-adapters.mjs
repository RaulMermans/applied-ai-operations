#!/usr/bin/env node
// `pnpm eval:adapters` — deterministic adapter conformance verification (Sprint 18, ADR-023).
//
// Each substrate's own test driver (living with that substrate) turns the
// canonical scenarios into canonical AAO evidence; the existing Evaluation
// Runtime judges it with the adapter-conformance definitions. Native AAO
// drivers are the semantic reference: an adapter must reach the same
// semantic verdict on every case both execute. Local and mocked only — no
// network, credentials, live providers, or external side effects (the MCP
// server is a local stdio child process). Not the public Adapter contract
// (Sprint 20).
//
// Exit codes: 0 = every SUPPORTED scenario passed and no semantic
// divergence; 1 = a SUPPORTED scenario failed, diverged, or verification
// could not run. UNSUPPORTED / NOT_APPLICABLE scenarios are reported, never
// counted as passes. Run after `pnpm build`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { compareAdapterConformance, createEvaluatorRegistry, deterministicGraders, parseEvalDataset, parseEvalDefinitions, verifyAdapter } from '@aao/evaluation';
import { createAuditRecorder, createInMemoryAuditStore, createInMemoryTraceStore, createTraceRecorder } from '@aao/observability';
import { createMcpConnectorDriver } from '../../mcp-connector/conformance/driver.mjs';
import { createNativeModelDriver } from '../../model-runtime/conformance/native-driver.mjs';
import { createVercelAiDriver } from '../../model-runtime/conformance/vercel-ai-driver.mjs';
import { createNativeToolDriver } from '../../tool-runtime/conformance/driver.mjs';
import { repositoryRoot } from './host.mjs';
import { installNetworkGuard } from './network-guard.mjs';

export const CONFORMANCE = Object.freeze({ definitions: 'evals/definitions/adapter-conformance.v1.yaml', dataset: 'evals/datasets/adapter-conformance-foundation.v1.yaml' });

/** The canonical evidence recorders, injected into every driver by this verification host. */
export const recorders = Object.freeze({ createInMemoryTraceStore, createTraceRecorder, createInMemoryAuditStore, createAuditRecorder });

/** Explicit, static driver list: no discovery, no registry, no dynamic import. `reference` marks the native semantic reference per kind. */
export function conformanceDrivers() {
  return [
    { driver: createNativeToolDriver({ recorders }), reference: true },
    { driver: createMcpConnectorDriver({ recorders }), reference: false },
    { driver: createNativeModelDriver({ recorders }), reference: true },
    { driver: createVercelAiDriver({ recorders }), reference: false },
  ];
}

export async function runAdapterConformance({ root = repositoryRoot, drivers = conformanceDrivers() } = {}) {
  const definitions = parseEvalDefinitions(readFileSync(join(root, CONFORMANCE.definitions), 'utf8'), 'yaml');
  const dataset = parseEvalDataset(readFileSync(join(root, CONFORMANCE.dataset), 'utf8'), 'yaml');
  if (!definitions.ok || !dataset.ok) return { ok: false, error: { code: 'EVAL_DATASET_INVALID', detail: 'adapter conformance definitions or dataset are invalid' } };
  const registry = createEvaluatorRegistry(deterministicGraders());
  const reports = [];
  for (const { driver } of drivers) reports.push(await verifyAdapter({ driver, dataset: dataset.value, definitions: definitions.value, registry }));
  const portability = [];
  for (const kind of ['tool', 'model']) {
    const reference = reports.find((report, index) => report.adapter.kind === kind && drivers[index].reference);
    const candidates = reports.filter((report, index) => report.adapter.kind === kind && !drivers[index].reference);
    if (reference && candidates.length > 0) portability.push({ kind, reference: reference.adapter.id, ...compareAdapterConformance({ reference, candidates }) });
  }
  const passed = reports.every((report) => report.failed === 0) && portability.every((entry) => entry.consistent);
  return { ok: true, passed, reports, portability };
}

export function renderConformance(outcome, format) {
  if (!outcome.ok) return { exitCode: 1, output: format === 'json' ? `${JSON.stringify({ passed: false, error: outcome.error }, null, 2)}\n` : `AAO Adapter Conformance\n\nERROR ${outcome.error.code}: ${outcome.error.detail}\n` };
  if (format === 'json') return { exitCode: outcome.passed ? 0 : 1, output: `${JSON.stringify({ passed: outcome.passed, reports: outcome.reports, portability: outcome.portability }, null, 2)}\n` };
  const lines = ['AAO Adapter Conformance', ''];
  for (const report of outcome.reports) {
    lines.push(`${report.adapter.id} (${report.adapter.kind}): ${report.passed}/${report.supported} supported passed, ${report.failed} failed, ${report.unsupported} unsupported, ${report.notApplicable} not applicable`);
    for (const scenario of report.scenarios) lines.push(`  ${scenario.status.padEnd(14)} ${scenario.scenarioId}`);
  }
  lines.push('');
  for (const entry of outcome.portability) lines.push(`Portability (${entry.kind}, reference ${entry.reference}): ${entry.cases.length} shared cases, ${entry.consistent ? 'same semantic verdicts' : `${entry.findings.length} divergence(s)`}`);
  lines.push('', outcome.passed ? 'PASS' : 'FAIL');
  return { exitCode: outcome.passed ? 0 : 1, output: `${lines.join('\n')}\n` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'text';
  const guard = installNetworkGuard();
  let result;
  try {
    result = renderConformance(await runAdapterConformance(), format);
  } catch (error) {
    result = renderConformance({ ok: false, error: { code: error.code ?? 'ADAPTER_DRIVER_ERROR', detail: 'adapter verification could not run' } }, format);
  }
  process.stdout.write(result.output);
  if (guard.attempts().length > 0) {
    process.stderr.write(`AAO_EVAL_NETWORK_FORBIDDEN: ${guard.attempts().join(', ')}\n`);
    process.exitCode = 1;
  } else process.exitCode = result.exitCode;
}
