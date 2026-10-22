import type { PermissionClass, Principal, ResolvedAuthority } from "@aao/contracts";
import type { EnabledProof } from "@aao/config";
import type { PrincipalForRun } from "@aao/framework";
import { resolveAuthority, type GovernanceRegistry } from "@aao/governance";

export class CompanyAdmissionError extends Error {
  readonly code = "COMPANY_ADMISSION_DENIED" as const;
  readonly companyId: string;
  readonly proof: EnabledProof;
  readonly runId: string;
  readonly reasonCode: string;

  constructor(options: {
    companyId: string;
    proof: EnabledProof;
    runId: string;
    reasonCode: string;
    message?: string;
  }) {
    super(
      options.message ??
        `Company admission denied for proof '${options.proof}' in company '${options.companyId}' (reason: ${options.reasonCode})`
    );
    this.name = "CompanyAdmissionError";
    this.companyId = options.companyId;
    this.proof = options.proof;
    this.runId = options.runId;
    this.reasonCode = options.reasonCode;
    Object.setPrototypeOf(this, CompanyAdmissionError.prototype);
  }
}

/**
 * Fixed application-owned preliminary permissions required for company admission.
 * These requirements are constant across companies and cannot be overridden by
 * request payloads, manifests, or model proposals.
 */
export const REQUIRED_ADMISSION_PERMISSIONS: Readonly<
  Record<EnabledProof, readonly PermissionClass[]>
> = Object.freeze({
  company_research: Object.freeze(["read_only"] as const),
  document_intelligence: Object.freeze(["read_only"] as const),
  operational_request: Object.freeze(["write_draft"] as const),
});

export interface RequireCompanyAdmissionContext {
  readonly companyId: string;
  readonly governanceRegistry: GovernanceRegistry;
  readonly principalForRun: PrincipalForRun;
}

/**
 * Deterministic host-side admission gate backed by canonical AAO Governance.
 *
 * Enforces pre-execution company admission before any model reasoning, tool
 * invocation, provider access, approval record creation, or workflow execution begins.
 *
 * Guarantees:
 * 1. Unauthorized principals are rejected before `plan` or any model/tool node.
 * 2. On admission denial, exactly 0 model calls, 0 tool calls, and 0 provider calls occur.
 * 3. Does not replace downstream Tool Runtime authorization or human Approval verification.
 */
export function requireCompanyAdmission(
  context: RequireCompanyAdmissionContext,
  runId: string,
  proof: EnabledProof
): ResolvedAuthority {
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new CompanyAdmissionError({
      companyId: context.companyId,
      proof,
      runId: runId ?? "",
      reasonCode: "GOVERNANCE_INVALID_CONTEXT",
      message: `Invalid runId for company admission check in company '${context.companyId}'`,
    });
  }

  const requiredPermissions = REQUIRED_ADMISSION_PERMISSIONS[proof];
  if (!requiredPermissions) {
    throw new CompanyAdmissionError({
      companyId: context.companyId,
      proof,
      runId,
      reasonCode: "GOVERNANCE_INVALID_CONTEXT",
      message: `Unknown or unconfigured proof '${proof}' for company '${context.companyId}'`,
    });
  }

  // Resolve principal using the trusted host-supplied function
  let principal: Principal;
  try {
    principal = context.principalForRun({ runId });
  } catch {
    throw new CompanyAdmissionError({
      companyId: context.companyId,
      proof,
      runId,
      reasonCode: "GOVERNANCE_INVALID_CONTEXT",
      message: `Failed to resolve host principal for run '${runId}' in company '${context.companyId}'`,
    });
  }

  // Call canonical Governance authority resolver
  const decision = resolveAuthority(
    context.governanceRegistry,
    principal,
    requiredPermissions
  );

  if (decision.decision !== "ALLOW" || !decision.authority) {
    const reasonCode = decision.reasonCodes?.[0] ?? "GOVERNANCE_DEFAULT_DENY";
    throw new CompanyAdmissionError({
      companyId: context.companyId,
      proof,
      runId,
      reasonCode,
      message: `Company admission denied for proof '${proof}' in company '${context.companyId}' (reason: ${reasonCode})`,
    });
  }

  return decision.authority;
}
