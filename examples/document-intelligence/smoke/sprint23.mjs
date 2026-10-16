// Sprint 23 compiled smoke: the Document Intelligence proof, using compiled
// package output only (run after `pnpm build`). Every AAO import resolves
// to dist/ through package exports. No network, credentials, or provider.
//
//  1. Deterministic fixture document provider.       2. Scripted model adapter.
//  3. Build the Document Intelligence Workflow.       4. Submit a bounded request.
//  5. Intake validates and prepares Tool input.       6. document.extract_text via Tool Runtime.
//  7. validate_document verifies pages and identity.  8. segment_document computes exact spans.
//  9. admit_evidence caps context budget.            10. Synthesis emits cited structured findings.
// 11. Grounding validator verifies every ref.        12. Deterministic Markdown renders.
// 13. The Run COMPLETES.                             14. The Eval suite passes expected cases.
// 15. Unauthorized principal: 0 provider calls.      16. An unknown citation is rejected.
// 17. The prompt-injection source stays data-only.   18. Raw bytes never enter state or trace.
// Then: compiled proof imports only public packages, and
// `pnpm pack` of @aao/integration-documents contains only intentional files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { createEvaluatorRegistry, deterministicGraders, runEvalDataset } from '@aao/evaluation';
import { createInMemoryTraceStore, createTraceRecorder, validateTrace } from '@aao/observability';
import { DOCUMENT_INTELLIGENCE_NODE_ORDER, SYNTHESIS_INSTRUCTIONS } from '@aao/example-document-intelligence';
import {
  ACME_DOCUMENT_REF,
  SAMPLE_QUESTIONS,
  SECRET_TOKEN,
  createFixtureProof,
  fixedClock,
  unauthorizedUser,
} from '../dist/fixtures/index.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = join(exampleRoot, '..', '..');
const v1 = (id) => ({ id, version: '1.0.0' });

// --- 1–13. The happy path on compiled output. ---
const store = createInMemoryTraceStore();
const { proof, provider, model } = createFixtureProof({
  trace: createTraceRecorder({ store, clock: fixedClock() }),
});

assert(
  proof.workflow.id === 'document_intelligence.proof' && /^[a-f0-9]{64}$/.test(proof.planFingerprint),
  'the Workflow did not prepare'
);

const outcome = await proof.run({
  runId: 'run.smoke.doc-intel',
  request: {
    documentRef: ACME_DOCUMENT_REF,
    questions: SAMPLE_QUESTIONS,
  },
});

assert(outcome.status === 'completed', `the Run did not complete: ${JSON.stringify(outcome.failure)}`);

const trace = await store.getRunTrace('run.smoke.doc-intel');
assert(validateTrace(trace).valid, 'the Trace is invalid');

const nodes = trace.filter((event) => event.type === 'node.completed').map((event) => event.nodeId);
assert(
  JSON.stringify(nodes) === JSON.stringify(DOCUMENT_INTELLIGENCE_NODE_ORDER),
  `unexpected trajectory: ${JSON.stringify(nodes)}`
);

const tools = trace.filter((event) => event.type === 'tool.call.started').map((event) => event.payload.toolRef.id);
assert(JSON.stringify(tools) === '["document.extract_text"]', `unexpected Tool calls: ${tools}`);

assert(
  model.requests.length === 1 && trace.filter((event) => event.type === 'model.call.started').length === 1,
  'expected exactly one model call'
);

assert(
  provider.calls.length === 1 && provider.calls[0].ref === ACME_DOCUMENT_REF,
  `unexpected provider calls: ${JSON.stringify(provider.calls)}`
);

const state = outcome.execution.execution.state.values;
assert(state.extractResult?.output?.data?.pages?.length === 3, 'document.extract_text did not extract 3 pages');
assert(
  state.evidenceSpans?.length > 0 && state.evidenceSpans[0].evidenceId.startsWith('ev.'),
  'evidenceSpans are missing or invalid'
);
assert(state.admittedEvidence?.admission?.admittedSpans > 0, 'admittedEvidence is empty');

const { result } = outcome;
assert(
  result.schemaVersion === 1 &&
    result.coverage.questionsTotal === 4 &&
    result.coverage.questionsAnswered === 3 &&
    result.coverage.questionsInsufficient === 1,
  `unexpected coverage: ${JSON.stringify(result.coverage)}`
);
assert(result.evidenceIndex.length === 3, `unexpected evidence index count: ${result.evidenceIndex.length}`);
assert(
  result.evidenceIndex.map((e) => e.citationId).join() === 'E1,E2,E3',
  'citation IDs are not E1,E2,E3'
);
assert(
  result.markdown.startsWith('# Document Intelligence — acme-contract-2026.pdf\n') &&
    result.markdown.includes('[E1]'),
  'Markdown did not render expected content'
);

// Determinism check: second identical run produces byte-identical markdown
const again = await createFixtureProof().proof.run({
  runId: 'run.smoke.doc-intel-again',
  request: {
    documentRef: ACME_DOCUMENT_REF,
    questions: SAMPLE_QUESTIONS,
  },
});
assert(again.status === 'completed' && again.result.markdown === result.markdown, 'Markdown is not deterministic');

// Security check: raw bytes and secrets never in state or trace
const traceStr = JSON.stringify(trace);
assert(!traceStr.includes(SECRET_TOKEN), 'Trace carries a secret token');
assert(!traceStr.includes('Uint8Array') && !traceStr.includes('%PDF-1.4'), 'Trace carries raw PDF bytes');
const stateStr = JSON.stringify(state);
assert(!stateStr.includes('Uint8Array') && !stateStr.includes('%PDF-1.4'), 'State carries raw PDF bytes');

// --- 14. Evaluation Runtime and graders judge the Run. ---
const def = (id, graderId, targetType, config) => ({
  schemaVersion: 2,
  id: `smoke.${id}`,
  version: '1.0.0',
  name: id,
  categories: ['capability'],
  supportedModes: ['RUNTIME'],
  targetType,
  graderRef: v1(graderId),
  config,
});

const definitions = [
  def('completed', 'aao.run-outcome', 'run', { expectedStatus: 'COMPLETED' }),
  def('tools', 'aao.tool-usage', 'tool_use', {
    requiredTools: [v1('document.extract_text')],
    callLimits: [{ count: 'physical', max: 1 }],
    forbiddenTools: [v1('records.sort'), v1('public_web.search')],
  }),
  def('models', 'aao.model-call', 'run', { expectedCalls: { min: 1, max: 1 }, expectedOutcome: 'completed' }),
  def('trace', 'aao.trace-contract', 'run', { expectedRunStatus: 'COMPLETED', compareWithExecution: true }),
  def('negative', 'aao.tool-usage', 'tool_use', { requiredTools: [v1('records.sort')] }),
];

const expected = ['passed', 'passed', 'passed', 'passed', 'failed'];
const judged = await runEvalDataset({
  dataset: {
    schemaVersion: 2,
    id: 'smoke.document-intelligence',
    version: '1.0.0',
    name: 'document intelligence',
    cases: definitions.map((definition, index) => ({
      id: `${definition.id}.001`,
      evalRef: { id: definition.id, version: '1.0.0' },
      mode: 'RUNTIME',
      evidenceRef: 'run://smoke.doc-intel',
      expected: {
        status: expected[index],
        ...(expected[index] === 'failed' ? { reasonCodes: ['TOOL_NOT_INVOKED'] } : {}),
      },
    })),
  },
  definitions,
  registry: createEvaluatorRegistry(deterministicGraders()),
  evidenceResolver: {
    resolve: (ref) =>
      ref === 'run://smoke.doc-intel'
        ? { origin: 'live_run', runId: 'run.smoke.doc-intel', trace, execution: outcome.execution.execution }
        : undefined,
  },
});
assert(
  judged.ok && JSON.stringify(judged.run.cases.map((entry) => entry.result.status)) === JSON.stringify(expected),
  `the Eval suite did not match: ${JSON.stringify(judged)}`
);

// --- 15. Unauthorized principal: canonical denial, zero provider calls. ---
const denied = createFixtureProof({ principal: unauthorizedUser });
const deniedOutcome = await denied.proof.run({
  runId: 'run.smoke.doc-intel.denied',
  request: {
    documentRef: ACME_DOCUMENT_REF,
    questions: SAMPLE_QUESTIONS,
  },
});
assert(
  deniedOutcome.status === 'failed' && deniedOutcome.failure.executorFailure?.code === 'TOOL_AUTHORIZATION_DENIED',
  `expected an Authorization denial: ${JSON.stringify(deniedOutcome)}`
);
assert(denied.provider.calls.length === 0, 'the provider was called for an unauthorized principal');

// --- 16. An unknown citation is rejected; no result is rendered. ---
const rejected = await createFixtureProof({
  modelOptions: { unknownEvidenceRef: true },
}).proof.run({
  runId: 'run.smoke.doc-intel.unknown-citation',
  request: {
    documentRef: ACME_DOCUMENT_REF,
    questions: SAMPLE_QUESTIONS,
  },
});
assert(
  rejected.status === 'failed' &&
    rejected.failure.executorFailure?.code === 'GROUNDING_UNKNOWN_EVIDENCE_REF' &&
    rejected.execution.execution.state.values.docResult === undefined,
  `the unknown citation was not rejected: ${JSON.stringify(rejected.failure)}`
);

// --- 17. Prompt-injection text is data in the user message only. ---
const synthesisReq = model.requests[0];
assert(
  synthesisReq.messages[0].role === 'system' &&
    synthesisReq.messages[0].content === SYNTHESIS_INSTRUCTIONS &&
    !synthesisReq.messages[0].content.includes('IGNORE ALL'),
  'the system message was tampered with'
);
const promptData = JSON.parse(synthesisReq.messages[1].content);
const injectionSpan = promptData.evidenceSpans.find((s) => /IGNORE ALL PREVIOUS\s+INSTRUCTIONS/.test(s.text));
assert(injectionSpan !== undefined, 'the injected text is not carried as evidence data');
assert(
  JSON.stringify(synthesisReq).split('IGNORE ALL').length === 2,
  'injected text appears outside evidence data'
);

// --- Compiled proof imports only public packages. ---
const compiledImports = new Set(
  readdirSync(join(exampleRoot, 'dist', 'src'))
    .filter((file) => file.endsWith('.js'))
    .flatMap((file) => [...readFileSync(join(exampleRoot, 'dist', 'src', file), 'utf8').matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]))
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'))
);
assert(
  JSON.stringify([...compiledImports].sort()) === '["@aao/framework","@aao/integration-documents"]',
  `the compiled proof imports more than public packages: ${[...compiledImports]}`
);

// --- Integration package: exports and pack (never publish). ---
const integrationRoot = join(repositoryRoot, 'packages', 'integration-documents');
const integration = await import('@aao/integration-documents');
const expectedExports = [
  'DOCUMENT_EXTRACT_TEXT_TOOL_REF',
  'DOCUMENT_FINGERPRINT_PATTERN',
  'DOCUMENT_ID_PATTERN',
  'DOCUMENT_LIMITS',
  'computeDocumentFingerprint',
  'computeDocumentId',
  'createDocumentTools',
  'normalizeCanonicalPageText',
  'safeSliceUtf16',
];
assert(
  JSON.stringify(Object.keys(integration).sort()) === JSON.stringify(expectedExports.sort()),
  `unexpected integration exports: ${Object.keys(integration)}`
);

const packDir = mkdtempSync(join(tmpdir(), 'aao-integration-pack-doc-'));
let entries;
try {
  execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: integrationRoot, stdio: 'pipe' });
  const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
  assert(tarball, 'pnpm pack produced no tarball');
  entries = execFileSync('tar', ['-tzf', join(packDir, tarball)], { encoding: 'utf8' }).trim().split('\n').sort();
  const unexpected = entries.filter((entry) => !/^package\/(package\.json|README\.md|dist\/.+\.(js|d\.ts))$/.test(entry));
  assert(unexpected.length === 0, `unexpected packed files: ${unexpected.join(', ')}`);
  for (const required of [
    'package/package.json',
    'package/README.md',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/tools.js',
    'package/dist/provider.d.ts',
    'package/dist/limits.js',
    'package/dist/parser.js',
  ]) {
    assert(entries.includes(required), `missing packed file ${required}`);
  }
  assert(
    !entries.some((entry) => /test|fixture|smoke|\.map$|\.env|\.log$|src\//.test(entry)),
    'pack leaked tests, fixtures, maps, env, logs, or sources'
  );
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

process.stdout.write(
  `${JSON.stringify({
    workflow: `${proof.workflow.id}@${proof.workflow.version}`,
    planFingerprint: proof.planFingerprint.slice(0, 12),
    nodes: nodes.length,
    tools,
    modelCalls: model.requests.length,
    providerCalls: provider.calls.length,
    coverage: result.coverage,
    citations: result.evidenceIndex.map((entry) => entry.citationId),
    eval: judged.run.cases.map((entry) => entry.result.status),
    denied: { code: deniedOutcome.failure.executorFailure.code, providerCalls: 0 },
    unknownCitation: rejected.failure.executorFailure.code,
    injection: 'data-only',
    integrationPack: { files: entries.length },
  })}\n`
);
process.stdout.write('SPRINT_23_DOCUMENT_INTELLIGENCE_PROOF_SMOKE_OK\n');
