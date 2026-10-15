// Sprint 18 compiled smoke: Eval analytics, CI gates, and adapter verification.
// Run after `pnpm build`; uses only dist/ (every @aao/* import resolves to
// compiled output; the substrate drivers are plain ESM). Since Sprint 19 the
// Eval CI host is the canonical `aao` CLI, so this smoke drives its compiled
// output in @aao/framework (smoke-only; no Core source imports Framework).
//
//  1. Sprint 17 closure: the multi-Approval regression through the real
//     aao.approval-compliance 2.0.0 grader — Approval A approved, Approval B
//     pending, Tool B started → FAILED APPROVAL_BYPASSED.
//  2. Load the foundation dataset, verify pinned fixture fingerprints, run
//     the deterministic suite, build the SuiteReport, load the approved
//     baseline, compare, and apply the foundation-ci policy → PASS.
//  3. A fixture mutation is refused before evaluation; a critical regression
//     hard-fails.
//  4. Adapter conformance subset across the native, MCP, and Vercel AI SDK
//     substrates → every SUPPORTED scenario passes, same semantic verdicts.
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEvaluatorRegistry, deterministicGraders, evaluate, evidenceFingerprint, parseEvalDefinitions } from '@aao/evaluation';
import { URL, fileURLToPath } from 'node:url';
import { renderGateOutcome } from '../../../framework/dist/cli/eval/ci.js';
import { runAdapterConformance } from '../../../framework/dist/cli/eval/adapters.js';
import { loadFoundationInputs, runGatePipeline } from '../../../framework/dist/cli/eval/host.js';
import { installNetworkGuard } from '../../../framework/dist/cli/eval/network-guard.js';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const guard = installNetworkGuard();

// --- 1. Sprint 17 closure through the real grader. ---
const definitions = parseEvalDefinitions(readFileSync(join(repositoryRoot, 'evals', 'definitions', 'runtime-foundation.v1.yaml'), 'utf8'), 'yaml');
assert(definitions.ok, 'definitions invalid');
const guarded = definitions.value.find((entry) => entry.id === 'approval.crm-update-guarded');
assert(guarded.graderRef.version === '2.0.0' && guarded.config.guardApprovalNodeId === 'approve-crm-update', 'guarded definition is not bound to its guard Node');
const fixture = (name) => JSON.parse(readFileSync(join(repositoryRoot, 'evals', 'fixtures', `${name}.json`), 'utf8'));
const registry = createEvaluatorRegistry(deterministicGraders());
const closure = await evaluate({ definition: guarded, mode: 'OFFLINE', evidence: fixture('multi-approval-unrelated-approval'), registry });
const closureReasons = closure.assertions.filter((entry) => entry.status === 'failed').map((entry) => entry.reasonCode);
assert(closure.status === 'failed' && closureReasons.join() === 'APPROVAL_BYPASSED', `multi-Approval bypass not detected: ${closure.status} ${closureReasons}`);
const guardApproved = await evaluate({ definition: guarded, mode: 'OFFLINE', evidence: fixture('multi-approval-both-approved'), registry });
assert(guardApproved.status === 'passed', 'the guard approval did not authorize its Tool');

// --- 2. Deterministic suite → baseline comparison → foundation-ci gate. ---
const inputs = loadFoundationInputs(repositoryRoot);
const outcome = await runGatePipeline(inputs);
assert(outcome.ok, `gate error: ${JSON.stringify(outcome.error)}`);
const { suite, decision } = outcome;
assert(suite.summary.expectationsMatched === suite.summary.casesTotal, 'not every case matched its expectation');
assert(suite.summary.rawStatuses.failed > 0 && suite.summary.rawStatuses.error > 0, 'negative and deliberate-error cases are missing');
assert(decision.passed && decision.comparisonSummary.regressions === 0 && decision.hardFailures.length === 0, `gate did not pass: ${JSON.stringify(decision.hardFailures)}`);
assert(renderGateOutcome(outcome, { format: 'text' }).exitCode === 0, 'PASS did not exit 0');
const repeat = await runGatePipeline(loadFoundationInputs(repositoryRoot));
assert(JSON.stringify(repeat) === JSON.stringify(outcome), 'gate is not deterministic');

// --- 3. Fixture mutation is refused; a critical regression hard-fails. ---
const tampered = JSON.parse(JSON.stringify(inputs.fixtures.get('fixture://flagship-approved')));
tampered.trace[0].payload.nodeCount += 1;
const mutated = await runGatePipeline({ ...inputs, fixtures: new Map([...inputs.fixtures, ['fixture://flagship-approved', tampered]]) });
assert(!mutated.ok && mutated.error.code === 'EVAL_FIXTURE_FINGERPRINT_MISMATCH' && mutated.suite === undefined, 'fixture mutation was not refused before evaluation');
const regressedEvidence = fixture('flagship-approved');
const regressed = await runGatePipeline({
  ...inputs,
  fixtures: new Map([...inputs.fixtures, ['fixture://smoke-regression', regressedEvidence]]),
  dataset: { ...inputs.dataset, cases: inputs.dataset.cases.map((evalCase) => (evalCase.id === 'approval.bypass-detected.001' ? { ...evalCase, evidenceRef: 'fixture://smoke-regression', evidenceFingerprint: evidenceFingerprint(regressedEvidence) } : evalCase)) },
});
assert(regressed.ok && !regressed.decision.passed && regressed.decision.hardFailures.some((failure) => failure.code === 'EVAL_GATE_CRITICAL_REGRESSION'), 'critical Approval regression did not hard-fail');
assert(renderGateOutcome(regressed, { format: 'text' }).exitCode === 1, 'hard failure did not exit 1');

// --- 4. Adapter conformance subset. ---
// Since Sprint 20 the suite ships with @aao/adapters and reports use the public AdapterConformanceReport v1 summary.
const conformance = await runAdapterConformance();
assert(conformance.ok && conformance.passed, 'adapter conformance failed');
const supported = Object.fromEntries(conformance.reports.map((report) => [report.adapter.id, `${report.summary.passed}/${report.summary.passed + report.summary.failed}${report.summary.unsupported ? ` +${report.summary.unsupported} unsupported` : ''}${report.summary.notApplicable ? ` +${report.summary.notApplicable} n/a` : ''}`]));
assert(conformance.portability.every((entry) => entry.consistent && entry.cases.length > 0), 'semantic verdicts diverged across substrates');
assert(guard.attempts().length === 0, `network access attempted: ${guard.attempts()}`);

process.stdout.write(`${JSON.stringify({
  closure: { multiApprovalBypass: `${closure.status}:${closureReasons}`, guardApproved: guardApproved.status },
  suite: { dataset: `${suite.datasetRef.id}@${suite.datasetRef.version}`, cases: suite.summary.casesTotal, matched: suite.summary.expectationsMatched, rawStatuses: suite.summary.rawStatuses },
  gate: { policy: `${decision.policyRef.id}@${decision.policyRef.version}`, baseline: `${decision.baselineRef.id}@${decision.baselineRef.version}`, outcome: decision.outcome, regressions: decision.comparisonSummary.regressions, criticalFailures: 0, warnings: decision.warnings.length },
  negative: { fixtureMutation: mutated.error.code, criticalRegression: regressed.decision.outcome },
  adapters: supported,
  portability: conformance.portability.map((entry) => `${entry.kind}:${entry.cases.length} shared, consistent=${entry.consistent}`),
})}\n`);
process.stdout.write('SPRINT_18_EVAL_ANALYTICS_CI_ADAPTER_VERIFICATION_SMOKE_OK\n');
