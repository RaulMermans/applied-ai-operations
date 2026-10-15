/**
 * The adapter-contract version (ADR-025). It names the shape and semantics
 * of the public adapter ports, the manifest envelope, the kind taxonomy,
 * and the capability catalog. It is independent of
 * `AAO_FRAMEWORK_API_VERSION`, a Workflow `schemaVersion`, a Tool version,
 * and any adapter package's semver. A manifest declaring any other value is
 * rejected (`ADAPTER_CONTRACT_VERSION_UNSUPPORTED`); there is no
 * best-effort compatibility guessing.
 */
export const AAO_ADAPTER_CONTRACT_VERSION = 1 as const;

/**
 * The version of the canonical conformance suite (scenarios, Eval
 * definitions, dataset, and the claim → outcome rules). A report records
 * the suite version it ran; "AAO conformance v1 PASS" may be claimed only
 * for a report produced by exactly this suite.
 */
export const AAO_ADAPTER_CONFORMANCE_VERSION = 1 as const;
