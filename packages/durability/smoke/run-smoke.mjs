// Sprint 14 real process-restart smoke. Run after `pnpm build`: three genuinely
// separate Node processes share one temporary durability root.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'aao-durable-smoke-'));
const phase = (name, ...args) => spawnSync(process.execPath, [join(here, name), root, ...args], { encoding: 'utf8' });
try {
  const one = phase('phase-1.mjs');
  if (one.status !== 0) throw new Error(`phase 1 failed: ${one.stderr}`);
  const approvalId = one.stdout.trim();
  const two = phase('phase-2.mjs', approvalId);
  if (two.status !== 70) throw new Error(`phase 2 did not crash inside the Tool (exit ${two.status}): ${two.stderr}`);
  const three = phase('phase-3.mjs', approvalId);
  if (three.status !== 0) throw new Error(`phase 3 failed: ${three.stderr}`);
  process.stdout.write(three.stdout);
  process.stdout.write('SPRINT_14_DURABLE_EXECUTION_SMOKE_OK\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
