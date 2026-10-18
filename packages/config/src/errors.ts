export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export const COMPANY_CONFIG_ERROR_CODES = [
  "CONFIG_INVALID_SCHEMA",
  "CONFIG_UNSUPPORTED_VERSION",
  "CONFIG_DUPLICATE_COMPANY",
  "CONFIG_CAPABILITY_NOT_FOUND",
  "CONFIG_CAPABILITY_INCOMPATIBLE",
  "CONFIG_PROOF_DISABLED",
  "CONFIG_GOVERNANCE_INVALID",
  "CONFIG_BINDING_INVALID",
  "CONFIG_SCOPE_MISMATCH",
] as const;

export type CompanyConfigErrorCode = (typeof COMPANY_CONFIG_ERROR_CODES)[number];

export class CompanyConfigError extends ConfigValidationError {
  readonly code: CompanyConfigErrorCode;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: CompanyConfigErrorCode,
    message: string,
    options?: { path?: string; details?: Record<string, unknown> }
  ) {
    super(`[${code}] ${message}`);
    this.name = "CompanyConfigError";
    this.code = code;
    this.path = options?.path;
    this.details = options?.details ? Object.freeze({ ...options.details }) : undefined;
  }
}
