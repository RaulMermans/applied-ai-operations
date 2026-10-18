import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJsonStringify,
  identifierSchema,
  GovernanceConfigurationSchema,
  ReliabilityPolicySchema,
  type JsonValue,
} from "@aao/contracts";

export const COMPANY_MANIFEST_SCHEMA_VERSION = 1 as const;

export const ENABLED_PROOF_NAMES = [
  "company_research",
  "document_intelligence",
  "operational_request",
] as const;

export const EnabledProofSchema = z.enum(ENABLED_PROOF_NAMES);
export type EnabledProof = z.infer<typeof EnabledProofSchema>;

export const CompanyModelsConfigSchema = z
  .object({
    bindingRefs: z
      .array(identifierSchema)
      .min(1, "models.bindingRefs must contain at least one binding reference")
      .refine((arr) => new Set(arr).size === arr.length, {
        message: "models.bindingRefs must not contain duplicate entries",
      }),
  })
  .strict();
export type CompanyModelsConfig = z.infer<typeof CompanyModelsConfigSchema>;

export const CompanyIntegrationsConfigSchema = z
  .object({
    publicWebProviderRef: identifierSchema.optional(),
    documentSourceProviderRef: identifierSchema.optional(),
    draftRepositoryRef: identifierSchema.optional(),
  })
  .strict();
export type CompanyIntegrationsConfig = z.infer<typeof CompanyIntegrationsConfigSchema>;

export const CompanyReliabilityConfigSchema = z
  .object({
    company_research: z.record(identifierSchema, ReliabilityPolicySchema).optional(),
    document_intelligence: z.record(identifierSchema, ReliabilityPolicySchema).optional(),
    operational_request: z.record(identifierSchema, ReliabilityPolicySchema).optional(),
  })
  .strict();
export type CompanyReliabilityConfig = z.infer<typeof CompanyReliabilityConfigSchema>;

export const CompanyManifestV1Schema = z
  .object({
    schemaVersion: z.literal(COMPANY_MANIFEST_SCHEMA_VERSION),
    companyId: identifierSchema,
    displayName: z
      .string()
      .min(1, "displayName must be at least 1 character")
      .max(120, "displayName must be at most 120 characters")
      .refine(
        (s) => s.trim() === s && !s.includes("\n") && !s.includes("\r"),
        { message: "displayName must be a trimmed single-line string" }
      ),
    enabledProofs: z
      .array(EnabledProofSchema)
      .min(1, "enabledProofs must contain at least one proof")
      .refine((arr) => new Set(arr).size === arr.length, {
        message: "enabledProofs must not contain duplicate entries",
      }),
    models: CompanyModelsConfigSchema,
    integrations: CompanyIntegrationsConfigSchema,
    governance: GovernanceConfigurationSchema,
    reliability: CompanyReliabilityConfigSchema.optional(),
  })
  .strict();

export type CompanyManifestV1 = z.infer<typeof CompanyManifestV1Schema>;

/**
 * Computes a deterministic SHA-256 fingerprint of the normalized validated manifest
 * using AAO canonical JSON serialization.
 */
export function computeCompanyConfigFingerprint(manifest: CompanyManifestV1): string {
  const serialized = canonicalJsonStringify(manifest as unknown as JsonValue);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * Recursively freezes an object and its nested properties defensively.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Object.isFrozen(value)) {
    return value as Readonly<T>;
  }

  const keys = Reflect.ownKeys(value as object);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && "value" in desc && desc.value !== null && typeof desc.value === "object") {
      deepFreeze(desc.value);
    }
  }

  return Object.freeze(value) as Readonly<T>;
}
