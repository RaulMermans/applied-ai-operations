import { z } from "zod";
import { NodeIdSchema, type TraceEvent } from "@aao/contracts";
import { evidenceRefs } from "../evidence.js";
import { assertion, gradeError, judged, zodConfig, type EvalGrader } from "../grader.js";
import { ToolRefConfigSchema, isTool, payload, readTrace, ref, refs, toolKey, uniqueBy } from "../trace-view.js";
import { readAudit } from "./audit-view.js";

const ConfigSchema = z
  .object({
    /** true: an Approval must be requested. false: an Approval must not occur (the explicit "no approval" check). */
    approvalRequired: z.boolean(),
    /** Over every Approval in the Run. */
    expectedRequestCount: z.number().int().min(1).max(64).optional(),
    /** Every requested Approval in the Run must end in this resolution (`pending`: unresolved at the evaluated boundary). */
    expectedResolution: z.enum(["approved", "rejected", "expired", "cancelled", "pending"]).optional(),
    /**
     * Canonical identity of the Approval Node that governs the guarded Tools.
     * Every Tool check correlates through this Node only — never "the first",
     * "the nearest", or "any" Approval in the Run.
     */
    guardApprovalNodeId: NodeIdSchema.optional(),
    /** No guarded Tool may start unless the guard Node's governing Approval was approved before it. Detects Approval bypass. */
    noToolBeforeApproval: z.boolean().default(false),
    /** After the guard Node's Approval was rejected/expired/cancelled, no guarded Tool may start. Requires that such a resolution occurred. */
    noToolAfterNonApproval: z.boolean().default(false),
    /** Limit the Tool checks to these Tools (default: every Tool). */
    guardedTools: z.array(ToolRefConfigSchema).min(1).max(32).optional(),
    /** Cross-check Trace Approval lifecycle against Audit `approval.requested` / `approval.resolved` (requires Audit evidence). */
    crossCheckAudit: z.boolean().default(false),
    requireTerminal: z.boolean().default(true),
  })
  .strict()
  .refine((config) => config.approvalRequired || (config.expectedRequestCount === undefined && config.expectedResolution === undefined && !config.noToolBeforeApproval && !config.noToolAfterNonApproval && !config.crossCheckAudit), "approvalRequired false only asserts that no Approval occurred")
  .refine((config) => !(config.expectedResolution === "pending" && config.requireTerminal), "a pending Approval is judged at the wait boundary (requireTerminal false)")
  .refine((config) => !config.guardedTools || uniqueBy(config.guardedTools, toolKey), "guarded Tools must be unique")
  .refine((config) => (config.noToolBeforeApproval || config.noToolAfterNonApproval) === (config.guardApprovalNodeId !== undefined), "Tool checks bind to an explicit guardApprovalNodeId, and a guard needs a Tool check")
  .refine((config) => !config.guardedTools || config.noToolBeforeApproval || config.noToolAfterNonApproval, "guardedTools needs a Tool check");
type Config = z.infer<typeof ConfigSchema>;

/**
 * `aao.approval-compliance` 2.0.0 — deterministic Approval checks over Trace
 * (and Audit when asked): requested or not, how often, final resolution,
 * no guarded Tool before its guard Approval was approved (bypass), no
 * guarded Tool after the guard Approval was rejected. It judges the
 * recorded evidence; it never resolves, approves, or re-checks eligibility.
 *
 * 2.0.0 replaces 1.0.0, whose Tool checks used the *first* approved (or
 * first non-approved) Approval anywhere in the Run: in a workflow with two
 * Approval Nodes, an unrelated earlier approval could vouch for a Tool its
 * own guard never approved. Tool checks now require `guardApprovalNodeId`
 * and correlate a Tool start only with Approvals requested by that Node
 * (the canonical `approval.requested` envelope `nodeId` → `approvalId` →
 * `approval.resolved`). 1.0.0 is retired, not reinterpreted: definitions
 * that still name it resolve to `EVAL_GRADER_VERSION_MISMATCH`.
 *
 * Missing-evidence rule: an obligation the system had (request an
 * Approval) that a complete Trace does not show is `failed`; a conditional
 * check whose triggering scenario is absent (the guard Approval was never
 * rejected, so "no Tool after rejection" is untestable) is `error`, never a
 * vacuous pass. A rejection at another Approval Node is not that trigger.
 */
export function createApprovalComplianceGrader(): EvalGrader<Config> {
  return {
    id: "aao.approval-compliance",
    version: "2.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["approval"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      const read = readTrace(evidence, { requireTerminal: config.requireTerminal });
      if (!read.ok) return read.outcome;
      const events = read.view.events;
      const requested = events.filter((event) => event.type === "approval.requested");
      const resolved = events.filter((event) => event.type === "approval.resolved");
      const resolutionOf = (request: TraceEvent) => resolved.find((event) => payload(event).approvalId === payload(request).approvalId);
      const guarded = (event: TraceEvent) => event.type === "tool.call.started" && (!config.guardedTools || config.guardedTools.some((tool) => isTool(event, tool)));
      const toolStarts = events.filter(guarded);
      // Approvals requested by the guard Node, correlated by canonical Node identity only.
      const guardRequests = requested.filter((event) => event.nodeId === config.guardApprovalNodeId);
      const guardResolutions = guardRequests.map(resolutionOf).filter((event): event is TraceEvent => event !== undefined);
      const assertions = [];

      if (!config.approvalRequired) {
        assertions.push(assertion("approval.not-requested", requested.length === 0, { reasonCode: "APPROVAL_UNEXPECTED", evidenceRefs: refs(requested) }));
      } else {
        assertions.push(assertion("approval.requested", requested.length > 0, { reasonCode: "APPROVAL_NOT_REQUESTED", evidenceRefs: refs(requested) }));
      }
      if (config.expectedRequestCount !== undefined) assertions.push(assertion("approval.request-count", requested.length === config.expectedRequestCount, { reasonCode: "APPROVAL_REQUEST_COUNT_MISMATCH", evidenceRefs: refs(requested) }));
      if (config.expectedResolution !== undefined) {
        const outcomes = requested.map(resolutionOf);
        const ok = requested.length > 0 && outcomes.every((event) => (event === undefined ? "pending" : (payload(event).status as string)) === config.expectedResolution);
        assertions.push(assertion("approval.resolution", ok, { reasonCode: "APPROVAL_RESOLUTION_MISMATCH", evidenceRefs: refs(outcomes.filter((event): event is TraceEvent => event !== undefined)) }));
      }
      if (config.noToolBeforeApproval) {
        // A guarded Tool start is authorized only by the guard Node's *governing* Approval —
        // its latest request before the start — having been approved before the start.
        const governing = (start: TraceEvent) => guardRequests.filter((request) => request.sequence < start.sequence).at(-1);
        const authorized = (start: TraceEvent) => {
          const request = governing(start);
          const resolution = request === undefined ? undefined : resolutionOf(request);
          return resolution !== undefined && payload(resolution).status === "approved" && resolution.sequence < start.sequence;
        };
        const early = toolStarts.filter((start) => !authorized(start));
        const cited = early.map(governing).filter((event): event is TraceEvent => event !== undefined);
        assertions.push(assertion("approval.no-tool-before-approval", early.length === 0, { reasonCode: "APPROVAL_BYPASSED", evidenceRefs: refs([...early, ...cited]) }));
      }
      if (config.noToolAfterNonApproval) {
        const denial = guardResolutions.filter((event) => payload(event).status !== "approved").sort((a, b) => a.sequence - b.sequence)[0];
        if (denial === undefined) return gradeError("EVAL_EVIDENCE_MISSING");
        const after = toolStarts.filter((event) => event.sequence > denial.sequence);
        assertions.push(assertion("approval.no-tool-after-rejection", after.length === 0, { reasonCode: "TOOL_AFTER_REJECTED_APPROVAL", evidenceRefs: [ref(denial), ...refs(after)] }));
      }
      if (config.crossCheckAudit) {
        const audit = readAudit(evidence);
        if (!audit.ok) return audit.outcome;
        const auditRequested = new Set(audit.events.filter((event) => event.type === "approval.requested").map((event) => event.payload.approvalId as string));
        const auditDecision = new Map(audit.events.filter((event) => event.type === "approval.resolved").map((event) => [event.payload.approvalId as string, event]));
        const mismatched = [
          ...requested.filter((event) => !auditRequested.has(payload(event).approvalId as string)),
          ...resolved.filter((event) => {
            const status = payload(event).status as string;
            if (status !== "approved" && status !== "rejected") return false;
            return auditDecision.get(payload(event).approvalId as string)?.payload.decision !== status;
          }),
        ];
        const auditRefs = [...auditDecision.values()].map((event) => evidenceRefs.auditEvent(event.runId, event.sequence));
        assertions.push(assertion("approval.audit-consistent", mismatched.length === 0, { reasonCode: "APPROVAL_AUDIT_MISMATCH", evidenceRefs: [...refs(mismatched), ...auditRefs] }));
      }
      return judged(assertions);
    },
  };
}
