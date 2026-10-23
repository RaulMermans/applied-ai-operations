import type { JsonValue } from "@aao/contracts";
import {
  packRefKey,
  validateCapabilityPackManifest,
  type CapabilityPackManifestV1,
  type CapabilityPackManifestV1Input,
  type CapabilityPackRef,
} from "./contract.js";
import { deepFreeze, sha256Hex } from "./json.js";

/**
 * An immutable, versioned Capability Pack definition.
 * Holds verified descriptive metadata and exact dependency contracts.
 * It does not execute, authorize, or register anything by itself.
 */
export interface CapabilityPack {
  readonly ref: CapabilityPackRef;
  readonly identity: string;
  readonly manifest: Readonly<CapabilityPackManifestV1>;
  readonly fingerprint: string;
}

/**
 * Defines an immutable Capability Pack from a validated V1 manifest.
 *
 * Responsibilities:
 * 1. Parse and strictly validate the manifest against CapabilityPackManifestV1Schema.
 * 2. Reject forbidden authority fields (handler, execute, skipAuthorization, etc.).
 * 3. Enforce exact SemVer versions and no wildcards/ranges.
 * 4. Compute deterministic SHA-256 manifest fingerprint using canonical JSON stringification.
 * 5. Deep-freeze the pack snapshot.
 *
 * It does NOT instantiate the Framework, register Tools, or execute Workflows.
 */
export function defineCapabilityPack(manifestInput: CapabilityPackManifestV1Input | unknown): CapabilityPack {
  const manifest = validateCapabilityPackManifest(manifestInput);
  const frozenManifest = deepFreeze(manifest);
  const fingerprint = sha256Hex(frozenManifest as unknown as JsonValue);
  const identity = packRefKey(manifest);

  const pack: CapabilityPack = deepFreeze({
    ref: Object.freeze({ id: manifest.id, version: manifest.version }),
    identity,
    manifest: frozenManifest,
    fingerprint,
  });

  return pack;
}
