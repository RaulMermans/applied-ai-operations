// Sprint 19 no-prior-build smoke: the repository Eval aliases never run
// stale or missing compiled output. Deletes the dist/ of @aao/framework and
// every workspace package it depends on (generated, git-ignored output
// only), then runs `pnpm eval:ci` and `pnpm eval:adapters` exactly as a
// contributor would on a fresh checkout. Each alias builds the framework's
// dependency closure itself before invoking the canonical `aao` CLI.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'packages', 'framework', 'package.json'), 'utf8'));
const closure = ['framework', ...Object.keys(manifest.dependencies).map((name) => name.replace('@aao/', ''))];
// Transitive workspace dependencies of the closure (e.g. durability is not needed; contracts is).
for (let index = 0; index < closure.length; index += 1) {
  const dependencies = JSON.parse(readFileSync(join(repositoryRoot, 'packages', closure[index], 'package.json'), 'utf8')).dependencies ?? {};
  for (const name of Object.keys(dependencies)) if (name.startsWith('@aao/') && !closure.includes(name.replace('@aao/', ''))) closure.push(name.replace('@aao/', ''));
}

for (const name of closure) rmSync(join(repositoryRoot, 'packages', name, 'dist'), { recursive: true, force: true });
assert(closure.every((name) => !existsSync(join(repositoryRoot, 'packages', name, 'dist'))), 'dist was not removed');

const run = (script) => spawnSync('pnpm', ['--silent', script], { cwd: repositoryRoot, encoding: 'utf8' });
const gate = run('eval:ci');
assert(gate.status === 0 && gate.stdout.trimEnd().endsWith('PASS'), `pnpm eval:ci without a prior build failed (exit ${gate.status}): ${gate.stdout}${gate.stderr}`);
const adapters = run('eval:adapters');
assert(adapters.status === 0 && adapters.stdout.trimEnd().endsWith('PASS'), `pnpm eval:adapters without a prior build failed (exit ${adapters.status}): ${adapters.stdout}${adapters.stderr}`);
assert(closure.every((name) => existsSync(join(repositoryRoot, 'packages', name, 'dist', 'index.js'))), 'the aliases did not rebuild the framework closure');

process.stdout.write(`${JSON.stringify({ removedDist: closure.sort(), evalCi: 'PASS', evalAdapters: 'PASS' })}\n`);
process.stdout.write('SPRINT_19_NO_BUILD_EVAL_ALIASES_OK\n');
