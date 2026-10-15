import type { AdapterCapability, AdapterKind } from "./capabilities.js";
import type { AdapterContractErrorCode } from "./errors.js";
import { supportedCapabilities, validateAdapterManifest, type AdapterRef } from "./manifest.js";

export interface AdapterCompatibilityRequirements {
  /** The port the caller will use. A manifest of another kind is never compatible. */
  kind: AdapterKind;
  /** Capabilities the caller relies on; each must be declared `supported`. */
  requiredCapabilities: readonly AdapterCapability[];
  /** Optional exact identity the caller bound to. A different version is incompatible, never "close enough". */
  adapterRef?: AdapterRef;
}

export type AdapterCompatibilityMismatch = Extract<AdapterContractErrorCode, "ADAPTER_MANIFEST_INVALID" | "ADAPTER_CONTRACT_VERSION_UNSUPPORTED" | "ADAPTER_KIND_MISMATCH" | "ADAPTER_NOT_FOUND" | "ADAPTER_CAPABILITY_UNSUPPORTED">;

export interface AdapterCompatibilityResult {
  compatible: boolean;
  /** Required capabilities the manifest does not declare `supported`, in the order requested. */
  missingCapabilities: AdapterCapability[];
  /** Every reason the manifest is incompatible, in a fixed order. */
  mismatches: AdapterCompatibilityMismatch[];
}

/**
 * Pure, deterministic registration-time compatibility: is the declared
 * capability set a superset of what is required, for the right kind,
 * contract version, and exact identity? No model, side effect, or
 * selection is involved, and the caller chooses the adapter explicitly.
 *
 * Compatibility is not security. A compatible adapter can still be
 * unauthorized for a Run. Authorization, Governance, and the Tool support
 * gate decide that, and nothing here grants anything. Compatibility is also
 * only a claim. Conformance verifies it.
 */
export function checkAdapterCompatibility(params: { manifest: unknown; requirements: AdapterCompatibilityRequirements }): AdapterCompatibilityResult {
  const { requirements } = params;
  const validated = validateAdapterManifest(params.manifest);
  if (!validated.ok) return { compatible: false, missingCapabilities: [...requirements.requiredCapabilities], mismatches: [validated.code] };
  const manifest = validated.manifest;
  const mismatches: AdapterCompatibilityMismatch[] = [];
  if (manifest.kind !== requirements.kind) mismatches.push("ADAPTER_KIND_MISMATCH");
  if (requirements.adapterRef !== undefined && (requirements.adapterRef.id !== manifest.id || requirements.adapterRef.version !== manifest.version)) mismatches.push("ADAPTER_NOT_FOUND");
  const supported = new Set<string>(supportedCapabilities(manifest));
  const missingCapabilities = [...new Set(requirements.requiredCapabilities)].filter((capability) => !supported.has(capability));
  if (missingCapabilities.length > 0) mismatches.push("ADAPTER_CAPABILITY_UNSUPPORTED");
  return { compatible: mismatches.length === 0, missingCapabilities, mismatches };
}
