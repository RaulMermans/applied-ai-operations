import { identifierSchema, type JsonObject, type ToolSpec } from "@aao/contracts";
import { createToolRegistry, type ToolRegistry } from "../src/registry.js";
import type { RegisteredTool, ToolHandler, ToolHandlerContext, ToolHandlerResult } from "../src/types.js";

/**
 * Small, deterministic, in-memory test Tools. They are fixtures, not a
 * production Tool catalog: no filesystem, network, credentials, or real data.
 */
export const LOOKUP_REF = { id: "local.lookup", version: "1.0.0" } as const;

export const LOOKUP_INPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: { query: { type: "string", minLength: 1 } },
  required: ["query"],
  additionalProperties: false,
};

export const LOOKUP_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: { items: { type: "array", items: { type: "string" } } },
  required: ["items"],
  additionalProperties: false,
};

export function buildToolSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    schemaVersion: 1,
    id: LOOKUP_REF.id,
    version: LOOKUP_REF.version,
    name: "Local lookup",
    inputSchema: LOOKUP_INPUT_SCHEMA,
    outputSchema: LOOKUP_OUTPUT_SCHEMA,
    permissionClasses: ["read_only"],
    ...overrides,
  };
}

/** A handler that records every context it receives and answers from `respond`. */
export function spyHandler(respond: (context: ToolHandlerContext) => ToolHandlerResult | Promise<ToolHandlerResult> = lookupResponse): ToolHandler & { calls: ToolHandlerContext[] } {
  const calls: ToolHandlerContext[] = [];
  return {
    calls,
    async execute(context) {
      calls.push(JSON.parse(JSON.stringify(context)) as ToolHandlerContext);
      return respond(context);
    },
  };
}

/** `local.lookup`: `{ query: "alpha" }` → `{ items: ["alpha-result"] }`. */
export function lookupResponse(context: ToolHandlerContext): ToolHandlerResult {
  const query = (context.input as { query: string }).query;
  return { ok: true, output: { items: [`${query}-result`] } };
}

export function buildRegistry(tools: RegisteredTool[]): ToolRegistry {
  const registry = createToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

export function lookupWorld(options: { spec?: Partial<ToolSpec>; respond?: Parameters<typeof spyHandler>[0] } = {}) {
  const handler = spyHandler(options.respond);
  const tools = buildRegistry([{ spec: buildToolSpec(options.spec), handler }]);
  return { tools, handler };
}

export function buildRequest(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, toolExecutionId: "exec.tool.1", toolRef: { ...LOOKUP_REF }, input: { query: "alpha" }, ...overrides };
}

export const SECRET = "secret-token=abc123 https://internal.example.com/v1?key=zzz";

/** A maximum-length (256-character) canonical identifier. */
export function maxLengthId(prefix: string): string {
  return identifierSchema.parse(`${prefix}.${"x".repeat(256 - prefix.length - 1)}`);
}
