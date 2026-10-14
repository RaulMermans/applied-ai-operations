#!/usr/bin/env node
// `pnpm eval:ci` — the deterministic AAO Eval CI quality gate (Sprint 18, ADR-023).
//
// Loads the Eval definitions and the foundation dataset, verifies pinned
// fixture fingerprints, runs the deterministic dataset, builds the suite
// report, loads the approved baseline and gate policy, compares, applies
// the policy, and prints a concise report. Offline: no network, no
// credentials, no model judge. It reads the baseline and never writes it.
//
// Exit codes: 0 = PASS or WARN (warnings alone pass); 1 = hard failure;
// 1 = configuration/infrastructure error (with a distinct GATE ERROR
// diagnostic and no regression wording). Run after `pnpm build`.
//
//   pnpm eval:ci [-- --format json] [--verbose] [--git-sha <sha>]
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { formatGateDecisionText, formatGateErrorText, gateDecisionJson } from '@aao/evaluation';
import { EvalHostError, loadFoundationInputs, repositoryRoot, runGatePipeline } from './host.mjs';
import { installNetworkGuard } from './network-guard.mjs';

export function parseArgs(argv) {
  const args = argv.filter((arg) => arg !== '--');
  const options = { format: 'text', verbose: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--format') options.format = args[++index];
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--git-sha') options.gitSha = args[++index];
    else throw new EvalHostError('EVAL_GATE_POLICY_INVALID', `unknown argument ${arg}`);
  }
  if (options.format !== 'text' && options.format !== 'json') throw new EvalHostError('EVAL_GATE_POLICY_INVALID', 'format must be text or json');
  return options;
}

/** Render a pipeline outcome. Pure: the same outcome always renders the same bytes. */
export function renderGateOutcome(outcome, options) {
  if (!outcome.ok) {
    const output = options.format === 'json' ? `${JSON.stringify({ gate: { passed: false, outcome: 'ERROR' }, error: outcome.error }, null, 2)}\n` : formatGateErrorText(outcome.error);
    return { exitCode: 1, output };
  }
  const output = options.format === 'json' ? `${JSON.stringify(gateDecisionJson(outcome.decision, outcome.comparison), null, 2)}\n` : formatGateDecisionText(outcome.decision, { verbose: options.verbose, comparison: outcome.comparison });
  return { exitCode: outcome.decision.passed ? 0 : 1, output };
}

/** The full command over the repository's committed assets. Host-supplied release metadata never influences the verdict. */
export async function runEvalCi({ argv = [], root = repositoryRoot } = {}) {
  let options = { format: 'text', verbose: false };
  try {
    options = parseArgs(argv);
    const inputs = loadFoundationInputs(root);
    const metadata = options.gitSha ? { gitSha: options.gitSha } : undefined;
    return renderGateOutcome(await runGatePipeline({ ...inputs, ...(metadata ? { metadata } : {}) }), options);
  } catch (error) {
    const known = error instanceof EvalHostError ? { code: error.code, detail: error.detail } : { code: 'EVAL_GATE_INCOMPLETE_EVIDENCE', detail: 'eval inputs could not be loaded' };
    return renderGateOutcome({ ok: false, error: known }, options);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const guard = installNetworkGuard();
  const result = await runEvalCi({ argv: process.argv.slice(2) });
  process.stdout.write(result.output);
  if (guard.attempts().length > 0) {
    process.stderr.write(`AAO_EVAL_NETWORK_FORBIDDEN: ${guard.attempts().join(', ')}\n`);
    process.exitCode = 1;
  } else process.exitCode = result.exitCode;
}
