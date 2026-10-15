import { AdapterContractError, AdapterRefSchema, adapterRefKey, supportedCapabilities, type AdapterRef } from "@aao/adapters";
import { createAgentRegistry, type AgentRegistry, type RegisteredAgent } from "@aao/agent-runtime";
import type { ModelPolicySpec } from "@aao/contracts";
import { createModelPolicyRegistry, createModelRegistry, defineModelAdapter, type ModelAdapterDefinition, type ModelBindingIdentity, type ModelCapabilityId, type ModelPolicyRegistry, type ModelRegistry } from "@aao/model-runtime";
import { AAOFrameworkError } from "./errors.js";
import { defineModelPolicy } from "./definitions.js";
import { registrationFailure } from "./internal.js";

/**
 * Host deployment configuration for one model binding: the Model Runtime's
 * `ModelBinding` (id, explicit priority, endpoint capabilities, trusted
 * identity), with its live adapter replaced by an exact `adapterRef`. A
 * Workflow names only a `modelPolicyRef` and never sees an adapter, SDK, or
 * provider.
 */
export interface ModelBindingDefinition {
  id: string;
  priority: number;
  capabilities: readonly ModelCapabilityId[];
  identity?: ModelBindingIdentity;
  /** The exact adapter (id + version). There is no "latest" and no implicit selection. */
  adapterRef: AdapterRef;
}

/** A bounded Agent as the canonical Agent Runtime registers it: `AgentSpec` plus trusted instructions and limits. */
export type AgentDefinition = RegisteredAgent;

const BINDING_FIELDS = new Set(["id", "priority", "capabilities", "identity", "adapterRef"]);

const configurationError = (code: string, message: string) => new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", `${code}: ${message}`, [{ code, message }]);

export interface ModelComposition {
  models: ModelRegistry;
  policies: ModelPolicyRegistry;
  agents: AgentRegistry;
}

/**
 * Composes the *existing* Model Registry, Model Policy Registry, and Agent
 * Registry. It adds no registry, router, or Agent loop of its own:
 *
 * 1. Each adapter definition is re-validated through `defineModelAdapter`
 *    (manifest, `model` kind, captured `invoke`), so a caller mutation
 *    after `createAAO` changes nothing. A duplicate exact `id@version`
 *    fails (`ADAPTER_DUPLICATE`), whatever its content.
 * 2. Each binding must name a registered adapter exactly
 *    (`ADAPTER_NOT_FOUND`). Every endpoint capability it declares must be
 *    one the adapter's manifest declares supported
 *    (`ADAPTER_CAPABILITY_UNSUPPORTED`). All of this is decided before any
 *    provider call.
 * 3. Bindings, policies, and Agents are registered unchanged into the Core
 *    registries, which keep their own duplicate and schema rules.
 */
export function composeModels(options: { modelAdapters?: readonly ModelAdapterDefinition[]; modelBindings?: readonly ModelBindingDefinition[]; modelPolicies?: readonly ModelPolicySpec[]; agents?: readonly AgentDefinition[] }): ModelComposition {
  for (const [name, value] of Object.entries({ modelAdapters: options.modelAdapters, modelBindings: options.modelBindings, modelPolicies: options.modelPolicies, agents: options.agents })) {
    if (value !== undefined && !Array.isArray(value)) throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", `${name} must be an array`);
  }

  const adapters = new Map<string, ModelAdapterDefinition>();
  for (const input of [...(options.modelAdapters ?? [])]) {
    let definition: ModelAdapterDefinition;
    try {
      definition = defineModelAdapter(input);
    } catch (error) {
      if (error instanceof AdapterContractError) throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", `model adapter: ${error.message}`, [{ code: error.code, message: error.message }, ...error.issues.map((issue) => ({ code: error.code, message: issue }))]);
      throw registrationFailure("FRAMEWORK_INVALID_CONFIGURATION", "model adapter", error);
    }
    const key = adapterRefKey(definition.manifest);
    if (adapters.has(key)) throw configurationError("ADAPTER_DUPLICATE", `model adapter ${definition.manifest.id}@${definition.manifest.version} is registered more than once`);
    adapters.set(key, definition);
  }

  const models = createModelRegistry();
  for (const input of [...(options.modelBindings ?? [])]) {
    // Binding fields are validated by the canonical Model Registry below. Here only the shape and the exact adapterRef are checked.
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", "model binding must be an object");
    const unknown = Object.keys(input).filter((key) => !BINDING_FIELDS.has(key));
    if (unknown.length > 0) throw new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", `model binding has unknown fields: ${unknown.join(", ")}`);
    const ref = AdapterRefSchema.safeParse(input.adapterRef);
    if (!ref.success) throw configurationError("ADAPTER_NOT_FOUND", `model binding "${String(input.id)}" needs an exact adapterRef { id, version: MAJOR.MINOR.PATCH }`);
    const binding = { ...input, capabilities: Array.isArray(input.capabilities) ? [...input.capabilities] : input.capabilities, adapterRef: ref.data };
    const definition = adapters.get(adapterRefKey(binding.adapterRef));
    if (definition === undefined) throw configurationError("ADAPTER_NOT_FOUND", `model binding "${binding.id}" references adapter ${binding.adapterRef.id}@${binding.adapterRef.version}, which is not registered`);
    const supported = new Set<string>(supportedCapabilities(definition.manifest));
    const missing = (Array.isArray(binding.capabilities) ? binding.capabilities : []).filter((capability) => !supported.has(capability));
    if (missing.length > 0) throw configurationError("ADAPTER_CAPABILITY_UNSUPPORTED", `model binding "${binding.id}" requires ${missing.join(", ")}, which adapter ${definition.manifest.id}@${definition.manifest.version} does not declare supported`);
    try {
      models.register({ id: binding.id, priority: binding.priority, capabilities: binding.capabilities, ...(binding.identity ? { identity: binding.identity } : {}), adapter: definition.adapter });
    } catch (error) {
      throw registrationFailure("FRAMEWORK_INVALID_CONFIGURATION", "model binding", error);
    }
  }

  const policies = createModelPolicyRegistry();
  for (const input of [...(options.modelPolicies ?? [])]) {
    let policy: ModelPolicySpec;
    try {
      policy = defineModelPolicy(input);
    } catch (error) {
      throw error instanceof AAOFrameworkError ? new AAOFrameworkError("FRAMEWORK_INVALID_CONFIGURATION", error.message.slice(`${error.code}: `.length), error.diagnostics) : error;
    }
    try {
      policies.register(policy);
    } catch (error) {
      throw registrationFailure("FRAMEWORK_INVALID_CONFIGURATION", "model policy", error);
    }
  }

  const agents = createAgentRegistry();
  for (const agent of [...(options.agents ?? [])]) {
    try {
      agents.register(agent);
    } catch (error) {
      throw registrationFailure("FRAMEWORK_INVALID_CONFIGURATION", "agent", error);
    }
  }
  return { models, policies, agents };
}
