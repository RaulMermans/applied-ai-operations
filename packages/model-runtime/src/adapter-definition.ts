import { AdapterContractError, defineAdapterManifest, type AdapterManifest, type AdapterManifestInput } from "@aao/adapters";
import type { ModelAdapter, ModelAdapterContext, ModelAdapterRequest } from "./types.js";

/**
 * A registrable model adapter: the JSON-safe `AdapterManifest` (what it
 * claims) plus the trusted executable `ModelAdapter` port (what the host
 * imported). The manifest describes the code and never loads it.
 */
export interface ModelAdapterDefinition {
  readonly manifest: AdapterManifest;
  readonly adapter: ModelAdapter;
}

export interface ModelAdapterDefinitionInput {
  manifest: AdapterManifest | AdapterManifestInput;
  adapter: ModelAdapter;
}

/**
 * Pairs a manifest with the canonical `ModelAdapter` port. This is the only
 * public adapter-definition helper, and there is no second `ModelAdapter`
 * interface.
 *
 * - The manifest is validated (`ADAPTER_MANIFEST_INVALID` /
 *   `ADAPTER_CONTRACT_VERSION_UNSUPPORTED`) and snapshotted, so a later
 *   caller mutation changes nothing.
 * - It must be a `model` manifest (`ADAPTER_KIND_MISMATCH`).
 * - `invoke` is captured once (`ADAPTER_IMPLEMENTATION_INVALID` when
 *   missing), so reassigning it on the caller's object afterwards cannot
 *   change what runs or widen what was declared.
 *
 * Defining an adapter grants nothing. The Runtime, Model Policy,
 * Governance, and Authorization still decide everything.
 */
export function defineModelAdapter(input: ModelAdapterDefinitionInput): ModelAdapterDefinition {
  if (input === null || typeof input !== "object") throw new AdapterContractError("ADAPTER_IMPLEMENTATION_INVALID", "a model adapter definition needs a manifest and an adapter");
  const manifest = defineAdapterManifest(input.manifest as AdapterManifestInput);
  if (manifest.kind !== "model") throw new AdapterContractError("ADAPTER_KIND_MISMATCH", `adapter ${manifest.id}@${manifest.version} is a ${manifest.kind} adapter, not a model adapter`);
  const source = input.adapter;
  const invoke = source?.invoke;
  if (typeof invoke !== "function") throw new AdapterContractError("ADAPTER_IMPLEMENTATION_INVALID", `adapter ${manifest.id}@${manifest.version} has no invoke function`);
  const adapter: ModelAdapter = Object.freeze({ invoke: (request: ModelAdapterRequest, context: ModelAdapterContext) => invoke.call(source, request, context) });
  return Object.freeze({ manifest, adapter });
}
