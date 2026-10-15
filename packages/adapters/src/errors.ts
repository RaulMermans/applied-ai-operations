/**
 * Adapter-contract errors cover declaration, registration, and conformance
 * claims only. Once execution begins, failures stay canonical Runtime,
 * Model, and Tool failures (`NODE_ATTEMPT_TIMEOUT`, `MODEL_INVOCATION_FAILED`,
 * `TOOL_EXECUTION_FAILED`, ...) and are never rewrapped as adapter errors.
 */
export const ADAPTER_CONTRACT_ERROR_CODES = [
  "ADAPTER_MANIFEST_INVALID",
  "ADAPTER_CONTRACT_VERSION_UNSUPPORTED",
  "ADAPTER_DUPLICATE",
  "ADAPTER_NOT_FOUND",
  "ADAPTER_KIND_MISMATCH",
  "ADAPTER_CAPABILITY_UNSUPPORTED",
  "ADAPTER_CONFORMANCE_FAILED",
  "ADAPTER_CONFORMANCE_REPORT_INVALID",
  "ADAPTER_IMPLEMENTATION_INVALID",
] as const;
export type AdapterContractErrorCode = (typeof ADAPTER_CONTRACT_ERROR_CODES)[number];

const MAX_ISSUES = 32;
const MAX_TEXT = 300;
const bound = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

/** A bounded, stackless-in-spirit error: a code, a short message, and bounded issues. Never a provider or SDK cause. */
export class AdapterContractError extends Error {
  readonly code: AdapterContractErrorCode;
  readonly issues: readonly string[];

  constructor(code: AdapterContractErrorCode, message: string, issues: readonly string[] = []) {
    super(`${code}: ${bound(message)}`);
    this.name = "AdapterContractError";
    this.code = code;
    this.issues = Object.freeze(issues.slice(0, MAX_ISSUES).map(bound));
  }
}
