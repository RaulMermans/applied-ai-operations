export {
  ConfigValidationError,
  CompanyConfigError,
  COMPANY_CONFIG_ERROR_CODES,
  type CompanyConfigErrorCode,
} from "./errors.js";
export { aaoEnvSchema, logLevelSchema, type AaoEnv, type EnvRecord, type LogLevel } from "./env.js";
export { loadControlPlaneConfig, type ControlPlaneConfig } from "./control-plane.js";
export { loadWorkerConfig, type WorkerConfig } from "./worker.js";

export {
  COMPANY_MANIFEST_SCHEMA_VERSION,
  ENABLED_PROOF_NAMES,
  EnabledProofSchema,
  CompanyModelsConfigSchema,
  CompanyIntegrationsConfigSchema,
  CompanyReliabilityConfigSchema,
  CompanyManifestV1Schema,
  computeCompanyConfigFingerprint,
  deepFreeze,
  type EnabledProof,
  type CompanyModelsConfig,
  type CompanyIntegrationsConfig,
  type CompanyReliabilityConfig,
  type CompanyManifestV1,
} from "./company-manifest.js";

export {
  validateCompanyManifest,
  type ValidatedCompanyManifestResult,
} from "./company-validation.js";
