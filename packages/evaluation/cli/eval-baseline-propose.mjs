#!/usr/bin/env node
// `pnpm eval:baseline:propose -- --id <id> --version <version>` (Sprint 18, ADR-023).
//
// Prints a baseline PROPOSAL generated from the current deterministic suite
// to stdout. It writes no file and never touches evals/baselines/: a human
// reviews the proposal, commits it as a new baseline version, and re-pins
// the gate policy's baselineRef deliberately. There is no accept-everything flag, and
// a proposal is never a way to lower expectations after a regression —
// review the gate findings first.
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { evalBaselineFingerprint, parseEvalDataset, parseEvalDefinitions, proposeEvalBaseline } from '@aao/evaluation';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EvalHostError, FOUNDATION, repositoryRoot, runFoundationSuite } from './host.mjs';
import { installNetworkGuard } from './network-guard.mjs';

export async function proposeBaseline({ argv = [], root = repositoryRoot } = {}) {
  const args = argv.filter((arg) => arg !== '--');
  const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const id = value('--id');
  const version = value('--version');
  if (!id || !version) return { exitCode: 1, output: 'usage: pnpm eval:baseline:propose -- --id <baseline-id> --version <version>\n' };
  try {
    const definitions = parseEvalDefinitions(readFileSync(join(root, FOUNDATION.definitions), 'utf8'), 'yaml');
    const dataset = parseEvalDataset(readFileSync(join(root, FOUNDATION.dataset), 'utf8'), 'yaml');
    if (!definitions.ok || !dataset.ok) throw new EvalHostError('EVAL_DATASET_INVALID', 'definitions or dataset are invalid');
    const fixtures = new Map(readdirSync(join(root, FOUNDATION.fixtures)).filter((file) => file.endsWith('.json')).sort().map((file) => [`fixture://${file.slice(0, -5)}`, JSON.parse(readFileSync(join(root, FOUNDATION.fixtures, file), 'utf8'))]));
    const suite = await runFoundationSuite({ definitions: definitions.value, dataset: dataset.value, fixtures });
    const baseline = proposeEvalBaseline({ suite, id, version, description: `Accepted evaluation state of ${suite.datasetRef.id}@${suite.datasetRef.version}.` });
    const proposal = {
      kind: 'aao.eval-baseline-proposal',
      notice: 'PROPOSAL ONLY — nothing was written. Review every case (especially any not MATCHED), commit `baseline` as a NEW file under evals/baselines/, and update the gate policy baselineRef (id, version, fingerprint) and policy version in the same reviewed change.',
      unmatchedCases: suite.cases.filter((entry) => entry.expectation !== 'MATCHED').map((entry) => entry.caseId),
      baselineRef: { id, version, fingerprint: evalBaselineFingerprint(baseline) },
      baseline,
    };
    return { exitCode: 0, output: `${JSON.stringify(proposal, null, 2)}\n` };
  } catch (error) {
    return { exitCode: 1, output: `GATE ERROR ${error.code ?? 'EVAL_DATASET_INVALID'}: ${error.detail ?? 'proposal failed'}\n` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const guard = installNetworkGuard();
  const result = await proposeBaseline({ argv: process.argv.slice(2) });
  process.stdout.write(result.output);
  process.exitCode = guard.attempts().length > 0 ? 1 : result.exitCode;
}
