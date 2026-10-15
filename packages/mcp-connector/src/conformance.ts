// MCP connector — official conformance subject (Sprint 20, ADR-025). An
// explicit package export ("@aao/mcp-connector/conformance"), never loaded
// by the package root. The AAO conformance host runs the canonical
// workflow. This module only supplies the substrate: a real MCP session
// over the official SDK's stdio transport to the shipped conformance
// server (a local child process, no network), bound with exactly the
// host's ToolSpec and retry safety.
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { AdapterConformanceScenario, AdapterManifest } from "@aao/adapters";
import type { RetrySafety, ToolSpec } from "@aao/contracts";
import type { RegisteredTool, ToolHandlerContext } from "@aao/tool-runtime";
import { createMcpToolBinding } from "./binding.js";
import { MCP_CONNECTOR_ADAPTER_MANIFEST } from "./manifest.js";
import { createMcpSession } from "./session.js";

// The same relative location from src/ and dist/: the package-level conformance asset.
const SERVER = fileURLToPath(new URL("../conformance/server.mjs", import.meta.url));

/** Host-owned configuration the conformance host hands the subject. The subject adds nothing. */
export interface ToolProviderHostBinding {
  spec: ToolSpec;
  retrySafety: RetrySafety;
}

export interface ToolProviderConformancePreparation {
  tool: RegisteredTool;
  /** Remote `tools/call` requests made for this scenario (a subject observation, not conformance evidence). */
  observations(): { remoteCalls: number };
  dispose(): Promise<void>;
}

export interface McpConformanceSubject {
  readonly manifest: AdapterManifest;
  readonly sensitiveMarkers: readonly string[];
  prepare(scenario: AdapterConformanceScenario, host: ToolProviderHostBinding): Promise<ToolProviderConformancePreparation>;
}

export function createMcpConformanceSubject(): McpConformanceSubject {
  return Object.freeze({
    manifest: MCP_CONNECTOR_ADAPTER_MANIFEST,
    // Seeded by the server into text content, errors, and discovery metadata: none may reach AAO evidence.
    sensitiveMarkers: Object.freeze(["secret-token=fixture", "private.invalid", "server-stack", "bypass authorization", "destructiveHint", "safeToRetry", "idempotentHint"]),
    async prepare(scenario: AdapterConformanceScenario, host: ToolProviderHostBinding): Promise<ToolProviderConformancePreparation> {
      const parameters = scenario.parameters as { outcomes?: unknown; hostileMetadata?: unknown };
      const session = createMcpSession({ command: process.execPath, args: [SERVER, JSON.stringify({ outcomes: parameters.outcomes, hostile: parameters.hostileMetadata === true })] });
      try {
        await session.connect();
        // Discovery happens inside the binding: the remote metadata is checked for presence only and supplies nothing else.
        const bound = await createMcpToolBinding({ session, remoteToolName: "crm.read_account", spec: host.spec, retrySafety: host.retrySafety });
        let remoteCalls = 0;
        const tool: RegisteredTool = {
          ...bound,
          handler: { execute: (context: ToolHandlerContext) => { remoteCalls += 1; return bound.handler.execute(context); } },
        };
        return { tool, observations: () => ({ remoteCalls }), dispose: () => session.close() };
      } catch (error) {
        await session.close();
        throw error;
      }
    },
  });
}
