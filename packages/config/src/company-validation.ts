import {
  CompanyManifestV1Schema,
  computeCompanyConfigFingerprint,
  deepFreeze,
  COMPANY_MANIFEST_SCHEMA_VERSION,
  type CompanyManifestV1,
} from "./company-manifest.js";
import { CompanyConfigError } from "./errors.js";

/**
 * Checks for prototype pollution keys recursively in any object/array.
 */
function hasPrototypePollutionKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(hasPrototypePollutionKey);
  }

  const obj = value as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(obj, "__proto__") ||
    Object.prototype.hasOwnProperty.call(obj, "constructor") ||
    Object.prototype.hasOwnProperty.call(obj, "prototype")
  ) {
    return true;
  }

  for (const key of Object.keys(obj)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return true;
    }
    if (hasPrototypePollutionKey(obj[key])) {
      return true;
    }
  }

  return false;
}

const SUPPORTED_PERMISSION_CLASSES = new Set(["read_only", "write_draft"]);

export interface ValidatedCompanyManifestResult {
  readonly manifest: Readonly<CompanyManifestV1>;
  readonly configFingerprint: string;
}

/**
 * Validates a company manifest against the Company Manifest V1 specification
 * using strict deterministic preflight rules.
 *
 * Validation Order:
 * 1. Parse JSON if string input; check for null/primitive.
 * 2. Reject prototype pollution keys.
 * 3. Validate schemaVersion (strictly 1).
 * 4. Validate schema structure and bounds with Zod strict mode.
 * 5. Validate company identity.
 * 6. Validate enabled proofs references (no duplicates).
 * 7. Validate Governance structure and coherence (unique IDs, referential integrity).
 * 8. Enforce Permission Safety (unsupported permission classes fail closed).
 * 9. Validate model binding references.
 * 10. Validate required integration references for enabled proofs.
 * 11. Validate reliability bounds.
 * 12. Freeze validated snapshot and compute deterministic configuration fingerprint.
 */
export function validateCompanyManifest(raw: unknown): ValidatedCompanyManifestResult {
  let parsed: unknown = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CompanyConfigError("CONFIG_INVALID_SCHEMA", "Manifest input is not valid JSON");
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CompanyConfigError("CONFIG_INVALID_SCHEMA", "Manifest must be a non-null object");
  }

  if (hasPrototypePollutionKey(parsed)) {
    throw new CompanyConfigError(
      "CONFIG_INVALID_SCHEMA",
      "Manifest contains forbidden prototype-pollution key"
    );
  }

  const candidate = parsed as Record<string, unknown>;

  // Check schemaVersion explicitly for clean version-mismatch taxonomy
  if (!("schemaVersion" in candidate)) {
    throw new CompanyConfigError(
      "CONFIG_INVALID_SCHEMA",
      "Manifest is missing required field: schemaVersion"
    );
  }

  if (candidate.schemaVersion !== COMPANY_MANIFEST_SCHEMA_VERSION) {
    throw new CompanyConfigError(
      "CONFIG_UNSUPPORTED_VERSION",
      `Unsupported manifest schemaVersion: ${String(candidate.schemaVersion)}; expected ${COMPANY_MANIFEST_SCHEMA_VERSION}`
    );
  }

  const parseResult = CompanyManifestV1Schema.safeParse(candidate);
  if (!parseResult.success) {
    const formatted = parseResult.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new CompanyConfigError(
      "CONFIG_INVALID_SCHEMA",
      `Manifest schema validation failed: ${formatted}`,
      { details: { issues: parseResult.error.issues } }
    );
  }

  const manifest = parseResult.data;

  // Governance referential integrity and coherence
  const actorIds = new Set<string>();
  for (const actor of manifest.governance.actors) {
    if (actorIds.has(actor.id)) {
      throw new CompanyConfigError(
        "CONFIG_GOVERNANCE_INVALID",
        `Duplicate governance actor ID: '${actor.id}'`
      );
    }
    actorIds.add(actor.id);
  }

  const roleIds = new Set<string>();
  for (const role of manifest.governance.roles) {
    if (roleIds.has(role.id)) {
      throw new CompanyConfigError(
        "CONFIG_GOVERNANCE_INVALID",
        `Duplicate governance role ID: '${role.id}'`
      );
    }
    roleIds.add(role.id);

    // Permission safety: V1 manifest roles must only grant supported classes
    for (const perm of role.permissionClasses) {
      if (!SUPPORTED_PERMISSION_CLASSES.has(perm)) {
        throw new CompanyConfigError(
          "CONFIG_GOVERNANCE_INVALID",
          `Role '${role.id}' declares unsupported permission class '${perm}'. Supported classes are 'read_only' and 'write_draft'.`
        );
      }
    }
  }

  for (const binding of manifest.governance.bindings) {
    if (!actorIds.has(binding.actorId)) {
      throw new CompanyConfigError(
        "CONFIG_GOVERNANCE_INVALID",
        `Role binding '${binding.id}' references unknown actor ID: '${binding.actorId}'`
      );
    }
    if (!roleIds.has(binding.roleId)) {
      throw new CompanyConfigError(
        "CONFIG_GOVERNANCE_INVALID",
        `Role binding '${binding.id}' references unknown role ID: '${binding.roleId}'`
      );
    }
  }

  // Integration references for enabled proofs
  const enabledSet = new Set(manifest.enabledProofs);

  if (enabledSet.has("company_research")) {
    if (!manifest.integrations.publicWebProviderRef) {
      throw new CompanyConfigError(
        "CONFIG_BINDING_INVALID",
        "Enabled proof 'company_research' requires integrations.publicWebProviderRef"
      );
    }
  }

  if (enabledSet.has("document_intelligence")) {
    if (!manifest.integrations.documentSourceProviderRef) {
      throw new CompanyConfigError(
        "CONFIG_BINDING_INVALID",
        "Enabled proof 'document_intelligence' requires integrations.documentSourceProviderRef"
      );
    }
  }

  if (enabledSet.has("operational_request")) {
    if (!manifest.integrations.draftRepositoryRef) {
      throw new CompanyConfigError(
        "CONFIG_BINDING_INVALID",
        "Enabled proof 'operational_request' requires integrations.draftRepositoryRef"
      );
    }

    // Operational request requires at least one requester role and one approver role
    const hasRequesterRole = manifest.governance.roles.some((r) =>
      r.permissionClasses.includes("read_only")
    );
    const hasApproverRole = manifest.governance.roles.some((r) =>
      r.permissionClasses.includes("write_draft")
    );

    if (!hasRequesterRole || !hasApproverRole) {
      throw new CompanyConfigError(
        "CONFIG_GOVERNANCE_INVALID",
        "Enabled proof 'operational_request' requires governance roles with 'read_only' (requester) and 'write_draft' (approver)"
      );
    }
  }

  // Freeze defensively
  const frozen = deepFreeze(structuredClone(manifest));
  const configFingerprint = computeCompanyConfigFingerprint(frozen);

  return {
    manifest: frozen,
    configFingerprint,
  };
}
