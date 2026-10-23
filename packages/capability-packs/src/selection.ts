import { z } from "zod";
import { identifierSchema } from "@aao/contracts";
import { ExactPackVersionSchema } from "./contract.js";
import { CapabilityPackError } from "./errors.js";
import { deepFreeze, hasPrototypePollutionKey } from "./json.js";

export const COMPANY_PACK_SELECTION_SCHEMA_VERSION = 1 as const;

export const CompanyPackSelectionRefSchema = z
  .object({
    id: identifierSchema.max(128),
    version: ExactPackVersionSchema,
  })
  .strict();
export type CompanyPackSelectionRef = z.infer<typeof CompanyPackSelectionRefSchema>;

export const CompanyPackSelectionV1Schema = z
  .object({
    schemaVersion: z.literal(COMPANY_PACK_SELECTION_SCHEMA_VERSION),
    companyId: identifierSchema,
    packRefs: z
      .array(CompanyPackSelectionRefSchema)
      .min(1, "packRefs must contain at least one pack reference")
      .refine(
        (arr) => {
          const seen = new Set<string>();
          for (const ref of arr) {
            const key = `${ref.id}@${ref.version}`;
            if (seen.has(key)) return false;
            seen.add(key);
          }
          return true;
        },
        { message: "packRefs must not contain duplicate pack references" }
      ),
  })
  .strict();

export type CompanyPackSelectionV1 = z.infer<typeof CompanyPackSelectionV1Schema>;
export type CompanyPackSelectionV1Input = z.input<typeof CompanyPackSelectionV1Schema>;

export function validateCompanyPackSelection(raw: unknown): Readonly<CompanyPackSelectionV1> {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CapabilityPackError("PACK_INVALID_MANIFEST", "Pack selection input is not valid JSON");
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapabilityPackError("PACK_INVALID_MANIFEST", "Pack selection must be a non-null object");
  }

  if (hasPrototypePollutionKey(parsed)) {
    throw new CapabilityPackError("PACK_INVALID_MANIFEST", "Pack selection contains forbidden prototype-pollution key");
  }

  const candidate = parsed as Record<string, unknown>;
  if (!("schemaVersion" in candidate)) {
    throw new CapabilityPackError("PACK_INVALID_MANIFEST", "Pack selection is missing required field: schemaVersion");
  }

  if (candidate.schemaVersion !== COMPANY_PACK_SELECTION_SCHEMA_VERSION) {
    throw new CapabilityPackError(
      "PACK_UNSUPPORTED_VERSION",
      `Unsupported selection schemaVersion ${String(candidate.schemaVersion)}; expected ${COMPANY_PACK_SELECTION_SCHEMA_VERSION}`
    );
  }

  const result = CompanyPackSelectionV1Schema.safeParse(candidate);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const pathStr = firstIssue ? firstIssue.path.join(".") : "";
    const msg = firstIssue ? `${firstIssue.message} (at ${pathStr})` : "Selection validation failed";
    throw new CapabilityPackError("PACK_INVALID_MANIFEST", msg, { path: pathStr });
  }

  return deepFreeze(result.data);
}
