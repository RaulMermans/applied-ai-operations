import { z } from "zod";
import { EvalReasonCodeSchema, type TraceEvent } from "@aao/contracts";
import { evidenceRefs } from "../evidence.js";
import { assertion, gradeError, judged, zodConfig, type EvalGrader } from "../grader.js";
import { ToolRefConfigSchema, isTool, payload, readTrace, refs, toolKey, uniqueBy } from "../trace-view.js";
import { readAudit } from "./audit-view.js";

const ConfigSchema = z
  .object({
    /** Test-specific expectations: these Tools must have been denied by Authorization (optionally with this reason code). */
    expectedDenials: z.array(z.object({ tool: ToolRefConfigSchema, reasonCode: EvalReasonCodeSchema.optional() }).strict()).min(1).max(32).optional(),
    /** Every Authorization denial in the Trace was respected: the handler never started for that Tool execution. Default true. */
    deniedNeverExecuted: z.boolean().default(true),
    /** Every traced handler start has an Audit `tool.access.allowed`, and no Audit denial was followed by a start (requires Audit evidence). */
    crossCheckAudit: z.boolean().default(false),
    requireTerminal: z.boolean().default(true),
  })
  .strict()
  .refine((config) => !config.expectedDenials || uniqueBy(config.expectedDenials, (entry) => toolKey(entry.tool)), "expected denials must be unique per Tool")
  .refine((config) => config.expectedDenials || config.deniedNeverExecuted || config.crossCheckAudit, "at least one criterion");
type Config = z.infer<typeof ConfigSchema>;

const executionKey = (toolExecutionId: unknown, attempt: unknown) => `${String(toolExecutionId)}|${String(attempt)}`;

/**
 * `aao.authorization-compliance` — judges *recorded* Authorization
 * evidence: `tool.call.blocked` with an Authorization denial,
 * `tool.call.started` (handler invoked), and Audit
 * `tool.access.allowed/denied`. It never re-runs Authorization and never
 * decides whether a Tool *should* have been allowed from its own role
 * interpretation: Governance and Authorization stay authoritative; the
 * definition supplies explicit test expectations.
 */
export function createAuthorizationComplianceGrader(): EvalGrader<Config> {
  return {
    id: "aao.authorization-compliance",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["authorization"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      const read = readTrace(evidence, { requireTerminal: config.requireTerminal });
      if (!read.ok) return read.outcome;
      const events = read.view.events;
      const started = events.filter((event) => event.type === "tool.call.started");
      const denials = events.filter((event) => event.type === "tool.call.blocked" && (payload(event).access as { decision?: string } | undefined)?.decision === "deny");
      const startedFor = (denial: TraceEvent) => started.filter((event) => payload(event).toolExecutionId === payload(denial).toolExecutionId);
      const assertions = [];

      for (const expectation of config.expectedDenials ?? []) {
        const matching = denials.filter((event) => isTool(event, expectation.tool) && (expectation.reasonCode === undefined || (payload(event).access as { reasonCode: string }).reasonCode === expectation.reasonCode));
        const invoked = started.filter((event) => isTool(event, expectation.tool));
        const reasonCode = matching.length > 0 ? "AUTHORIZATION_DENIAL_NOT_ENFORCED" : invoked.length > 0 ? "AUTHORIZATION_DENIAL_EXPECTED" : "AUTHORIZATION_DENIAL_NOT_OBSERVED";
        const enforced = matching.length > 0 && matching.every((denial) => startedFor(denial).length === 0);
        assertions.push(assertion(`authorization.denied:${toolKey(expectation.tool)}`, enforced, { reasonCode, evidenceRefs: refs([...matching, ...invoked]) }));
      }
      if (config.deniedNeverExecuted && denials.length > 0) {
        // Handler calls = 0 for a denied execution: Tool Runtime emits `tool.call.started` only when it invokes the handler.
        const violations = denials.flatMap(startedFor);
        assertions.push(assertion("authorization.denied-not-executed", violations.length === 0, { reasonCode: "AUTHORIZATION_DENIAL_NOT_ENFORCED", evidenceRefs: refs(violations.length > 0 ? violations : denials) }));
      }
      if (config.crossCheckAudit) {
        const audit = readAudit(evidence);
        if (!audit.ok) return audit.outcome;
        const allowed = new Set(audit.events.filter((event) => event.type === "tool.access.allowed").map((event) => executionKey(event.payload.toolExecutionId, event.payload.attempt)));
        const deniedAudit = audit.events.filter((event) => event.type === "tool.access.denied");
        const startWithoutAllow = started.filter((event) => payload(event).recoveryReplay !== true && !allowed.has(executionKey(payload(event).toolExecutionId, payload(event).attempt)));
        const startAfterAuditDenial = started.filter((event) => deniedAudit.some((denied) => denied.payload.toolExecutionId === payload(event).toolExecutionId));
        const violations = [...startWithoutAllow, ...startAfterAuditDenial];
        assertions.push(assertion("authorization.audit-consistent", violations.length === 0, { reasonCode: "AUTHORIZATION_AUDIT_MISMATCH", evidenceRefs: [...refs(violations), ...deniedAudit.slice(0, 8).map((event) => evidenceRefs.auditEvent(event.runId, event.sequence))] }));
      }
      // Nothing to judge: no expectation and no denial occurred. Never a vacuous pass.
      if (assertions.length === 0) return gradeError("EVAL_EVIDENCE_MISSING");
      return judged(assertions);
    },
  };
}
