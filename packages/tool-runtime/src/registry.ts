import { RetrySafetySchema, ToolSpecSchema, type RetrySafety, type ToolSpec } from "@aao/contracts";
import { isJsonSafe } from "@aao/runtime";
import { compileToolSchema, type CompiledToolSchema } from "./schema-validator.js";
import type { RegisteredTool, ToolHandler, ToolRef } from "./types.js";

/**
 * Explicit, constructible, isolated Tool Registry. No global singleton, no
 * filesystem scanning, no dynamic imports, no workflow-controlled code
 * loading: every instance starts empty and is populated only by trusted
 * calling code. Tools are keyed by canonical `ToolSpec` identity (`id` +
 * `version`), so versions coexist and lookup is exact.
 *
 * The public surface is inspection only: register a Tool, read a clone of
 * its canonical spec, check presence. It never hands out the executable
 * handler or the compiled validators, so metadata lookup cannot become a
 * path around `executeTool` and its support gate, authorization, and schema
 * enforcement.
 *
 * Registered ≠ supported ≠ authorized. Registration proves trusted code
 * implements the Tool and its schemas are enforceable; whether this runtime
 * version may execute it is the support gate (`permissions.ts`), and whether
 * a given principal may invoke it is `@aao/authorization`.
 */
export interface ToolRegistry {
  /**
   * Validates the canonical `ToolSpec`, compiles `inputSchema` and
   * `outputSchema` under the strict V1 JSON Schema policy, captures the
   * handler's `execute` function, and stores a defensive clone. Throws on a
   * malformed spec, a missing handler, an unenforceable schema, or a
   * duplicate `id@version` — all programming errors in trusted host code,
   * discovered at registration rather than at first invocation.
   */
  readonly register: (tool: RegisteredTool) => void;
  /** Version-exact lookup of the canonical spec: a fresh clone, so callers cannot mutate registry state through it. */
  readonly getSpec: (ref: ToolRef) => ToolSpec | undefined;
  /** Version-exact presence check. */
  readonly has: (ref: ToolRef) => boolean;
}

/**
 * The registry-private execution binding for one Tool: the stored spec plus
 * the behavior captured once at registration. Frozen; reachable only
 * through `resolveToolBinding`, which `index.ts` does not export.
 */
export interface ToolBinding {
  readonly spec: ToolSpec;
  readonly handler: Readonly<ToolHandler>;
  readonly inputSchema: CompiledToolSchema;
  readonly outputSchema: CompiledToolSchema;
  readonly retrySafety: RetrySafety;
}

/**
 * Module-private: each registry's bindings, keyed by the registry object
 * itself. Not global Tool state — an entry exists only for a registry some
 * caller created, and disappears with it.
 */
const bindingsByRegistry = new WeakMap<ToolRegistry, Map<string, ToolBinding>>();

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolBinding>();
  const registry: ToolRegistry = Object.freeze({
    register(tool: RegisteredTool): void {
      const parsed = isJsonSafe(tool?.spec) ? ToolSpecSchema.safeParse(tool.spec) : undefined;
      if (parsed === undefined || !parsed.success) throw new Error("ToolRegistry: spec is not a JSON-safe canonical ToolSpec.");
      // Everything below works on a private clone, so the caller's object can never alias registry state or a compiled schema.
      const spec = cloneSpec(parsed.data);
      if (typeof tool.handler?.execute !== "function") {
        throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" has no handler.execute function.`);
      }
      const retrySafety = RetrySafetySchema.safeParse(tool.retrySafety ?? "unsafe");
      if (!retrySafety.success) throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" has an invalid retrySafety.`);
      if (retrySafety.data === "safe" && !spec.permissionClasses.every((permissionClass) => permissionClass === "read_only")) {
        throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" may declare retrySafety "safe" only when every permission class is read_only.`);
      }
      const key = toolKey(spec);
      if (tools.has(key)) throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" is already registered.`);

      const inputSchema = compileToolSchema(cloneSpec(spec).inputSchema);
      if (!inputSchema.ok) throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" has an unsupported inputSchema: ${inputSchema.issues.join("; ")}`);
      const outputSchema = compileToolSchema(cloneSpec(spec).outputSchema);
      if (!outputSchema.ok) throw new Error(`ToolRegistry: tool "${spec.id}" version "${spec.version}" has an unsupported outputSchema: ${outputSchema.issues.join("; ")}`);

      tools.set(key, Object.freeze({ spec: deepFreeze(spec), handler: captureHandler(tool.handler), inputSchema: inputSchema.schema, outputSchema: outputSchema.schema, retrySafety: retrySafety.data }));
    },
    getSpec(ref: ToolRef): ToolSpec | undefined {
      const tool = tools.get(toolKey(ref));
      return tool === undefined ? undefined : cloneSpec(tool.spec);
    },
    has(ref: ToolRef): boolean {
      return tools.has(toolKey(ref));
    },
  });
  bindingsByRegistry.set(registry, tools);
  return registry;
}

/**
 * Tool Runtime-internal: the frozen execution binding for `ref`, or
 * `undefined` if not registered. Only `executeTool` calls this; it is not
 * part of the package's public API. A registry not created by
 * `createToolRegistry` is a host programming error and throws.
 */
export function resolveToolBinding(registry: ToolRegistry, ref: ToolRef): ToolBinding | undefined {
  const tools = bindingsByRegistry.get(registry);
  if (tools === undefined) throw new Error("Tool Runtime requires a ToolRegistry created by createToolRegistry().");
  return tools.get(toolKey(ref));
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

/** Freezes a private JSON clone all the way down, so the stored spec cannot drift from what was compiled. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function toolKey(ref: { id: string; version: string }): string {
  // JSON-encoded so no id/version pair can collide with another via a separator.
  return JSON.stringify([ref.id, ref.version]);
}

function cloneSpec(spec: ToolSpec): ToolSpec {
  return JSON.parse(JSON.stringify(spec)) as ToolSpec;
}
