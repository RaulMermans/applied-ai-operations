export const DETERMINISTIC_REMEDIATION_MAP: Readonly<Record<string, string>> = Object.freeze({
  PACK_REQUIREMENT_MISSING: "Inspect the missing exact Tool, Policy or integration reference.",
  PACK_CAPABILITY_INCOMPATIBLE: "Check the registered model binding and adapter capability declarations.",
  PACK_WORKFLOW_MISMATCH: "Reconcile the Pack's pinned Workflow version/fingerprint with the prepared Workflow.",
  PACK_VERIFICATION_PROFILE_MISSING: "Register the exact required Eval profile and grader dependencies.",
  PACK_EVIDENCE_UNAVAILABLE: "Supply trusted registration evidence before claiming compatibility.",
  PACK_GOVERNANCE_INCOMPATIBLE: "Review canonical role, permission and approver configuration.",
  PACK_PROOF_DISABLED: "Enable the required proof in the company configuration manifest.",
  PACK_DISABLED_BY_COMPANY: "Enable the required capability pack in the company configuration manifest.",
  PACK_DUPLICATE_REF: "Remove conflicting or duplicate registrations in the host environment.",
  PACK_INVALID_MANIFEST: "Inspect the Capability Pack manifest structure and version pinning.",
});

export function getRemediationForCode(code?: string): string {
  if (code && code in DETERMINISTIC_REMEDIATION_MAP) {
    return DETERMINISTIC_REMEDIATION_MAP[code]!;
  }
  return "Inspect host registration evidence and company configuration.";
}

export interface RunDiagnosticDescriptor {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly observed: string;
  readonly explanation: string;
  readonly suggestedCheck: string;
}

export function describeRunFailure(
  reasonCode: string | undefined,
  context: { nodeId?: string; toolRef?: string; modelPolicyRef?: string } = {}
): RunDiagnosticDescriptor {
  const code = reasonCode ?? "EXECUTION_FAILURE";
  const nodePart = context.nodeId ? ` at node '${context.nodeId}'` : "";

  switch (code) {
    case "TOOL_HANDLER_FAILED":
    case "ADAPTER_NOT_FOUND":
      return {
        code,
        severity: "error",
        observed: `Tool execution failed with ${code}${nodePart}.`,
        explanation: "The referenced adapter or tool handler was not available to the execution environment.",
        suggestedCheck: "Inspect the Tool Provider adapter registration and handler bindings.",
      };
    case "PROVIDER_TIMEOUT":
      return {
        code,
        severity: "error",
        observed: `Execution timed out${nodePart}.`,
        explanation: "The integration provider or model adapter did not respond within the configured timeout window.",
        suggestedCheck: "Review provider connectivity, latency, and configured timeout thresholds.",
      };
    case "TOOL_AUTHORIZATION_DENIED":
      return {
        code,
        severity: "error",
        observed: `Tool execution was denied by authorization${nodePart}.`,
        explanation: "The acting principal does not possess the requisite permission class or role authority.",
        suggestedCheck: "Review governance bindings and principal permission assignments.",
      };
    case "NODE_EXECUTION_FAILED":
      return {
        code,
        severity: "error",
        observed: `Workflow node execution failed${nodePart}.`,
        explanation: "The node terminated with an unhandled or fatal execution error.",
        suggestedCheck: "Inspect underlying step attempts and adapter logs for this node.",
      };
    default:
      return {
        code,
        severity: "error",
        observed: `Execution failed with code '${code}'${nodePart}.`,
        explanation: "An error occurred during workflow step execution.",
        suggestedCheck: "Inspect execution event timeline and provider logs.",
      };
  }
}
