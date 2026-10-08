import { z } from "zod";
import { identifierSchema } from "@aao/contracts";
import { ModelCapabilityIdSchema, type ModelAdapter, type ModelCapabilityId } from "./types.js";

/**
 * One registered inference endpoint. `id` is an AAO binding id (e.g.
 * `local.fast`), never a provider API model name. `priority` is explicit:
 * a higher number is preferred. `capabilities` are explicit. `adapter` is
 * the live dependency that performs the invocation — it is never serialized.
 */
export interface ModelBinding {
  id: string;
  priority: number;
  capabilities: readonly ModelCapabilityId[];
  adapter: ModelAdapter;
  /**
   * Optional trusted registration metadata naming what this binding invokes
   * (ADR-020). Recorded in traces only when registered: never inferred by
   * parsing a binding id, never derived from model output.
   */
  identity?: ModelBindingIdentity;
}

export const ModelBindingIdentitySchema = z
  .object({ provider: identifierSchema.max(128), model: z.string().min(1).max(128), revision: z.string().min(1).max(128).optional() })
  .strict();
export type ModelBindingIdentity = z.infer<typeof ModelBindingIdentitySchema>;

const ModelBindingDefinitionSchema = z
  .object({
    id: identifierSchema,
    priority: z.number().int(),
    capabilities: z.array(ModelCapabilityIdSchema).min(1),
    identity: ModelBindingIdentitySchema.optional(),
  })
  .strict();

/** Explicit, constructible, isolated Model Registry. No global singleton, no environment discovery. */
export interface ModelRegistry {
  /** Throws on a malformed binding or a duplicate id — both are programming errors, not runtime failures. */
  register(binding: ModelBinding): void;
  get(id: string): ModelBinding | undefined;
  /** Every binding, sorted by id — never registration order, so nothing downstream can depend on it. */
  list(): ModelBinding[];
}

export function createModelRegistry(): ModelRegistry {
  const bindings = new Map<string, ModelBinding>();
  return {
    register(binding: ModelBinding): void {
      const parsed = ModelBindingDefinitionSchema.safeParse({ id: binding.id, priority: binding.priority, capabilities: [...binding.capabilities], ...(binding.identity !== undefined ? { identity: binding.identity } : {}) });
      if (!parsed.success) {
        throw new Error(`ModelRegistry: invalid model binding "${String(binding.id)}".`);
      }
      if (typeof binding.adapter?.invoke !== "function") {
        throw new Error(`ModelRegistry: model binding "${binding.id}" has no adapter.`);
      }
      if (bindings.has(binding.id)) {
        throw new Error(`ModelRegistry: a model binding with id "${binding.id}" is already registered.`);
      }
      bindings.set(binding.id, {
        id: parsed.data.id,
        priority: parsed.data.priority,
        capabilities: Object.freeze([...new Set(parsed.data.capabilities)].sort()),
        adapter: binding.adapter,
        ...(parsed.data.identity ? { identity: Object.freeze({ ...parsed.data.identity }) } : {}),
      });
    },
    get(id: string): ModelBinding | undefined {
      return bindings.get(id);
    },
    list(): ModelBinding[] {
      return [...bindings.values()].sort((a, b) => compareIds(a.id, b.id));
    },
  };
}

/** Locale-independent, code-unit ordering: deterministic on every machine. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
