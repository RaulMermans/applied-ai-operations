import type {
  ApprovalSummary,
  CapabilityPackSummary,
  CompanySummary,
  EvaluationSummary,
  OverviewInspection,
  PackCompatibilitySummary,
  RunInspection,
  RunSummary,
  WorkflowSummary,
  IntegrationDiagnosticReport,
  AdvancedRunInspection,
  TokenUsageSummary,
} from "./contracts.js";

export function formatCompaniesText(companies: readonly CompanySummary[]): string {
  if (companies.length === 0) {
    return "Companies (0): none available\n";
  }
  const lines: string[] = [`Companies (${companies.length}):`];
  for (const c of companies) {
    lines.push(
      `  - ${c.companyId} (${c.displayName})\n` +
        `    Config Fingerprint: ${c.configurationFingerprint}\n` +
        `    Enabled Proofs (${c.enabledProofs.length}): ${c.enabledProofs.join(", ")}\n` +
        `    Enabled Packs: ${c.enabledPackCount} | Verified Compatible Packs: ${c.verifiedCompatiblePackCount}\n` +
        `    Model Bindings: ${c.modelBindingRefs.join(", ")}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatPacksText(data: {
  readonly packs: readonly CapabilityPackSummary[];
  readonly compatibility: readonly PackCompatibilitySummary[];
}): string {
  const lines: string[] = [`Capability Packs (${data.packs.length}):`];
  for (const p of data.packs) {
    lines.push(
      `  - ${p.identity} (${p.name})\n` +
        `    Category: ${p.category} | Outcome: ${p.outcomeClass}\n` +
        `    Pack Fingerprint: ${p.packFingerprint}\n` +
        `    Workflow: ${p.workflow.id}@${p.workflow.version} (plan: ${p.workflow.planFingerprint})\n` +
        `    Tools (${p.requirements.toolRefs.length}): ${p.requirements.toolRefs.map((t) => `${t.id}@${t.version}`).join(", ")}\n` +
        `    Model Policies: ${p.requirements.modelPolicyRefs.join(", ")}\n` +
        `    Model Capabilities: ${p.requirements.modelCapabilities.join(", ")}\n` +
        `    Approval Required: ${p.requirements.approval.required ? `yes (${(p.requirements.approval.requiredRoleIds ?? []).join(", ")})` : "no"}\n` +
        `    Eval Profile: ${p.evalProfileRef}`
    );
  }
  if (data.compatibility.length > 0) {
    lines.push("");
    lines.push(`Verified Pack Compatibility (${data.compatibility.length}):`);
    for (const c of data.compatibility) {
      const detail = c.reasonCode ? ` [${c.reasonCode}]` : "";
      lines.push(
        `  - ${c.companyId} x ${c.packIdentity}: ${c.status} (verified=${c.verified})${detail}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatWorkflowsText(workflows: readonly WorkflowSummary[]): string {
  if (workflows.length === 0) {
    return "Workflows (0): none available\n";
  }
  const lines: string[] = [`Workflows (${workflows.length}):`];
  for (const w of workflows) {
    lines.push(
      `  - ${w.workflowId}@${w.version} (${w.name})\n` +
        `    Plan Fingerprint: ${w.planFingerprint}\n` +
        `    Nodes (${w.nodeCount}): entry=${w.entryNodeId}, terminal=[${w.terminalNodeIds.join(", ")}]\n` +
        `    Node Kinds: ${w.nodeKinds.join(", ")}\n` +
        `    Tool Refs: ${w.toolRefs.length > 0 ? w.toolRefs.join(", ") : "none"}\n` +
        `    Model Policies: ${w.modelPolicyRefs.length > 0 ? w.modelPolicyRefs.join(", ") : "none"}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatRunsText(runs: readonly RunSummary[]): string {
  if (runs.length === 0) {
    return "Known Runs (0): none available\n";
  }
  const lines: string[] = [`Known Runs (${runs.length}):`];
  for (const r of runs) {
    const companyPart = r.companyId ? ` company=${r.companyId}` : "";
    const reasonPart = r.statusReason ? ` (${r.statusReason})` : "";
    const evalPart = r.evaluationStatus ? ` eval=${r.evaluationStatus}` : "";
    lines.push(
      `  - ${r.runId}: status=${r.status}${reasonPart} [source=${r.statusSource}]${companyPart} workflow=${r.workflowId}@${r.workflowVersion} trace=${r.traceHealth} (events=${r.traceEventCount ?? 0})${evalPart}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatRunInspectionText(inspection: RunInspection): string {
  const s = inspection.summary;
  const lines: string[] = [
    `Run Inspection: ${s.runId}`,
    `  Status: ${s.status}${s.statusReason ? ` (${s.statusReason})` : ""} [source=${s.statusSource}]`,
    `  Workflow: ${s.workflowId}@${s.workflowVersion}${s.companyId ? ` | Company: ${s.companyId}` : ""}${s.packIdentity ? ` | Pack: ${s.packIdentity}` : ""}`,
    `  Trace Health: ${inspection.trace.health} (events=${inspection.trace.returnedEventCount}/${inspection.trace.eventCount}, truncated=${inspection.trace.truncated})`,
  ];

  if (inspection.approvals.length > 0) {
    lines.push(`  Approvals (${inspection.approvals.length}):`);
    for (const a of inspection.approvals) {
      lines.push(
        `    - ${a.approvalId}: status=${a.status} node=${a.nodeId} requestedBy=${a.requestedBy.id} roles=[${a.requiredApproverRoleIds.join(", ")}]${a.resolvedBy ? ` resolvedBy=${a.resolvedBy.id}` : ""}`
      );
    }
  } else {
    lines.push("  Approvals (0): none");
  }

  if (inspection.evaluations.length > 0) {
    lines.push(`  Evaluations (${inspection.evaluations.length}):`);
    for (const e of inspection.evaluations) {
      lines.push(
        `    - ${e.evalProfileRef}: status=${e.status} executed=${e.executed}${e.totalCases !== undefined ? ` cases=${e.passedCases}/${e.totalCases}` : ""}`
      );
    }
  } else {
    lines.push("  Evaluations (0): none");
  }

  if (inspection.trace.events.length > 0) {
    lines.push(`  Trace Timeline (${inspection.trace.events.length}):`);
    for (const ev of inspection.trace.events) {
      const nodeStr = ev.nodeId ? ` node=${ev.nodeId}` : "";
      const statusStr = ev.status ? ` status=${ev.status}` : "";
      const codeStr = ev.reasonCode ? ` code=${ev.reasonCode}` : "";
      lines.push(`    [${ev.sequence}] ${ev.type}${nodeStr}${statusStr}${codeStr}`);
    }
  }

  if (inspection.diagnostics.length > 0) {
    lines.push(`  Diagnostics (${inspection.diagnostics.length}):`);
    for (const d of inspection.diagnostics) {
      lines.push(`    ! ${d}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatEvaluationsText(evals: readonly EvaluationSummary[]): string {
  if (evals.length === 0) {
    return "Evaluations (0): none available\n";
  }
  const lines: string[] = [`Evaluations (${evals.length}):`];
  for (const e of evals) {
    const casesStr =
      e.executed && e.totalCases !== undefined
        ? ` cases=${e.passedCases}/${e.totalCases} (passRate=${((e.passRate ?? 0) * 100).toFixed(0)}%)`
        : " (not executed)";
    const runStr = e.runId ? ` run=${e.runId}` : "";
    const companyStr = e.companyId ? ` company=${e.companyId}` : "";
    const baselineStr = e.baselineComparisonStatus
      ? ` baseline=${e.baselineComparisonStatus}`
      : "";
    lines.push(
      `  - ${e.evalProfileRef}: status=${e.status}${casesStr}${companyStr}${runStr}${baselineStr}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatApprovalsText(approvals: readonly ApprovalSummary[]): string {
  if (approvals.length === 0) {
    return "Approvals (0): none available\n";
  }
  const lines: string[] = [`Approvals (${approvals.length}):`];
  for (const a of approvals) {
    lines.push(
      `  - ${a.approvalId}: status=${a.status} run=${a.runId} node=${a.nodeId} requestedBy=${a.requestedBy.id}${a.resolvedBy ? ` resolvedBy=${a.resolvedBy.id}` : ""} fingerprint=${a.requestFingerprint.slice(0, 16)}...`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatOverviewText(overview: OverviewInspection): string {
  const c = overview.counts;
  const p = overview.provenance;
  const lines: string[] = [
    "AAO Operator Inspection",
    `Source: ${p?.label ?? "DEMO DATA — NOT LIVE OPERATIONS"}`,
    "",
    "AAO Operator Control Center Overview (Read-Only)",
    `  Companies: ${c.companies ?? "UNAVAILABLE"}`,
    `  Capability Packs: ${c.capabilityPacks ?? "UNAVAILABLE"}`,
    `  Compatibility Matrix: compatible=${c.compatiblePackBindings ?? "N/A"}, incompatible=${c.incompatiblePackBindings ?? "N/A"}, not_verified=${c.unverifiedPackBindings ?? "N/A"}`,
    `  Workflows: ${c.workflows ?? "UNAVAILABLE"}`,
    `  Known Runs: ${c.knownRuns ?? "UNAVAILABLE"}`,
    `  Known Approvals: ${c.knownApprovals ?? "UNAVAILABLE"}`,
    `  Known Evaluations: ${c.knownEvaluations ?? "UNAVAILABLE"}`,
    "  Source Health:",
  ];
  for (const src of overview.sources) {
    lines.push(
      `    - ${src.sourceId}: ${src.status}${src.reasonCode ? ` (${src.reasonCode})` : ""}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatIntegrationDiagnosticsText(report: IntegrationDiagnosticReport): string {
  const lines: string[] = [
    `Integration Diagnostics: ${report.companyDisplayName ?? report.companyId} x ${report.packIdentity}`,
    `  Workflow: ${report.workflowId}@${report.workflowVersion} (plan: ${report.planFingerprint.slice(0, 16)}...)`,
    `  Overall Readiness: ${report.status}${report.reasonCode ? ` [${report.reasonCode}]` : ""}`,
    "",
    `  Requirements Checklist (${report.requirements.length}):`,
  ];

  for (const req of report.requirements) {
    const diagPart = req.diagnostic ? ` — ${req.diagnostic}` : "";
    lines.push(`    [${req.status}] ${req.category}: ${req.name}${diagPart}`);
  }

  if (report.diagnostics.length > 0) {
    lines.push("");
    lines.push(`  Diagnostics (${report.diagnostics.length}):`);
    for (const d of report.diagnostics) {
      lines.push(`    ! [${d.code}] ${d.message}`);
    }
  }

  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("  Next Steps:");
    for (const step of report.nextSteps) {
      lines.push(`    - ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** "Not recorded" for an unknown value: an unknown token count is never shown as 0. */
const known = (value: number | undefined) => (value === undefined ? "not recorded" : String(value));

/**
 * One shared rendering of token accounting for CLI and UI. Partial accounting is
 * labelled as known recorded totals, never as the full execution total.
 */
export function formatTokenUsageText(usage: TokenUsageSummary | undefined): string {
  if (!usage) return "UNAVAILABLE (no valid Trace evidence)";
  if (usage.modelInvocations === 0) return "COMPLETE (0 model invocations)";
  const calls = `${usage.callsWithUsage}/${usage.modelInvocations} invocations with usage`;
  if (usage.status === "complete") {
    return `COMPLETE (input=${known(usage.inputTokens)}, output=${known(usage.outputTokens)}, total=${known(usage.totalTokens)}; ${calls})`;
  }
  if (usage.status === "unavailable") return `NOT RECORDED (${calls})`;
  return `PARTIAL (known recorded totals: input=${usage.knownInputTokens}, output=${usage.knownOutputTokens}, total=${usage.knownTotalTokens}; ${calls})`;
}

/** One shared rendering of the execution counters for CLI and UI. */
export function executionCounterRows(inspection: AdvancedRunInspection): ReadonlyArray<readonly [string, string]> {
  const c = inspection.counters;
  const v = (n: number | undefined) => (n === undefined ? "unavailable" : String(n));
  return [
    ["Trace Events", String(inspection.eventCount)],
    ["Node Execution Occurrences", v(c?.nodeExecutionOccurrences)],
    ["Node Attempts", v(c?.nodeAttempts)],
    ["Recovery Replays", v(c?.recoveryReplayAttempts)],
    ["Scheduled Retries", v(c?.scheduledRetries)],
    ["Exhausted Retries", v(c?.exhaustedRetries)],
    ["Tool Physical Invocations", v(c?.toolPhysicalInvocations)],
    ["Tool Logical Executions", v(c?.toolLogicalExecutions)],
    ["Tool Calls Blocked", v(c?.toolBlocked)],
    ["Model Invocations", v(c?.modelInvocations)],
    ["Token Accounting", formatTokenUsageText(inspection.tokenUsage)],
  ];
}

function headerLines(inspection: AdvancedRunInspection, title: string): string[] {
  return [
    `${title}: ${inspection.runId}`,
    `  Workflow: ${inspection.workflowId}@${inspection.workflowVersion} | Status: ${inspection.authoritativeStatus} [${inspection.statusSource}]`,
    `  Trace Health: ${inspection.evidenceHealth}`,
    ...executionCounterRows(inspection).map(([label, value]) => `  ${label}: ${value}`),
  ];
}

function diagnosticLines(inspection: AdvancedRunInspection): string[] {
  const lines: string[] = [];
  if (inspection.unattributedEvents.length > 0) {
    lines.push("", `  Unattributed Evidence (${inspection.unattributedEvents.length}):`);
    for (const e of inspection.unattributedEvents) lines.push(`    ? [seq=${e.sequence}] ${e.type}${e.nodeId ? ` [node=${e.nodeId}]` : ""}`);
  }
  if (inspection.diagnostics.length > 0) {
    lines.push("", `  Diagnostics (${inspection.diagnostics.length}):`);
    for (const d of inspection.diagnostics) {
      lines.push(`    ! [${d.code}] ${d.observed}`);
      lines.push(`      Explanation: ${d.explanation}`);
      lines.push(`      Suggested check: ${d.suggestedCheck}`);
    }
  }
  return lines;
}

export function formatAdvancedRunInspectionNodesText(inspection: AdvancedRunInspection): string {
  const lines: string[] = [...headerLines(inspection, "Run Node Execution"), "", `  Nodes (${inspection.nodes.length}):`];
  for (const n of inspection.nodes) {
    const detailParts: string[] = [`kind=${n.nodeKind}`];
    if (n.executed) {
      detailParts.push(`executions=${n.executionCount}`, `attempts=${n.attemptCount}`);
      if (n.scheduledRetries > 0) detailParts.push(`retries=${n.scheduledRetries}`);
      if (n.recoveryReplayCount > 0) detailParts.push(`replays=${n.recoveryReplayCount}`);
    }
    if (n.toolRef) detailParts.push(`tool=${n.toolRef}`);
    if (n.modelPolicyRef) detailParts.push(`policy=${n.modelPolicyRef}`);
    if (n.approvalId) detailParts.push(`approval=${n.approvalId}${n.approvalStatus ? ` (${n.approvalStatus})` : ""}`);
    if (n.tokenUsage) detailParts.push(`tokens=${formatTokenUsageText(n.tokenUsage)}`);
    lines.push(`    - [${n.status}] ${n.nodeId} (${detailParts.join(", ")})`);
  }
  lines.push(...diagnosticLines(inspection));
  return `${lines.join("\n")}\n`;
}

export function formatAdvancedRunInspectionTimelineText(inspection: AdvancedRunInspection): string {
  const lines: string[] = [
    ...headerLines(inspection, "Run Execution Timeline"),
    "",
    `  Node Attempts (${inspection.attempts.length}${inspection.attemptsTruncated ? ", truncated" : ""}):`,
  ];
  for (const a of inspection.attempts) {
    const parts = [`step=${a.step}`, `attempt=${a.attempt}`, `span=${a.spanId}`];
    if (a.toolPhysicalInvocations > 0) parts.push(`tool invocations=${a.toolPhysicalInvocations}`);
    if (a.modelInvocations > 0) parts.push(`model invocations=${a.modelInvocations}`);
    if (a.tokenUsage) parts.push(`tokens=${formatTokenUsageText(a.tokenUsage)}`);
    if (a.reasonCode) parts.push(`code=${a.reasonCode}`);
    const replayPart = a.recoveryReplay ? " (recovery replay)" : "";
    lines.push(`    [${a.startedAt}] ${a.nodeId} ${a.kind}: ${a.status}${replayPart} (${parts.join(", ")})`);
  }
  lines.push(...diagnosticLines(inspection));
  return `${lines.join("\n")}\n`;
}
