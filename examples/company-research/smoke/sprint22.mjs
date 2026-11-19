// Sprint 22 compiled smoke: the Company Research proof, using compiled
// package output only (run after `pnpm build`). Every AAO import resolves
// to dist/ through package exports. No network, credentials, or provider.
//
//  1. Deterministic fixture public-web provider.   2. Scripted model adapter.
//  3. Build the Company Research Workflow.          4. Submit a fictional request.
//  5. Planner proposes bounded queries.             6. public_web.search via the Tool Runtime.
//  7. records.dedupe removes duplicate URLs.        8. public_web.fetch_pages via the Tool Runtime.
//  9. records.project reduces evidence fields.     10. Synthesis emits cited structured findings.
// 11. Grounding validator verifies every ref.      12. Deterministic Markdown renders.
// 13. The Run COMPLETES.                           14. The Eval suite passes expected cases.
// 15. An unauthorized principal: 0 provider calls. 16. An unknown citation is rejected.
// 17. The prompt-injection source stays untrusted data.
// Then: the compiled proof imports only public packages, and
// `pnpm pack` of @aao/integration-public-web contains only intentional files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { createEvaluatorRegistry, deterministicGraders, runEvalDataset } from '@aao/evaluation';
import { createInMemoryTraceStore, createTraceRecorder, validateTrace } from '@aao/observability';
import { COMPANY_RESEARCH_NODE_ORDER, SYNTHESIS_INSTRUCTIONS } from '@aao/example-company-research';
import { ACME_DRAFT, ACME_REQUEST, INJECTION_TEXT, SECRET, SOURCE_IDS, createFixtureProof, drafter, fixedClock } from '../dist/fixtures/index.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = join(exampleRoot, '..', '..');
const v1 = (id) => ({ id, version: '1.0.0' });

// --- 1–13. The happy path on compiled output. ---
const store = createInMemoryTraceStore();
const { proof, provider, model } = createFixtureProof({ trace: createTraceRecorder({ store, clock: fixedClock() }) });
assert(proof.workflow.id === 'company_research.proof' && /^[a-f0-9]{64}$/.test(proof.planFingerprint), 'the Workflow did not prepare');
const outcome = await proof.run({ runId: 'run.smoke', request: ACME_REQUEST });
assert(outcome.status === 'completed', `the Run did not complete: ${JSON.stringify(outcome.failure)}`);
const trace = await store.getRunTrace('run.smoke');
assert(validateTrace(trace).valid, 'the Trace is invalid');
const nodes = trace.filter((event) => event.type === 'node.completed').map((event) => event.nodeId);
assert(JSON.stringify(nodes) === JSON.stringify(COMPANY_RESEARCH_NODE_ORDER), `unexpected trajectory: ${nodes}`);
const tools = trace.filter((event) => event.type === 'tool.call.started').map((event) => event.payload.toolRef.id);
assert(JSON.stringify(tools) === '["public_web.search","records.dedupe","public_web.fetch_pages","records.project"]', `unexpected Tool calls: ${tools}`);
assert(model.requests.length === 2 && trace.filter((event) => event.type === 'model.call.started').length === 2, 'expected exactly two model calls');
assert(provider.calls.search.length === 3 && provider.calls.fetch.length === 4 && new Set(provider.calls.fetch).size === 4, `provider budget is wrong: ${JSON.stringify(provider.calls)}`);
const state = outcome.execution.execution.state.values;
assert(state.dedupeResult.output.meta.duplicatesRemoved === 4, 'records.dedupe did not remove duplicate URLs');
assert(state.projectResult.output.data.records.every((record) => Object.keys(record).join() === 'sourceId,url,title,text,truncated'), 'records.project did not reduce fields');
const { result } = outcome;
assert(result.schemaVersion === 1 && result.coverage.questionsAnswered === 3 && result.coverage.sourcesCited === 3, `unexpected coverage: ${JSON.stringify(result.coverage)}`);
assert(result.sourceIndex.map((entry) => entry.label).join() === 'S1,S2,S3', 'citation labels are wrong');
assert(result.markdown.startsWith('# Company Research — Acme Analytics\n') && result.markdown.includes('[S1]'), 'Markdown did not render');
const again = await createFixtureProof().proof.run({ runId: 'run.smoke', request: ACME_REQUEST });
assert(again.status === 'completed' && again.result.markdown === result.markdown, 'Markdown is not deterministic');
assert(!JSON.stringify(trace).includes(SECRET), 'Trace carries a secret');

// --- 14. The existing Evaluation Runtime and graders judge the Run. ---
const def = (id, graderId, targetType, config) => ({ schemaVersion: 2, id: `smoke.${id}`, version: '1.0.0', name: id, categories: ['capability'], supportedModes: ['RUNTIME'], targetType, graderRef: v1(graderId), config });
const definitions = [
  def('completed', 'aao.run-outcome', 'run', { expectedStatus: 'COMPLETED' }),
  def('tools', 'aao.tool-usage', 'tool_use', { requiredOrder: [v1('public_web.search'), v1('records.dedupe'), v1('public_web.fetch_pages'), v1('records.project')], callLimits: [{ count: 'physical', max: 4 }], forbiddenTools: [v1('records.sort')] }),
  def('models', 'aao.model-call', 'run', { expectedCalls: { min: 2, max: 2 }, expectedOutcome: 'completed' }),
  def('trace', 'aao.trace-contract', 'run', { expectedRunStatus: 'COMPLETED', compareWithExecution: true }),
  def('negative', 'aao.tool-usage', 'tool_use', { requiredTools: [v1('records.sort')] }),
];
const expected = ['passed', 'passed', 'passed', 'passed', 'failed'];
const judged = await runEvalDataset({
  dataset: { schemaVersion: 2, id: 'smoke.company-research', version: '1.0.0', name: 'company research', cases: definitions.map((definition, index) => ({ id: `${definition.id}.001`, evalRef: { id: definition.id, version: '1.0.0' }, mode: 'RUNTIME', evidenceRef: 'run://smoke', expected: { status: expected[index], ...(expected[index] === 'failed' ? { reasonCodes: ['TOOL_NOT_INVOKED'] } : {}) } })) },
  definitions,
  registry: createEvaluatorRegistry(deterministicGraders()),
  evidenceResolver: { resolve: (ref) => (ref === 'run://smoke' ? { origin: 'live_run', runId: 'run.smoke', trace, execution: outcome.execution.execution } : undefined) },
});
assert(judged.ok && JSON.stringify(judged.run.cases.map((entry) => entry.result.status)) === JSON.stringify(expected), `the Eval suite did not match: ${JSON.stringify(judged)}`);

// --- 15. Unauthorized principal: canonical denial, zero provider calls. ---
const denied = createFixtureProof({ principal: drafter });
const deniedOutcome = await denied.proof.run({ runId: 'run.smoke.denied', request: ACME_REQUEST });
assert(deniedOutcome.status === 'failed' && deniedOutcome.failure.executorFailure?.code === 'TOOL_AUTHORIZATION_DENIED', `expected an Authorization denial: ${JSON.stringify(deniedOutcome)}`);
assert(denied.provider.calls.search.length === 0 && denied.provider.calls.fetch.length === 0, 'the provider was called for an unauthorized principal');

// --- 16. An unknown citation is rejected; no report is rendered. ---
const forged = JSON.parse(JSON.stringify(ACME_DRAFT));
forged.answers[0].findings[0].sourceRefs = ['src.does-not-exist'];
const rejected = await createFixtureProof({ outputs: { draft: forged } }).proof.run({ runId: 'run.smoke.citation', request: ACME_REQUEST });
assert(rejected.status === 'failed' && rejected.failure.executorFailure?.code === 'GROUNDING_UNKNOWN_SOURCE_REF' && rejected.execution.execution.state.values.researchResult === undefined, `the unknown citation was not rejected: ${JSON.stringify(rejected.failure)}`);

// --- 17. Prompt-injection source text is data in the user message only. ---
const synthesis = model.requests[1];
assert(synthesis.messages[0].role === 'system' && synthesis.messages[0].content === SYNTHESIS_INSTRUCTIONS && !synthesis.messages[0].content.includes('IGNORE ALL'), 'the system message changed');
const data = JSON.parse(synthesis.messages[1].content);
assert(data.sources.find((source) => source.sourceId === SOURCE_IDS.review).text.includes(INJECTION_TEXT), 'the injected source is not carried as evidence data');
assert(JSON.stringify(synthesis).split('IGNORE ALL PREVIOUS INSTRUCTIONS').length === 2, 'injected text appears outside the evidence field');

// --- Compiled proof imports only public packages. ---
const compiledImports = new Set(readdirSync(join(exampleRoot, 'dist', 'src')).filter((file) => file.endsWith('.js')).flatMap((file) => [...readFileSync(join(exampleRoot, 'dist', 'src', file), 'utf8').matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])).filter((specifier) => !specifier.startsWith('.')));
assert(JSON.stringify([...compiledImports].sort()) === '["@aao/framework","@aao/integration-public-web","@aao/toolbox"]', `the compiled proof imports more than public packages: ${[...compiledImports]}`);

// --- Integration package: exports and pack (never publish). ---
const integrationRoot = join(repositoryRoot, 'packages', 'integration-public-web');
const integration = await import('@aao/integration-public-web');
const expectedExports = ['PUBLIC_WEB_FETCH_TOOL_REF', 'PUBLIC_WEB_LIMITS', 'PUBLIC_WEB_SEARCH_TOOL_REF', 'canonicalizePublicWebUrl', 'createPublicWebTools', 'publicWebSourceId'];
assert(JSON.stringify(Object.keys(integration).sort()) === JSON.stringify(expectedExports), `unexpected integration exports: ${Object.keys(integration)}`);
const packDir = mkdtempSync(join(tmpdir(), 'aao-integration-pack-'));
let entries;
try {
  execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: integrationRoot, stdio: 'pipe' });
  const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
  assert(tarball, 'pnpm pack produced no tarball');
  entries = execFileSync('tar', ['-tzf', join(packDir, tarball)], { encoding: 'utf8' }).trim().split('\n').sort();
  const unexpected = entries.filter((entry) => !/^package\/(package\.json|README\.md|LICENSE|dist\/.+\.(js|d\.ts))$/.test(entry));
  assert(unexpected.length === 0, `unexpected packed files: ${unexpected.join(', ')}`);
  for (const required of ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/dist/index.js', 'package/dist/index.d.ts', 'package/dist/tools.js', 'package/dist/provider.d.ts']) assert(entries.includes(required), `missing packed file ${required}`);
  assert(!entries.some((entry) => /test|fixture|smoke|\.map$|\.env|\.log$|src\//.test(entry)), 'pack leaked tests, fixtures, maps, env, logs, or sources');
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ workflow: `${proof.workflow.id}@${proof.workflow.version}`, planFingerprint: proof.planFingerprint.slice(0, 12), nodes: nodes.length, tools, modelCalls: model.requests.length, providerCalls: { search: provider.calls.search.length, fetch: provider.calls.fetch.length }, coverage: result.coverage, citations: result.sourceIndex.map((entry) => entry.label), eval: judged.run.cases.map((entry) => entry.result.status), denied: { code: deniedOutcome.failure.executorFailure.code, providerCalls: 0 }, unknownCitation: rejected.failure.executorFailure.code, injection: 'data-only', integrationPack: { files: entries.length } })}\n`);
process.stdout.write('SPRINT_22_COMPANY_RESEARCH_PROOF_SMOKE_OK\n');
