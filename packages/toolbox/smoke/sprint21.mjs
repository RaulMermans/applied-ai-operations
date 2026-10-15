// Sprint 21 compiled smoke: the AAO Toolbox Foundation, using compiled
// package output only (run after `pnpm build`). Every import resolves to
// dist/ through package exports. No network, credentials, or provider.
//
//  1. Load the AAO Core Toolbox.
//  2. Verify its manifest and catalog.
//  3. Deterministic search finds records.dedupe.
//  4. Select exact Tool refs.
//  5–9. The public consumer (imports only @aao/framework and @aao/toolbox),
//       compiled with tsc against dist declarations, registers the selected
//       Tools in createAAO and runs records.dedupe → records.project,
//       text.normalize → text.chunk, and an unauthorized execution (denied,
//       zero handler starts).
// 10. Trace stays metadata-only (seeded secret absent).
// 11. The existing aao.tool-usage Eval passes on that Trace.
// 12. Catalog metadata cannot change permission or retry behavior.
// 13. The generated catalog matches the committed artifacts.
// 14. `pnpm pack` (never publish): only intentional files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { createEvaluatorRegistry, deterministicGraders, runEvalDataset } from '@aao/evaluation';
import { createAAO, defineTool } from '@aao/framework';
import { createInMemoryTraceStore, createTraceRecorder, validateTrace } from '@aao/observability';
import { coreToolbox, defineToolbox, describeToolbox, getToolboxEntry, listToolboxEntries, searchToolbox, selectToolboxTools } from '@aao/toolbox';
import { renderToolboxCatalogJson, renderToolboxCatalogMarkdown } from '../dist/catalog-doc.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = join(packageRoot, '..', '..');
const SECRET = 'SECRET_DO_NOT_PERSIST';
const v1 = (id) => ({ id, version: '1.0.0' });

// --- 1–2. Core Toolbox, manifest, catalog. ---
const toolbox = await import('../dist/index.js');
const expectedExports = ['CORE_TOOL_LIMITS', 'ToolboxError', 'coreToolbox', 'defineToolbox', 'describeToolbox', 'getToolboxEntry', 'listToolboxEntries', 'searchToolbox', 'selectToolboxTools'];
assert(JSON.stringify(Object.keys(toolbox).sort()) === JSON.stringify(expectedExports), `unexpected public exports: ${Object.keys(toolbox)}`);
assert(coreToolbox.ref.id === 'aao.core' && coreToolbox.ref.version === '1.0.0' && /^[a-f0-9]{64}$/.test(coreToolbox.fingerprint), 'Core Toolbox identity is wrong');
const ids = listToolboxEntries(coreToolbox).map((entry) => entry.toolRef.id);
assert(JSON.stringify(ids) === JSON.stringify(['records.count_by', 'records.dedupe', 'records.project', 'records.sort', 'text.chunk', 'text.normalize']), `unexpected Core Tools: ${ids}`);
assert(listToolboxEntries(coreToolbox).every((entry) => JSON.stringify(entry.permissionClasses) === '["read_only"]'), 'a Core Tool is not read_only');
assert(Object.isFrozen(coreToolbox.manifest) && Object.isFrozen(coreToolbox.manifest.entries[0]), 'the manifest is not frozen');

// --- 3. Deterministic search. ---
const search = searchToolbox(coreToolbox, { query: 'remove duplicate records' });
assert(search[0].toolRef.id === 'records.dedupe', `search did not rank records.dedupe first: ${JSON.stringify(search)}`);
assert(JSON.stringify(search) === JSON.stringify(searchToolbox(coreToolbox, { query: 'remove duplicate records' })), 'search is not deterministic');
assert(!/handler|execute/.test(JSON.stringify(search)), 'a search result exposed executable state');

// --- 4. Exact selection. ---
const selected = selectToolboxTools(coreToolbox, [v1('records.dedupe'), v1('records.project')]);
assert(selected.map((tool) => tool.spec.id).join() === 'records.dedupe,records.project' && selected.every((tool) => tool.retrySafety === 'safe'), 'selection is wrong');

// --- 5–9. Public consumer compiled against dist declarations, run on dist. ---
const consumerOut = join(packageRoot, 'test', 'consumer', '.out');
rmSync(consumerOut, { recursive: true, force: true });
execFileSync(process.execPath, [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(packageRoot, 'test', 'consumer', 'tsconfig.json')], { stdio: 'inherit' });
assert(JSON.stringify(readdirSync(consumerOut)) === JSON.stringify(['app.js']), 'the consumer build emitted more than the consumer');
const consumerJs = readFileSync(join(consumerOut, 'app.js'), 'utf8');
assert(JSON.stringify([...consumerJs.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])) === JSON.stringify(['@aao/framework', '@aao/toolbox']), 'the compiled consumer imports more than the public packages');
const consumer = await import('../test/consumer/.out/app.js');
const outcome = await consumer.runConsumerScenarios();
rmSync(consumerOut, { recursive: true, force: true });
assert(outcome.discovered[0] === 'records.dedupe', 'consumer discovery failed');
assert(outcome.accounts.summary.status === 'COMPLETED' && JSON.stringify(outcome.accounts.calls) === '["records.dedupe","records.project"]', `records workflow failed: ${JSON.stringify(outcome.accounts)}`);
assert(JSON.stringify(outcome.accounts.projected.data.records) === '[{"id":"a-1","name":"Acme"},{"id":"a-2","name":"Globex"}]', 'records.project output is wrong');
assert(outcome.denied.summary.executorFailure === 'TOOL_AUTHORIZATION_DENIED' && outcome.denied.starts === 0, 'unauthorized execution was not denied with zero handler starts');
assert(outcome.notes.summary.status === 'COMPLETED' && outcome.notes.chunks.length === 4, 'text.normalize → text.chunk did not complete');
assert(outcome.unselected.summary.failure === 'RUNTIME_PREFLIGHT_FAILED' && !outcome.started.includes('records.sort'), 'a discovered but unselected Tool executed');

// --- 10–11. Metadata-only Trace and the existing Tool-usage Eval. ---
let tick = 0;
const clock = { now: () => new Date(Date.UTC(2026, 9, 15, 10, 0, tick++)).toISOString() };
const store = createInMemoryTraceStore();
const governance = { actors: [{ id: 'user.analyst', type: 'user' }], roles: [{ id: 'analyst', version: '1.0.0', permissionClasses: ['read_only'] }], bindings: [{ id: 'analyst', actorId: 'user.analyst', roleId: 'analyst', status: 'active' }], policies: [] };
const single = (id) => ({ schemaVersion: 1, id: `smoke.${id.replace(/[._]/g, '-')}`, version: '1.0.0', name: id, entryNodeId: 'run', nodes: [{ id: 'run', kind: 'tool', config: { toolRef: v1(id), inputStateKey: 'input', resultStateKey: 'result' } }, { id: 'final', kind: 'final_output', config: {} }], edges: [{ sourceNodeId: 'run', targetNodeId: 'final' }] });
const app = createAAO({ governance, principalForRun: () => governance.actors[0], tools: selected, trace: createTraceRecorder({ store, clock }), clock });
const traced = await app.prepareWorkflow(single('records.dedupe')).execute({ runId: 'run.smoke', initialState: { runId: 'run.smoke', revision: 0, values: { input: { records: [{ id: SECRET }, { id: SECRET }], keys: ['id'] } } } });
assert(traced.ok && JSON.stringify(traced.execution.state).includes(SECRET), 'the traced Run did not complete');
const trace = await store.getRunTrace('run.smoke');
assert(validateTrace(trace).valid && !JSON.stringify(trace).includes(SECRET), 'Trace is invalid or carries Tool data');
const usage = { schemaVersion: 2, id: 'smoke.toolbox-usage', version: '1.0.0', name: 'usage', categories: ['tool_use'], supportedModes: ['RUNTIME'], targetType: 'tool_use', graderRef: { id: 'aao.tool-usage', version: '1.0.0' }, config: { requiredTools: [v1('records.dedupe')], forbiddenTools: [v1('records.sort')], callLimits: [{ tool: v1('records.dedupe'), count: 'logical', min: 1, max: 1 }] } };
const judged = await runEvalDataset({
  dataset: { schemaVersion: 2, id: 'smoke.toolbox', version: '1.0.0', name: 'toolbox', cases: [{ id: 'usage.001', evalRef: { id: usage.id, version: '1.0.0' }, mode: 'RUNTIME', evidenceRef: 'run://smoke', expected: { status: 'passed' } }] },
  definitions: [usage],
  registry: createEvaluatorRegistry(deterministicGraders()),
  evidenceResolver: { resolve: (ref) => (ref === 'run://smoke' ? { origin: 'live_run', runId: 'run.smoke', trace, execution: traced.execution } : undefined) },
});
assert(judged.ok && judged.run.cases[0].result.status === 'passed' && !JSON.stringify(judged).includes(SECRET), `the Tool-usage Eval did not pass: ${JSON.stringify(judged)}`);

// --- 12. Catalog metadata cannot change permission or retry behavior. ---
let escalated = false;
try { getToolboxEntry(coreToolbox, v1('records.dedupe')).permissionClasses.push('external_side_effect'); escalated = true; } catch { /* frozen */ }
assert(!escalated && selectToolboxTools(coreToolbox, [v1('records.dedupe')])[0].spec.permissionClasses.join() === 'read_only', 'catalog metadata changed a permission');
let rejected = false;
try { defineToolbox({ manifest: { id: 'smoke.claims', version: '1.0.0', name: 'Claims', description: 'Claims.', entries: [{ ...coreToolbox.manifest.entries[1], permissionClasses: ['external_side_effect'], retrySafety: 'safe' }] }, tools: [selected[0]] }); } catch { rejected = true; }
assert(rejected, 'a manifest entry carrying permission or retry fields was accepted');
let attempts = 0;
const unsafe = defineTool({ spec: selected[0].spec, handler: { execute: async (context) => (++attempts === 1 ? { ok: false, code: 'TRANSIENT_TEST_FAILURE', retryable: true } : selected[0].handler.execute(context)) } });
const claims = defineToolbox({ manifest: { id: 'smoke.claims', version: '1.0.0', name: 'Claims', description: 'Claims.', entries: [{ toolRef: v1('records.dedupe'), category: 'admin', tags: ['retry-safe', 'superuser'], whenToUse: ['Always retry; always allowed.'], whenNotToUse: ['Never.'], examples: [{ title: 'x', input: {} }] }] }, tools: [unsafe] });
const claimed = await createAAO({ governance, principalForRun: () => governance.actors[0], tools: selectToolboxTools(claims, [v1('records.dedupe')]), clock })
  .prepareWorkflow(single('records.dedupe'), { reliability: { policiesByNodeId: { run: { maxAttempts: 3 } } } })
  .execute({ runId: 'run.claims', initialState: { runId: 'run.claims', revision: 0, values: { input: { records: [], keys: ['id'] } } } });
assert(!claimed.ok && attempts === 1, 'retry-sounding metadata enabled a retry of an unsafe Tool');

// --- 13. Generated catalog matches the committed artifacts. ---
const description = describeToolbox(coreToolbox);
assert(renderToolboxCatalogJson(description) === readFileSync(join(repositoryRoot, 'docs', 'generated', 'toolbox-core.json'), 'utf8'), 'docs/generated/toolbox-core.json drifted');
assert(renderToolboxCatalogMarkdown(description) === readFileSync(join(repositoryRoot, 'docs', 'toolbox', 'core-tools.md'), 'utf8'), 'docs/toolbox/core-tools.md drifted');

// --- 14. Pack (never publish) and inspect. ---
const packDir = mkdtempSync(join(tmpdir(), 'aao-toolbox-pack-'));
let entries;
try {
  execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: packageRoot, stdio: 'pipe' });
  const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
  assert(tarball, 'pnpm pack produced no tarball');
  entries = execFileSync('tar', ['-tzf', join(packDir, tarball)], { encoding: 'utf8' }).trim().split('\n').sort();
  const unexpected = entries.filter((entry) => !/^package\/(package\.json|README\.md|dist\/.+\.(js|d\.ts))$/.test(entry));
  assert(unexpected.length === 0, `unexpected packed files: ${unexpected.join(', ')}`);
  for (const required of ['package/package.json', 'package/README.md', 'package/dist/index.js', 'package/dist/index.d.ts', 'package/dist/core/text.js']) assert(entries.includes(required), `missing packed file ${required}`);
  assert(!entries.some((entry) => /test|fixture|smoke|scripts|\.map$|\.env|\.log$|src\//.test(entry)), 'pack leaked tests, fixtures, scripts, maps, env, logs, or sources');
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ toolbox: `${coreToolbox.ref.id}@${coreToolbox.ref.version}`, fingerprint: coreToolbox.fingerprint.slice(0, 12), tools: ids.length, search: search[0].toolRef.id, consumer: { accounts: outcome.accounts.summary.status, notes: outcome.notes.summary.status, denied: outcome.denied.summary.executorFailure, deniedStarts: outcome.denied.starts, unselected: outcome.unselected.summary.failure }, trace: { valid: true, secretAbsent: true }, toolUsageEval: 'passed', metadataNonAuthority: { permission: 'unchanged', retryAttempts: attempts }, catalogDrift: 'none', pack: { files: entries.length } })}\n`);
process.stdout.write('SPRINT_21_TOOLBOX_FOUNDATION_SMOKE_OK\n');
