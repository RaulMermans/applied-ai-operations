import { z } from "zod";
import {
  identifierSchema,
} from "@aao/contracts";
import { CapabilityPackError } from "./errors.js";
import { hasPrototypePollutionKey } from "./json.js";

export const CAPABILITY_PACK_SCHEMA_VERSION = 1 as const;

/** An exact version: MAJOR.MINOR.PATCH. No ranges (^1, >=1), tags, wildcards, or "latest". */
export const ExactPackVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/,
    "must be an exact MAJOR.MINOR.PATCH version"
  );

/** Lowercase slug with letters, digits, and hyphens/underscores (at most 32 chars). */
export const SlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, "must be a lowercase slug (a-z, 0-9, -, _; at most 32 characters)");

/** An exact Tool reference: canonical Tool id plus exact version. */
export const ExactToolRefSchema = z
  .object({
    id: identifierSchema.max(128),
    version: ExactPackVersionSchema,
  })
  .strict();
export type ExactToolRef = z.infer<typeof ExactToolRefSchema>;

/** Canonical Capability Pack reference: id + exact version. */
export const CapabilityPackRefSchema = z
  .object({
    id: identifierSchema.max(128),
    version: ExactPackVersionSchema,
  })
  .strict();
export type CapabilityPackRef = z.infer<typeof CapabilityPackRefSchema>;

export const IntegrationSlotRequirementSchema = z
  .object({
    slot: SlugSchema,
    description: z.string().trim().min(1).max(300),
  })
  .strict();
export type IntegrationSlotRequirement = z.infer<typeof IntegrationSlotRequirementSchema>;

export const SUPPORTED_PERMISSION_CLASSES = ["read_only", "write_draft"] as const;
export const SupportedPermissionClassSchema = z.enum(SUPPORTED_PERMISSION_CLASSES);

export const SUPPORTED_MODEL_CAPABILITIES = [
  "model.text_generation",
  "model.structured_output",
  "model.usage",
  "model.cancellation",
  "model.tool_call_response",
] as const;
export const SupportedModelCapabilitySchema = z.enum(SUPPORTED_MODEL_CAPABILITIES);
export type SupportedModelCapability = z.infer<typeof SupportedModelCapabilitySchema>;

export const ExactEvalProfileRefSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9]+(?:[._:-][a-zA-Z0-9]+)*@(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/,
    "evalProfileRef must be an exact reference format: evalProfileId@MAJOR.MINOR.PATCH"
  );

export const ApprovalRequirementSchema = z
  .object({
    required: z.boolean(),
    requiredRoleIds: z
      .array(identifierSchema.max(128))
      .min(1, "approval.requiredRoleIds must contain at least one role")
      .max(16)
      .refine((arr) => new Set(arr).size === arr.length, {
        message: "approval.requiredRoleIds must not contain duplicate entries",
      }),
    permissionClasses: z
      .array(SupportedPermissionClassSchema)
      .min(1, "approval.permissionClasses must contain at least one permission class")
      .max(2)
      .refine((arr) => new Set(arr).size === arr.length, {
        message: "approval.permissionClasses must not contain duplicate entries",
      }),
  })
  .strict();
export type ApprovalRequirement = z.infer<typeof ApprovalRequirementSchema>;

export const CapabilityPackOutcomeClassSchema = z.enum(["read_only", "draft_only"]);
export type CapabilityPackOutcomeClass = z.infer<typeof CapabilityPackOutcomeClassSchema>;

export const WorkflowBindingRequirementSchema = z
  .object({
    id: identifierSchema.max(128),
    version: ExactPackVersionSchema,
    planFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "workflow.planFingerprint must be a 64-character lowercase SHA-256 hex string"),
  })
  .strict();
export type WorkflowBindingRequirement = z.infer<typeof WorkflowBindingRequirementSchema>;

export const FORBIDDEN_AUTHORITY_FIELDS = Object.freeze([
  "handler",
  "execute",
  "script",
  "modulePath",
  "dynamicImport",
  "eval",
  "skipAuthorization",
  "disableApproval",
  "forceSuccess",
  "allowExternalEffects",
] as const);

export const CapabilityPackManifestV1Schema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_PACK_SCHEMA_VERSION),
    id: identifierSchema.max(128),
    version: ExactPackVersionSchema,
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(1000),
    category: SlugSchema,
    tags: z
      .array(SlugSchema)
      .min(1, "tags must contain at least one tag")
      .max(16)
      .refine((arr) => new Set(arr).size === arr.length, {
        message: "tags must be unique",
      }),
    workflow: WorkflowBindingRequirementSchema,
    requirements: z
      .object({
        toolRefs: z
          .array(ExactToolRefSchema)
          .max(64)
          .refine(
            (arr) => {
              const seen = new Set<string>();
              for (const r of arr) {
                const k = `${r.id}@${r.version}`;
                if (seen.has(k)) return false;
                seen.add(k);
              }
              return true;
            },
            { message: "requirements.toolRefs must not contain duplicate tool references" }
          ),
        modelPolicyRefs: z
          .array(identifierSchema.max(128))
          .max(32)
          .refine((arr) => new Set(arr).size === arr.length, {
            message: "requirements.modelPolicyRefs must not contain duplicate entries",
          }),
        modelCapabilities: z
          .array(z.string().trim().min(1).max(128))
          .max(16)
          .refine((arr) => new Set(arr).size === arr.length, {
            message: "requirements.modelCapabilities must not contain duplicate entries",
          }),
        integrationSlots: z
          .array(IntegrationSlotRequirementSchema)
          .max(16)
          .refine(
            (arr) => {
              const seen = new Set<string>();
              for (const s of arr) {
                if (seen.has(s.slot)) return false;
                seen.add(s.slot);
              }
              return true;
            },
            { message: "requirements.integrationSlots must not contain duplicate slots" }
          ),
        preliminaryPermissions: z
          .array(SupportedPermissionClassSchema)
          .min(1, "requirements.preliminaryPermissions must contain at least one permission class")
          .max(2)
          .refine((arr) => new Set(arr).size === arr.length, {
            message: "requirements.preliminaryPermissions must not contain duplicate entries",
          }),
        approval: ApprovalRequirementSchema.optional(),
      })
      .strict(),
    execution: z
      .object({
        outcomeClass: CapabilityPackOutcomeClassSchema,
      })
      .strict(),
    verification: z
      .object({
        evalProfileRef: z
          .string()
          .regex(
            /^[a-zA-Z0-9]+(?:[._:-][a-zA-Z0-9]+)*@(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/,
            "evalProfileRef must be an exact reference format: evalProfileId@MAJOR.MINOR.PATCH"
          ),
      })
      .strict(),
    documentation: z
      .object({
        summary: z.string().trim().min(1).max(1000),
        limitations: z
          .array(z.string().trim().min(1).max(500))
          .min(1, "documentation.limitations must contain at least one limitation")
          .max(32),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    // 1. Outcome coherence
    if (manifest.execution.outcomeClass === "read_only") {
      if (manifest.requirements.preliminaryPermissions.some((p) => p !== "read_only")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requirements", "preliminaryPermissions"],
          message: "read_only packs may only declare preliminary permission 'read_only'",
        });
      }
      if (manifest.requirements.approval?.required) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requirements", "approval"],
          message: "read_only packs cannot require human approval",
        });
      }
    }

    if (manifest.execution.outcomeClass === "draft_only") {
      if (!manifest.requirements.preliminaryPermissions.includes("write_draft")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requirements", "preliminaryPermissions"],
          message: "draft_only packs must declare preliminary permission 'write_draft'",
        });
      }
    }

    // 2. Approval coherence
    if (manifest.requirements.approval?.required) {
      for (const perm of manifest.requirements.approval.permissionClasses) {
        if (!manifest.requirements.preliminaryPermissions.includes(perm)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["requirements", "approval", "permissionClasses"],
            message: `approval permission class '${perm}' must be included in preliminaryPermissions`,
          });
        }
      }
    }
  });

export type CapabilityPackManifestV1 = z.infer<typeof CapabilityPackManifestV1Schema>;
export type CapabilityPackManifestV1Input = z.input<typeof CapabilityPackManifestV1Schema>;

function scanForForbiddenKeys(obj: unknown, path = ""): string | null {
  if (obj === null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = scanForForbiddenKeys(obj[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if ((FORBIDDEN_AUTHORITY_FIELDS as readonly string[]).includes(key)) {
      return path ? `${path}.${key}` : key;
    }
    const hit = scanForForbiddenKeys(rec[key], path ? `${path}.${key}` : key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Validates a raw capability pack manifest against the CapabilityPackManifestV1 specification.
 */
export function validateCapabilityPackManifest(raw: unknown): CapabilityPackManifestV1 {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CapabilityPackError("PACK_INVALID_MANIFEST", "Manifest input is not valid JSON");
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapabilityPackError("PACK_INVALID_MANIFEST", "Manifest must be a non-null object");
  }

  if (hasPrototypePollutionKey(parsed)) {
    throw new CapabilityPackError("PACK_INVALID_MANIFEST", "Manifest contains forbidden prototype-pollution key");
  }

  const forbiddenKey = scanForForbiddenKeys(parsed);
  if (forbiddenKey) {
    throw new CapabilityPackError(
      "PACK_INVALID_MANIFEST",
      `Manifest contains forbidden authority override field: ${forbiddenKey}`
    );
  }

  const candidate = parsed as Record<string, unknown>;
  if (!("schemaVersion" in candidate)) {
    throw new CapabilityPackError("PACK_INVALID_MANIFEST", "Manifest is missing required field: schemaVersion");
  }

  if (candidate.schemaVersion !== CAPABILITY_PACK_SCHEMA_VERSION) {
    throw new CapabilityPackError(
      "PACK_UNSUPPORTED_VERSION",
      `Unsupported schemaVersion ${String(candidate.schemaVersion)}; expected ${CAPABILITY_PACK_SCHEMA_VERSION}`
    );
  }

  const result = CapabilityPackManifestV1Schema.safeParse(candidate);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const pathStr = firstIssue ? firstIssue.path.join(".") : "";
    const msg = firstIssue ? `${firstIssue.message} (at ${pathStr})` : "Schema validation failed";
    throw new CapabilityPackError("PACK_INVALID_MANIFEST", msg, { path: pathStr });
  }

  return result.data;
}

export function packRefKey(ref: { id: string; version: string }): string {
  return `${ref.id}@${ref.version}`;
}
