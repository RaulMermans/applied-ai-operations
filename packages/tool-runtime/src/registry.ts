import { ToolSpecSchema, type ToolSpec } from "@aao/contracts";
import { isJsonSafe } from "@aao/runtime";
import { compileToolSchema, type CompiledToolSchema } from "./schema-validator.js";
import type { RegisteredTool, ToolHandler, ToolRef } from "./types.js";

/**
 * A registered Tool as the Tool Runtime resolves it: a defensive clone of
 * the canonical spec, plus the execution behavior captured once at
 * registration — the handler's `execute` function and the compiled
 * input/output schemas. The resolved object and the captured behavior are
 * frozen: a lookup can be inspected but never used to replace what future
 * `executeTool` calls run or enforce.
 */
export interface ResolvedTool {
  readonly spec: ToolSpec;
  readonly handler: Readonly<ToolHandler>;
  readonly inputSchema: CompiledToolSchema;
  readonly outputSchema: CompiledToolSchema;
}

/**
 * Explicit, constructible, isolated Tool Registry. No global singleton, no
 * filesystem scanning, no dynamic imports, no workflow-controlled code
 * loading: every instance starts empty and is populated only by trusted
 * calling code. Tools are keyed by canonical `ToolSpec` identity (`id` +
 * `version`), so versions coexist and lookup is exact.
 *
 * Registered ≠ authorized. Registration proves trusted code implements the
 * Tool and its schemas are enforceable; it does not mean Tool Runtime V1 may
 * execute it (see `permissions.ts`), nor that any actor may invoke it.
 */
export interface ToolRegistry {
  /**
   * Validates the canonical `ToolSpec`, compiles `inputSchema` and
   * `outputSchema` under the strict V1 JSON Schema policy, and stores a
   * defensive clone. Throws on a malformed spec, a missing handler, an
   * unenforceable schema, or a duplicate `id@version` — all programming
   * errors in trusted host code, discovered at registration rather than at
   * first invocation.
   */
  register(tool: RegisteredTool): void;
  /**
   * Version-exact lookup. The returned spec is a fresh clone and the rest is
   * frozen registry-owned behavior: callers cannot mutate registry state, the
   * captured handler, or schema enforcement through it.
   */
  get(ref: ToolRef): ResolvedTool | undefined;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ResolvedTool>();
  return {
    register(tool: RegisteredTool): void {
      const parsed = isJsonSafe(tool?.spec) ? ToolSpecSchema.safeParse(tool.spec) : undefined;
      if (parsed === undefined || !parsed.success) throw new Error("ToolRegistry: spec is not a JSON-safe canonical ToolSpec.");
      // Everything below works on a private clone, so the caller's object can never alias registry state or a compiled schema.
      const spec = cloneSpec(parsed.data);
      if (typeof tool.handler?.execute !== "function") {
        throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" has no handler.execute function.`);
      }
      const key = toolKey(spec);
      if (tools.has(key)) throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" is already registered.`);

      const inputSchema = compileToolSchema(cloneSpec(spec).inputSchema);
      if (!inputSchema.ok) throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" has an unsupported inputSchema: ${inputSchema.issues.join("; ")}`);
      const outputSchema = compileToolSchema(cloneSpec(spec).outputSchema);
      if (!outputSchema.ok) throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" has an unsupported outputSchema: ${outputSchema.issues.join("; ")}`);

      tools.set(key, Object.freeze({ spec, handler: captureHandler(tool.handler), inputSchema: inputSchema.schema, outputSchema: outputSchema.schema }));
    },
    get(ref: ToolRef): ResolvedTool | undefined {
      const tool = tools.get(toolKey(ref));
      return tool === undefined ? undefined : Object.freeze({ ...tool, spec: cloneSpec(tool.spec) });
    },
  };
}

/**
 * Captures the handler's `execute` function (bound to its original object, so
 * legitimate `this` use keeps working) into a frozen registry-owned handler.
 * Reassigning `execute` on the caller's handler object after registration
 * therefore cannot change what the registry runs. The caller's object is
 * never modified.
 */
function captureHandler(handler: ToolHandler): Readonly<ToolHandler> {
  const execute = handler.execute.bind(handler);
  return Object.freeze({ execute });
}

function toolKey(ref: { id: string; version: string }): string {
  // JSON-encoded so no id/version pair can collide with another via a separator.
  return JSON.stringify([ref.id, ref.version]);
}

function cloneSpec(spec: ToolSpec): ToolSpec {
  return JSON.parse(JSON.stringify(spec)) as ToolSpec;
}
