import {
  isRecord,
  OperationalActionProposalSchema,
  SUPPORTED_OPERATIONS,
  type OperationalActionProposal,
  type OperationalRequest,
} from "./contracts.js";
import { OPERATIONAL_REQUEST_LIMITS as L } from "./limits.js";

const FORBIDDEN_METADATA_KEYS = new Set([
  "permissionClasses",
  "permissions",
  "permission",
  "approved",
  "approvalStatus",
  "approver",
  "toolRef",
  "tool",
  "executionMode",
  "role",
  "roleIds",
  "principal",
]);

// eslint-disable-next-line no-control-regex
const DANGEROUS_PAYLOAD_PATTERN = /<script\b|javascript:|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/i;

export interface ProposalValidationSuccess {
  ok: true;
  proposal: OperationalActionProposal;
}

export interface ProposalValidationFailure {
  ok: false;
  code: string;
  message: string;
}

export type ProposalValidationResult = ProposalValidationSuccess | ProposalValidationFailure;

function hasForbiddenKeys(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) return true;
    const val = (obj as Record<string, unknown>)[key];
    if (val && typeof val === "object" && hasForbiddenKeys(val)) {
      return true;
    }
  }
  return false;
}

/**
 * Deterministically validates an untrusted model action proposal against
 * trusted intake context and AAO operational invariants.
 *
 * Invariants:
 * 1. Operation must be in the strict allowlist ("account.update_display_name").
 * 2. Target accountId must match intake context accountId exactly.
 * 3. Proposed changes can only contain allowed bounded fields (displayName).
 * 4. Display name must be bounded, non-empty, and free of executable code/scripts.
 * 5. Model cannot author or inject permission classes, tools, roles, or approval metadata.
 * 6. The proposal must strictly match the OperationalActionProposal schema.
 */
export function validateOperationalProposal(
  rawProposal: unknown,
  intake: OperationalRequest
): ProposalValidationResult {
  if (!isRecord(rawProposal)) {
    return {
      ok: false,
      code: "PROPOSAL_VALIDATION_FAILED",
      message: "Model proposal is not a valid object.",
    };
  }

  // 1. Guard against model authoring permission, approval, or tool metadata
  if (hasForbiddenKeys(rawProposal)) {
    return {
      ok: false,
      code: "PROPOSAL_FORBIDDEN_METADATA",
      message: "Model proposal attempts to introduce permission, tool, or approval metadata.",
    };
  }

  // 2. Allowlist verification for operation
  const operation = rawProposal.operation;
  if (typeof operation !== "string" || !SUPPORTED_OPERATIONS.includes(operation as never)) {
    return {
      ok: false,
      code: "PROPOSAL_UNSUPPORTED_OPERATION",
      message: `Operation "${String(operation)}" is not in the supported operations allowlist.`,
    };
  }

  // 3. Target account verification against trusted intake context
  const target = rawProposal.target;
  if (!isRecord(target) || typeof target.accountId !== "string") {
    return {
      ok: false,
      code: "PROPOSAL_VALIDATION_FAILED",
      message: "Model proposal target missing accountId.",
    };
  }

  if (target.accountId !== intake.accountContext.accountId) {
    return {
      ok: false,
      code: "PROPOSAL_ACCOUNT_MISMATCH",
      message: `Proposed target accountId "${target.accountId}" does not match intake accountId "${intake.accountContext.accountId}".`,
    };
  }

  // 4. Proposed changes verification
  const changes = rawProposal.changes;
  if (!isRecord(changes)) {
    return {
      ok: false,
      code: "PROPOSAL_UNSUPPORTED_CHANGES",
      message: "Model proposal changes must be a structured object.",
    };
  }

  const changeKeys = Object.keys(changes);
  if (changeKeys.length !== 1 || changeKeys[0] !== "displayName") {
    return {
      ok: false,
      code: "PROPOSAL_UNSUPPORTED_CHANGES",
      message: `Unsupported change fields: ${changeKeys.filter((k) => k !== "displayName").join(", ")}. Only "displayName" is supported.`,
    };
  }

  const displayName = changes.displayName;
  if (typeof displayName !== "string" || displayName.trim().length < L.minDisplayNameLength || displayName.length > L.maxDisplayNameLength) {
    return {
      ok: false,
      code: "PROPOSAL_INVALID_DISPLAY_NAME",
      message: `Display name must be a string between ${L.minDisplayNameLength} and ${L.maxDisplayNameLength} characters.`,
    };
  }

  if (DANGEROUS_PAYLOAD_PATTERN.test(displayName)) {
    return {
      ok: false,
      code: "PROPOSAL_INVALID_DISPLAY_NAME",
      message: "Display name contains disallowed executable or non-printable characters.",
    };
  }

  // 5. Schema validation
  const parsed = OperationalActionProposalSchema.safeParse(rawProposal);
  if (!parsed.success) {
    return {
      ok: false,
      code: "PROPOSAL_VALIDATION_FAILED",
      message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join(", "),
    };
  }

  return { ok: true, proposal: parsed.data };
}
