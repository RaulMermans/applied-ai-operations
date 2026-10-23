export const CAPABILITY_PACK_ERROR_CODES = [
  "PACK_INVALID_MANIFEST",
  "PACK_UNSUPPORTED_VERSION",
  "PACK_DUPLICATE_REF",
  "PACK_NOT_FOUND",
  "PACK_WORKFLOW_MISMATCH",
  "PACK_REQUIREMENT_MISSING",
  "PACK_CAPABILITY_INCOMPATIBLE",
  "PACK_PROOF_DISABLED",
  "PACK_GOVERNANCE_INCOMPATIBLE",
  "PACK_VERIFICATION_PROFILE_MISSING",
  "PACK_SCOPE_MISMATCH",
] as const;

export type CapabilityPackErrorCode = (typeof CAPABILITY_PACK_ERROR_CODES)[number];

export class CapabilityPackError extends Error {
  readonly code: CapabilityPackErrorCode;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: CapabilityPackErrorCode,
    message: string,
    options?: { path?: string; details?: Record<string, unknown> }
  ) {
    super(`[${code}] ${message}`);
    this.name = "CapabilityPackError";
    this.code = code;
    this.path = options?.path;
    this.details = options?.details ? Object.freeze({ ...options.details }) : undefined;
  }
}
