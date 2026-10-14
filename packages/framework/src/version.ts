/**
 * The framework-surface contract version (ADR-024). Not the package semver
 * and not the Workflow `schemaVersion`: it changes only when the
 * `@aao/framework` root API changes incompatibly, so intentional breaking
 * changes are visible to consumers.
 */
export const AAO_FRAMEWORK_API_VERSION = 1 as const;
