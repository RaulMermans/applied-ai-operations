/**
 * Forge `bitbucket:mergeCheck` handler for the Sprint 0 feasibility probe.
 * Deterministic and dependency-free. It does not run RollbackProof and must
 * never claim that it did.
 */
export type MergeCheckEvent = {
  workspace?: { uuid?: unknown };
  repository?: { uuid?: unknown };
  pullrequest?: { id?: unknown };
  trigger?: { type?: unknown };
};
export type MergeCheckResponse = { success: boolean; message?: string };

export const KNOWN_TRIGGERS = ["on-code-pushed", "on-reviewer-status-changed", "on-merge"] as const;
export const PROBE_MESSAGE = "RE:VERSE Sprint 0 probe: callback received. RollbackProof has NOT evaluated this pull request.";
export const MALFORMED_MESSAGE = "RE:VERSE Sprint 0 probe: unexpected merge-check payload; failing closed.";

export async function rollbackProofProbe(event: MergeCheckEvent): Promise<MergeCheckResponse> {
  const trigger = event?.trigger?.type;
  const wellFormed =
    typeof event?.pullrequest?.id === "number" &&
    typeof event?.repository?.uuid === "string" &&
    typeof event?.workspace?.uuid === "string" &&
    KNOWN_TRIGGERS.includes(trigger as (typeof KNOWN_TRIGGERS)[number]);
  // Identifiers only (no tokens, no PR content), so a real callback is observable in `forge logs`.
  console.log(JSON.stringify({ probe: "reverse-s0", wellFormed, trigger: String(trigger), pullrequest: event?.pullrequest?.id ?? null }));
  return wellFormed ? { success: true, message: PROBE_MESSAGE } : { success: false, message: MALFORMED_MESSAGE };
}
