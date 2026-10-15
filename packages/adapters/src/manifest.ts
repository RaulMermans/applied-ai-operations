import { z } from "zod";
import { identifierSchema } from "@aao/contracts";
import { AdapterCapabilitySchema, AdapterKindSchema, CapabilitySupportSchema, capabilitiesForKind, type AdapterCapability, type AdapterKind, type CapabilitySupport } from "./capabilities.js";
import { AdapterContractError, type AdapterContractErrorCode } from "./errors.js";
import { deepFreeze, isJsonData, jsonClone, sha256Hex } from "./json.js";
import { AAO_ADAPTER_CONTRACT_VERSION } from "./version.js";

/** An exact adapter version: `MAJOR.MINOR.PATCH`. No ranges, tags, or "latest". */
export const AdapterVersionSchema = z.string().regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/, "must be an exact MAJOR.MINOR.PATCH version");
export const AdapterIdSchema = identifierSchema.max(128);

/** Exact adapter identity: id + version. A binding names one; there is no implicit latest. */
export const AdapterRefSchema = z.object({ id: AdapterIdSchema, version: AdapterVersionSchema }).strict();
export type AdapterRef = z.infer<typeof AdapterRefSchema>;

export const AdapterCapabilityDeclarationSchema = z.object({ capability: AdapterCapabilitySchema, support: CapabilitySupportSchema }).strict();
export type AdapterCapabilityDeclaration = z.infer<typeof AdapterCapabilityDeclarationSchema>;

/** Informational only: a bounded code plus optional prose. A limitation never changes behavior or grants anything. */
export const AdapterLimitationSchema = z.object({ code: identifierSchema.max(128), description: z.string().min(1).max(500).optional() }).strict();
export type AdapterLimitation = z.infer<typeof AdapterLimitationSchema>;

/**
 * AdapterManifest V1 — what an adapter *claims* to implement. It is
 * metadata, not authority: it grants no permission, establishes no
 * identity, and cannot set a Principal, Role, permission class, Approval
 * status, retry or recovery safety, or Tool support class. Strict (unknown
 * fields such as `permissions`, `apiKey`, `credentials`, or `module` are
 * rejected), JSON-safe, versioned, and free of handlers, SDK objects,
 * module paths, and dynamic-import targets. The host imports the
 * executable code; the manifest only describes it.
 *
 * Every capability of the adapter's kind is declared exactly once, so a
 * manifest is complete and the compatibility matrix has no blank cells.
 */
export const AdapterManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapterContractVersion: z.literal(AAO_ADAPTER_CONTRACT_VERSION),
    id: AdapterIdSchema,
    version: AdapterVersionSchema,
    kind: AdapterKindSchema,
    displayName: z.string().min(1).max(128).optional(),
    capabilities: z.array(AdapterCapabilityDeclarationSchema).max(32),
    limitations: z.array(AdapterLimitationSchema).max(32).optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const catalog = capabilitiesForKind(manifest.kind);
    const declared = manifest.capabilities.map((entry) => entry.capability);
    const seen = new Set<string>();
    declared.forEach((capability, index) => {
      if (seen.has(capability)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities", index, "capability"], message: `capability "${capability}" is declared more than once` });
      seen.add(capability);
      if (!(catalog as readonly string[]).includes(capability)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities", index, "capability"], message: `capability "${capability}" is not in the ${manifest.kind} catalog` });
    });
    for (const capability of catalog) {
      if (!seen.has(capability)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities"], message: `capability "${capability}" must be declared supported or unsupported` });
    }
    const codes = new Set<string>();
    (manifest.limitations ?? []).forEach((limitation, index) => {
      if (codes.has(limitation.code)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["limitations", index, "code"], message: `limitation "${limitation.code}" is declared more than once` });
      codes.add(limitation.code);
    });
  });
export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

/** What a host passes to `defineAdapterManifest`: the manifest without the fixed envelope fields, which default to the current contract. */
export type AdapterManifestInput = Omit<AdapterManifest, "schemaVersion" | "adapterContractVersion"> & { schemaVersion?: 1; adapterContractVersion?: number };

export type AdapterManifestValidation = { ok: true; manifest: AdapterManifest } | { ok: false; code: Extract<AdapterContractErrorCode, "ADAPTER_MANIFEST_INVALID" | "ADAPTER_CONTRACT_VERSION_UNSUPPORTED">; issues: string[] };

/**
 * Pure manifest validation. A different `adapterContractVersion` fails as
 * `ADAPTER_CONTRACT_VERSION_UNSUPPORTED` before anything else is judged.
 * The returned manifest is a canonical copy (capabilities in catalog
 * order, limitations sorted by code) and is not frozen.
 */
export function validateAdapterManifest(input: unknown): AdapterManifestValidation {
  if (!isJsonData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, code: "ADAPTER_MANIFEST_INVALID", issues: ["(manifest): must be a plain JSON object (no functions, class instances, symbols, or accessors)"] };
  const version = (input as { adapterContractVersion?: unknown }).adapterContractVersion;
  if (version !== AAO_ADAPTER_CONTRACT_VERSION) return { ok: false, code: "ADAPTER_CONTRACT_VERSION_UNSUPPORTED", issues: [`adapterContractVersion: ${JSON.stringify(version ?? null)} is not supported; this contract is version ${AAO_ADAPTER_CONTRACT_VERSION}`] };
  const parsed = AdapterManifestSchema.safeParse(jsonClone(input));
  if (!parsed.success) return { ok: false, code: "ADAPTER_MANIFEST_INVALID", issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(manifest)"}: ${issue.message}`) };
  return { ok: true, manifest: canonicalManifest(parsed.data) };
}

/**
 * Validates a manifest and returns a detached, deep-frozen canonical copy.
 * Mutating the caller's input afterwards changes nothing. The envelope
 * fields default to the current schema and contract versions; an explicit
 * other contract version is refused.
 */
export function defineAdapterManifest(input: AdapterManifestInput): AdapterManifest {
  const candidate = input !== null && typeof input === "object" && !Array.isArray(input) ? { schemaVersion: 1, adapterContractVersion: AAO_ADAPTER_CONTRACT_VERSION, ...input } : input;
  const validated = validateAdapterManifest(candidate);
  if (!validated.ok) throw new AdapterContractError(validated.code, "adapter manifest is invalid", validated.issues);
  return deepFreeze(validated.manifest);
}

/** The declared support for one capability, or `undefined` if the kind's catalog does not contain it. */
export function declaredSupport(manifest: AdapterManifest, capability: AdapterCapability): CapabilitySupport | undefined {
  return manifest.capabilities.find((entry) => entry.capability === capability)?.support;
}

/** Capabilities the manifest declares `supported`, in catalog order. */
export function supportedCapabilities(manifest: AdapterManifest): AdapterCapability[] {
  return manifest.capabilities.filter((entry) => entry.support === "supported").map((entry) => entry.capability);
}

/**
 * A deterministic fingerprint of the manifest's semantic fields: *manifest
 * identity*, never a code signature. It does not hash executable code and
 * attests nothing about a binary or package (code attestation is deferred).
 */
export function adapterManifestFingerprint(manifest: AdapterManifest): string {
  return sha256Hex(canonicalManifest(manifest));
}

export function adapterRefOf(manifest: Pick<AdapterManifest, "id" | "version">): AdapterRef {
  return { id: manifest.id, version: manifest.version };
}

export function adapterRefKey(ref: AdapterRef): string {
  // JSON-encoded so no id/version pair can collide with another via a separator.
  return JSON.stringify([ref.id, ref.version]);
}

function canonicalManifest(manifest: AdapterManifest): AdapterManifest {
  const order = capabilitiesForKind(manifest.kind as AdapterKind) as readonly string[];
  return {
    schemaVersion: 1,
    adapterContractVersion: AAO_ADAPTER_CONTRACT_VERSION,
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    ...(manifest.displayName !== undefined ? { displayName: manifest.displayName } : {}),
    capabilities: [...manifest.capabilities].sort((a, b) => order.indexOf(a.capability) - order.indexOf(b.capability)).map((entry) => ({ capability: entry.capability, support: entry.support })),
    ...(manifest.limitations !== undefined ? { limitations: [...manifest.limitations].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).map((entry) => ({ ...entry })) } : {}),
  };
}
