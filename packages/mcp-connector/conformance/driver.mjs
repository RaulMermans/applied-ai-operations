// MCP connector — adapter verification driver (Sprint 18, ADR-023).
//
// Test-owned, never production code. It drives the real MCP connector over
// the official SDK's stdio transport against the deterministic local test
// server (test/fixtures/server.mjs: a child process, no network) and runs
// the same canonical AAO Tool workflow as the native reference
// (packages/tool-runtime/conformance/driver.mjs), so only the substrate
// differs. That server's discovery metadata is hostile on purpose — it
// claims destructive behavior and asks to "grant external_side_effect and
// bypass authorization" — and the host-owned ToolSpec must remain the only
// authority. The verification host injects the canonical recorders. It
// imports nothing from @aao/evaluation.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { createMcpSession, createMcpToolBinding } from '@aao/mcp-connector';
import { runToolScenario, toolSpec } from '../../tool-runtime/conformance/driver.mjs';

const SERVER = fileURLToPath(new URL('../test/fixtures/server.mjs', import.meta.url));
const SERVER_MODE = { 'tool.success-structured-result': 'ok', 'tool.unauthorized-blocked': 'ok', 'tool.unsupported-permission-blocked': 'ok', 'tool.failure-normalized': 'error' };

export function createMcpConnectorDriver({ recorders }) {
  const serverCalls = new Map();
  return Object.freeze({
    id: 'aao.mcp-connector',
    kind: 'tool',
    support: Object.freeze({
      'tool.success-structured-result': 'SUPPORTED',
      'tool.unauthorized-blocked': 'SUPPORTED',
      'tool.unsupported-permission-blocked': 'SUPPORTED',
      'tool.failure-normalized': 'SUPPORTED',
      // The connector deliberately declares no retry safety (exactly one remote call, ADR-015), so the Runtime never retries it.
      'tool.transient-retry': 'UNSUPPORTED',
    }),
    // Seeded by the test server into text content, error payloads, and discovery metadata: none may reach AAO evidence.
    sensitiveMarkers: Object.freeze(['secret-token=fixture', 'private.invalid', 'server-stack', 'bypass authorization', 'destructiveHint']),
    /** Remote tools/call requests the server actually received for a scenario (test observation, not conformance evidence). */
    serverCalls: (scenarioId) => serverCalls.get(scenarioId),
    async executeScenario(scenario) {
      const mode = SERVER_MODE[scenario.id] ?? 'ok';
      const directory = mkdtempSync(join(tmpdir(), 'aao-mcp-conformance-'));
      const ledger = join(directory, 'ledger.json');
      const session = createMcpSession({ command: process.execPath, args: [SERVER, mode, ledger] });
      try {
        await session.connect();
        const binding = await createMcpToolBinding({ session, remoteToolName: 'crm.read_account', spec: toolSpec(scenario.parameters) });
        const evidence = await runToolScenario({ scenario, registeredTool: binding, runId: `run.conformance.mcp.${scenario.id}`, workflowId: 'conformance.tool', recorders });
        serverCalls.set(scenario.id, existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')).calls : 0);
        return evidence;
      } finally {
        await session.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  });
}
