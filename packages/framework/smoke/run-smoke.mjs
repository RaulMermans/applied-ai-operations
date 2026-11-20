// Sprint 19 compiled smoke: the public framework surface as a consumer sees it.
// Run after `pnpm build`. Uses only compiled output:
//
//  1. The dist root exports exactly the approved public symbols.
//  2. The consumer fixture (imports only "@aao/framework") is compiled with
//     tsc against dist declarations, then run on dist JavaScript:
//     Approval → approve → continue → Tool → COMPLETED; rejection, denied
//     Authorization, and an unsupported permission class never call a Tool.
//  3. The compiled `aao` CLI: --help, workflow validate/compile, eval ci,
//     eval adapters, eval baseline propose.
//  4. `pnpm pack` (never publish): the tarball holds only intentional files.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = join(packageRoot, '..', '..');
const cliMain = join(packageRoot, 'dist', 'cli', 'main.js');
const fixtures = join(packageRoot, 'test', 'fixtures', 'workflows');

// --- 1. Compiled public root. ---
const framework = await import('../dist/index.js');
// The approved root (Sprint 19, extended deliberately by Sprint 20 / ADR-025 with the stable adapter-contract values).
const expected = ['AAOFrameworkError', 'AAO_ADAPTER_CONTRACT_VERSION', 'AAO_FRAMEWORK_API_VERSION', 'AdapterContractError', 'checkAdapterCompatibility', 'createAAO', 'defineAdapterManifest', 'defineAgent', 'defineEval', 'defineGovernance', 'defineModelAdapter', 'defineModelPolicy', 'defineTool', 'defineWorkflow'];
assert(JSON.stringify(Object.keys(framework).sort()) === JSON.stringify(expected), `unexpected public exports: ${Object.keys(framework)}`);
assert(framework.AAO_FRAMEWORK_API_VERSION === 1, 'framework API version is not 1');

// --- 2. Consumer compiled against dist declarations, run on dist. ---
const consumerOut = join(packageRoot, 'test', 'consumer', '.out');
rmSync(consumerOut, { recursive: true, force: true });
execFileSync(process.execPath, [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(packageRoot, 'test', 'consumer', 'tsconfig.json')], { stdio: 'inherit' });
assert(JSON.stringify(readdirSync(consumerOut)) === JSON.stringify(['app.js']), 'the consumer build emitted more than the consumer');
const consumer = await import('../test/consumer/.out/app.js');
const outcome = await consumer.runConsumerScenarios();
rmSync(consumerOut, { recursive: true, force: true });
const { approved, rejected, denied, unsupported } = outcome;
assert(approved.waiting.status === 'WAITING_FOR_APPROVAL' && approved.waiting.nodes.draft === 'PENDING' && approved.draftCallsWhileWaiting === 0, 'Approval did not wait before the Tool');
assert(approved.pendingContinue.failure === 'APPROVAL_STILL_PENDING', 'pending continuation was not refused');
assert(approved.selfApproval === 'APPROVAL_RESOLVER_NOT_ELIGIBLE' && approved.requestedBy.id === 'user.alice' && approved.resolvedBy.id === 'user.bob', 'requester/approver identity is wrong');
assert(approved.completed.status === 'COMPLETED' && approved.draftCalls === 1, 'approved Run did not complete with exactly one Tool call');
assert(rejected.result.failure === 'APPROVAL_REJECTED' && rejected.draftCalls === 0, 'rejection did not block the Tool');
assert(denied.result.executorFailure === 'TOOL_AUTHORIZATION_DENIED' && denied.draftCalls === 0, 'Authorization denial did not block the Tool');
assert(unsupported.result.failure === 'RUNTIME_PREFLIGHT_FAILED' && JSON.stringify(unsupported.result.details).includes('TOOL_PERMISSION_UNSUPPORTED') && unsupported.emailCalls === 0, 'unsupported permission class was not blocked');

// --- 3. Compiled CLI. ---
const aao = (args, cwd = repositoryRoot) => spawnSync(process.execPath, [cliMain, ...args], { cwd, encoding: 'utf8' });
const help = aao(['--help']);
assert(help.status === 0 && help.stdout.includes('aao workflow validate <file>') && !/aao (run|init)\b/.test(help.stdout), 'aao --help is wrong');
const valid = aao(['workflow', 'validate', 'valid.yaml'], fixtures);
assert(valid.status === 0 && valid.stdout === 'VALID cli.approved-update@1.0.0\n', `workflow validate failed: ${valid.stdout}${valid.stderr}`);
const invalid = aao(['workflow', 'validate', 'invalid-graph.yaml'], fixtures);
assert(invalid.status === 1 && invalid.stdout.includes('UNREACHABLE_NODE') && invalid.stdout.includes('DUPLICATE_NODE_ID') && !invalid.stderr.includes(' at '), 'invalid workflow was not reported canonically');
const compiled = aao(['workflow', 'compile', 'valid.json'], fixtures);
assert(compiled.status === 0 && JSON.parse(compiled.stdout).workflow.id === 'cli.direct-draft', 'workflow compile failed');
const gate = aao(['eval', 'ci']);
assert(gate.status === 0 && gate.stdout.trimEnd().endsWith('PASS'), `eval ci failed: ${gate.stdout}${gate.stderr}`);
const gateJson = aao(['eval', 'ci', '--format', 'json']);
assert(gateJson.status === 0 && JSON.parse(gateJson.stdout).gate.outcome === 'PASS', 'eval ci --format json failed');
const adapters = aao(['eval', 'adapters']);
assert(adapters.status === 0 && adapters.stdout.trimEnd().endsWith('PASS'), `eval adapters failed: ${adapters.stdout}${adapters.stderr}`);
const proposal = aao(['eval', 'baseline', 'propose', '--id', 'runtime-foundation', '--version', '1.0.0']);
assert(proposal.status === 0 && JSON.parse(proposal.stdout).kind === 'aao.eval-baseline-proposal', 'baseline proposal failed');
const unknown = aao(['run', 'workflow.yaml']);
assert(unknown.status === 1 && unknown.stderr.startsWith('ERROR AAO_CLI_UNKNOWN_COMMAND'), 'aao run must not exist');

// --- 4. Pack (never publish) and inspect. ---
const packDir = mkdtempSync(join(tmpdir(), 'aao-pack-'));
try {
  execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: packageRoot, stdio: 'pipe' });
  const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
  assert(tarball, 'pnpm pack produced no tarball');
  const entries = execFileSync('tar', ['-tzf', join(packDir, tarball)], { encoding: 'utf8' }).trim().split('\n').sort();
  const unexpected = entries.filter((entry) => !/^package\/(package\.json|README\.md|LICENSE|dist\/.+\.(js|d\.ts))$/.test(entry));
  assert(unexpected.length === 0, `unexpected packed files: ${unexpected.join(', ')}`);
  for (const required of ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/dist/index.js', 'package/dist/index.d.ts', 'package/dist/cli/main.js']) assert(entries.includes(required), `missing packed file ${required}`);
  assert(!entries.some((entry) => /test|fixture|\.map$|\.env|\.log$|src\//.test(entry)), 'pack leaked tests, fixtures, maps, env, logs, or sources');
  process.stdout.write(`${JSON.stringify({ publicExports: expected.length, consumer: { approved: approved.completed.status, toolCalls: approved.draftCalls, rejected: rejected.result.failure, denied: denied.result.executorFailure, unsupported: 'TOOL_PERMISSION_UNSUPPORTED' }, cli: { help: 0, validate: 0, invalid: 1, compile: 0, evalCi: 0, evalAdapters: 0, baselinePropose: 0, run: 1 }, pack: { files: entries.length } })}\n`);
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
process.stdout.write('SPRINT_19_FRAMEWORK_SURFACE_SMOKE_OK\n');
