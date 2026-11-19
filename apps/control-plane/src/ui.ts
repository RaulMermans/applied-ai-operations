import {
  executionCounterRows,
  formatTokenUsageText,
  type AdvancedRunInspection,
  type IntegrationDiagnosticReport,
  type OperatorSourceProvenance,
  type OverviewInspection,
  type RunInspection,
} from "@aao/operator-inspection";

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderControlCenterHtml(
  overview: OverviewInspection,
  initialRunDetail?: RunInspection
): string {
  const sourceRows = overview.sources
    .map(
      (s) =>
        `<tr>
          <td><code>${escapeHtml(s.sourceId)}</code></td>
          <td><span class="badge status-${escapeHtml(s.status)}">${escapeHtml(s.status.toUpperCase())}</span></td>
          <td>${s.reasonCode ? `<code>${escapeHtml(s.reasonCode)}</code>` : "—"}</td>
          <td>${s.diagnostic ? escapeHtml(s.diagnostic) : "Healthy read-only projection"}</td>
        </tr>`
    )
    .join("\n");

  const companyRows =
    overview.companies.length === 0
      ? `<tr><td colspan="6" class="empty-state">No companies available from inspection source.</td></tr>`
      : overview.companies
          .map(
            (c) =>
              `<tr data-company-id="${escapeHtml(c.companyId)}">
                <td><code>${escapeHtml(c.companyId)}</code></td>
                <td>${escapeHtml(c.displayName)}</td>
                <td><code title="${escapeHtml(c.configurationFingerprint)}">${escapeHtml(c.configurationFingerprint.slice(0, 16))}…</code></td>
                <td>${escapeHtml(c.enabledProofs.join(", "))}</td>
                <td>${c.enabledPackCount} (verified: ${c.verifiedCompatiblePackCount})</td>
                <td><code>${escapeHtml(c.modelBindingRefs.join(", "))}</code></td>
              </tr>`
          )
          .join("\n");

  const packRows =
    overview.capabilityPacks.length === 0
      ? `<tr><td colspan="7" class="empty-state">No capability packs available from inspection source.</td></tr>`
      : overview.capabilityPacks
          .map(
            (p) =>
              `<tr data-pack-identity="${escapeHtml(p.identity)}">
                <td><code>${escapeHtml(p.identity)}</code></td>
                <td>${escapeHtml(p.name)}</td>
                <td><code>${escapeHtml(p.outcomeClass)}</code></td>
                <td><code>${escapeHtml(p.workflow.id)}@${escapeHtml(p.workflow.version)}</code><br/><small>plan: <code>${escapeHtml(p.workflow.planFingerprint.slice(0, 16))}…</code></small></td>
                <td><code>${escapeHtml(p.requirements.toolRefs.map((t) => `${t.id}@${t.version}`).join(", "))}</code></td>
                <td>${p.requirements.approval.required ? `Required (${escapeHtml((p.requirements.approval.requiredRoleIds ?? []).join(", "))})` : "Not required"}</td>
                <td><code>${escapeHtml(p.evalProfileRef)}</code></td>
              </tr>`
          )
          .join("\n");

  const compatibilityRows =
    overview.compatibility.length === 0
      ? `<tr><td colspan="6" class="empty-state">Compatibility matrix unavailable.</td></tr>`
      : overview.compatibility
          .map(
            (c) =>
              `<tr data-compat-company="${escapeHtml(c.companyId)}" data-compat-pack="${escapeHtml(c.packIdentity)}">
                <td><a href="/control-center/companies/${encodeURIComponent(c.companyId)}/packs/${encodeURIComponent(c.packIdentity)}"><code>${escapeHtml(c.companyId)}</code></a></td>
                <td><a href="/control-center/companies/${encodeURIComponent(c.companyId)}/packs/${encodeURIComponent(c.packIdentity)}"><code>${escapeHtml(c.packIdentity)}</code></a></td>
                <td><span class="badge compat-${escapeHtml(c.status.toLowerCase())}">${escapeHtml(c.status)}</span></td>
                <td>${c.verified ? "Yes (Registration Snapshot)" : "No"}</td>
                <td>${c.reasonCode ? `<code>${escapeHtml(c.reasonCode)}</code>` : "—"}</td>
                <td>${
                  c.verifiedRequirements
                    ? `tools=${c.verifiedRequirements.tools}, policies=${c.verifiedRequirements.modelPolicies}, modelCaps=${c.verifiedRequirements.modelCapabilities}, integrations=${c.verifiedRequirements.integrations}, evals=${c.verifiedRequirements.evalProfiles}`
                    : c.diagnostic
                      ? escapeHtml(c.diagnostic)
                      : "—"
                }</td>
              </tr>`
          )
          .join("\n");

  const workflowRows =
    overview.workflows.length === 0
      ? `<tr><td colspan="6" class="empty-state">No workflows available from inspection source.</td></tr>`
      : overview.workflows
          .map(
            (w) =>
              `<tr data-workflow-id="${escapeHtml(w.workflowId)}">
                <td><code>${escapeHtml(w.workflowId)}@${escapeHtml(w.version)}</code></td>
                <td>${escapeHtml(w.name)}</td>
                <td><code title="${escapeHtml(w.planFingerprint)}">${escapeHtml(w.planFingerprint.slice(0, 16))}…</code></td>
                <td>${w.nodeCount} (entry: <code>${escapeHtml(w.entryNodeId)}</code> → terminal: <code>${escapeHtml(w.terminalNodeIds.join(", "))}</code>)</td>
                <td><code>${escapeHtml(w.nodeIds.join(" → "))}</code></td>
                <td>Tools: <code>${escapeHtml(w.toolRefs.join(", ") || "none")}</code><br/>Policies: <code>${escapeHtml(w.modelPolicyRefs.join(", ") || "none")}</code></td>
              </tr>`
          )
          .join("\n");

  const runRows =
    overview.recentRuns.length === 0
      ? `<tr><td colspan="7" class="empty-state">No known runs available from inspection source.</td></tr>`
      : overview.recentRuns
          .map(
            (r) =>
              `<tr data-run-id="${escapeHtml(r.runId)}">
                <td><a href="/control-center/runs/${encodeURIComponent(r.runId)}"><code>${escapeHtml(r.runId)}</code></a></td>
                <td><span class="badge run-${escapeHtml(r.status.toLowerCase())}">${escapeHtml(r.status)}</span>${r.statusReason ? `<br/><small><code>${escapeHtml(r.statusReason)}</code></small>` : ""}</td>
                <td><code>${escapeHtml(r.statusSource)}</code></td>
                <td><code>${escapeHtml(r.companyId ?? "—")}</code></td>
                <td><code>${escapeHtml(r.workflowId)}@${escapeHtml(r.workflowVersion)}</code></td>
                <td><span class="badge trace-${escapeHtml(r.traceHealth)}">${escapeHtml(r.traceHealth)}</span> (${r.traceEventCount ?? 0} events)</td>
                <td>${r.evaluationStatus ? `<span class="badge eval-${escapeHtml(r.evaluationStatus.toLowerCase())}">${escapeHtml(r.evaluationStatus)}</span>` : "—"}</td>
              </tr>`
          )
          .join("\n");

  const approvalRows =
    overview.approvals.length === 0
      ? `<tr><td colspan="6" class="empty-state">No known approval records available.</td></tr>`
      : overview.approvals
          .map(
            (a) =>
              `<tr data-approval-id="${escapeHtml(a.approvalId)}">
                <td><code>${escapeHtml(a.approvalId)}</code></td>
                <td><span class="badge approval-${escapeHtml(a.status)}">${escapeHtml(a.status.toUpperCase())}</span></td>
                <td><code>${escapeHtml(a.runId)}</code> (node: <code>${escapeHtml(a.nodeId)}</code>)</td>
                <td><code>${escapeHtml(a.requestedBy.id)}</code></td>
                <td><code>${escapeHtml(a.requiredApproverRoleIds.join(", "))}</code></td>
                <td>${a.resolvedBy ? `<code>${escapeHtml(a.resolvedBy.id)}</code> (${escapeHtml(a.resolvedAt ?? "")})` : "Pending human decision"}</td>
              </tr>`
          )
          .join("\n");

  const evaluationRows =
    overview.evaluations.length === 0
      ? `<tr><td colspan="6" class="empty-state">No evaluation records available.</td></tr>`
      : overview.evaluations
          .map(
            (e) =>
              `<tr data-eval-profile="${escapeHtml(e.evalProfileRef)}">
                <td><code>${escapeHtml(e.evalProfileRef)}</code></td>
                <td><span class="badge eval-${escapeHtml(e.status.toLowerCase())}">${escapeHtml(e.status)}</span></td>
                <td>${e.executed ? "Executed Report" : "Registered Profile Only (Not Run)"}</td>
                <td>${e.executed && e.totalCases !== undefined ? `${e.passedCases}/${e.totalCases} (${((e.passRate ?? 0) * 100).toFixed(0)}%)` : "—"}</td>
                <td><code>${escapeHtml(e.companyId ?? "—")}</code> / <code>${escapeHtml(e.runId ?? "—")}</code></td>
                <td>${e.baselineComparisonStatus ? `<code>${escapeHtml(e.baselineComparisonStatus)}</code>` : "—"}</td>
              </tr>`
          )
          .join("\n");

  const runDetailSection = initialRunDetail
    ? `<div id="run-detail-container" data-inspected-run="${escapeHtml(initialRunDetail.summary.runId)}">
        <h3>Run Detail Inspection: <code>${escapeHtml(initialRunDetail.summary.runId)}</code></h3>
        <p>
          <strong>Authoritative Status:</strong> <span class="badge run-${escapeHtml(initialRunDetail.summary.status.toLowerCase())}">${escapeHtml(initialRunDetail.summary.status)}</span>
          (source: <code>${escapeHtml(initialRunDetail.summary.statusSource)}</code>) |
          <strong>Trace Health:</strong> <code>${escapeHtml(initialRunDetail.trace.health)}</code> (${initialRunDetail.trace.returnedEventCount}/${initialRunDetail.trace.eventCount} events)
        </p>
        ${
          initialRunDetail.diagnostics.length > 0
            ? `<div class="diagnostics-box"><strong>Diagnostics:</strong><ul>${initialRunDetail.diagnostics.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul></div>`
            : ""
        }
        <table>
          <thead>
            <tr><th>Seq</th><th>Event Type</th><th>Node</th><th>Status</th><th>Reason / Details</th></tr>
          </thead>
          <tbody>
            ${initialRunDetail.trace.events
              .map(
                (ev) =>
                  `<tr>
                    <td>${ev.sequence}</td>
                    <td><code>${escapeHtml(ev.type)}</code></td>
                    <td><code>${escapeHtml(ev.nodeId ?? "—")}</code></td>
                    <td><code>${escapeHtml(ev.status ?? "—")}</code></td>
                    <td><code>${escapeHtml(ev.reasonCode ?? ev.toolRef ?? ev.modelPolicyRef ?? ev.approvalId ?? "—")}</code></td>
                  </tr>`
              )
              .join("\n")}
          </tbody>
        </table>
      </div>`
    : `<div id="run-detail-container" class="empty-state">Select a known Run to inspect its chronological Trace, Approval records, and Evaluation results.</div>`;

  const counts = overview.counts;
  const formatCount = (n: number | null) => (n === null ? "UNAVAILABLE" : String(n));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AAO Control Center — Read-Only Operator Inspection Surface</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body {
      margin: 0;
      padding: 24px;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.45;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .header-badges {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: flex-end;
    }
    .demo-banner {
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #fde68a;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 0.85rem;
      letter-spacing: 0.02em;
    }
    .readonly-banner {
      background: #e0f2fe;
      color: #0369a1;
      border: 1px solid #bae6fd;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.85rem;
    }
    nav {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
    }
    nav a {
      text-decoration: none;
      color: #1e293b;
      background: #e2e8f0;
      padding: 6px 14px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.9rem;
    }
    section {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    h1, h2, h3 {
      margin-top: 0;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .metric-card {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 12px;
    }
    .metric-card .label {
      font-size: 0.8rem;
      color: #475569;
      text-transform: uppercase;
    }
    .metric-card .value {
      font-size: 1.4rem;
      font-weight: 700;
      margin-top: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 0.9rem;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: top;
    }
    th {
      background: #f8fafc;
      font-weight: 600;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.78rem;
      font-weight: 600;
      background: #e2e8f0;
    }
    .compat-compatible, .run-completed, .eval-passed, .status-available, .approval-approved, .readiness-ready, .readiness-satisfied, .node-observed_completed {
      background: #dcfce7;
      color: #166534;
    }
    .compat-not_verified, .run-waiting, .eval-registered, .eval-not_run, .status-degraded, .approval-pending, .readiness-not_verified, .node-observed_started, .node-evidence_incomplete {
      background: #fef9c3;
      color: #854d0e;
    }
    .compat-incompatible, .run-failed, .eval-failed, .status-invalid, .trace-corrupt, .approval-rejected, .readiness-blocked, .readiness-missing, .readiness-incompatible, .node-observed_failed {
      background: #fee2e2;
      color: #991b1b;
    }
    .run-unknown, .compat-unavailable, .status-unavailable, .trace-unavailable, .readiness-unavailable, .node-not_observed {
      background: #f1f5f9;
      color: #475569;
    }
    .empty-state {
      color: #64748b;
      font-style: italic;
      padding: 12px;
    }
    .diagnostics-box {
      background: #fffbeb;
      border: 1px solid #fde68a;
      padding: 10px 14px;
      border-radius: 6px;
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>AAO Control Center</h1>
      <p>Operator Inspection Surface &amp; Control Center Foundation (Sprint 27)</p>
    </div>
    <div class="header-badges">
      ${overview.provenance?.mode !== "live" ? `<div class="demo-banner" data-demo-indicator="true">DEMO DATA — NOT LIVE OPERATIONS</div>` : ""}
      <div class="readonly-banner" data-readonly-indicator="true">
        READ-ONLY SURFACE • ZERO EXECUTION OR APPROVAL MUTATION AUTHORITY
      </div>
    </div>
  </header>

  <nav aria-label="Control Center Views">
    <a href="#view-overview">View 1: Overview</a>
    <a href="#view-companies-packs">View 2: Companies &amp; Capability Packs</a>
    <a href="#view-workflows-runs">View 3: Workflows &amp; Runs</a>
  </nav>

  <!-- VIEW 1: OVERVIEW -->
  <section id="view-overview" data-view="overview">
    <h2>View 1 — Operational Overview &amp; Source Health</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="label">Companies</div>
        <div class="value" data-count="companies">${escapeHtml(formatCount(counts.companies))}</div>
      </div>
      <div class="metric-card">
        <div class="label">Capability Packs</div>
        <div class="value" data-count="capabilityPacks">${escapeHtml(formatCount(counts.capabilityPacks))}</div>
      </div>
      <div class="metric-card">
        <div class="label">Verified Compatible Bindings</div>
        <div class="value" data-count="compatiblePackBindings">${escapeHtml(formatCount(counts.compatiblePackBindings))}</div>
      </div>
      <div class="metric-card">
        <div class="label">Unverified / Incompatible</div>
        <div class="value" data-count="unverifiedOrIncompatible">${escapeHtml(formatCount(counts.unverifiedPackBindings))} / ${escapeHtml(formatCount(counts.incompatiblePackBindings))}</div>
      </div>
      <div class="metric-card">
        <div class="label">Workflows</div>
        <div class="value" data-count="workflows">${escapeHtml(formatCount(counts.workflows))}</div>
      </div>
      <div class="metric-card">
        <div class="label">Known Runs</div>
        <div class="value" data-count="knownRuns">${escapeHtml(formatCount(counts.knownRuns))}</div>
      </div>
      <div class="metric-card">
        <div class="label">Known Approvals</div>
        <div class="value" data-count="knownApprovals">${escapeHtml(formatCount(counts.knownApprovals))}</div>
      </div>
      <div class="metric-card">
        <div class="label">Known Evaluations</div>
        <div class="value" data-count="knownEvaluations">${escapeHtml(formatCount(counts.knownEvaluations))}</div>
      </div>
    </div>

    <h3>Inspection Source Statuses</h3>
    <table>
      <thead>
        <tr><th>Source</th><th>Availability</th><th>Reason Code</th><th>Diagnostic</th></tr>
      </thead>
      <tbody>
        ${sourceRows}
      </tbody>
    </table>
  </section>

  <!-- VIEW 2: COMPANIES & CAPABILITY PACKS -->
  <section id="view-companies-packs" data-view="companies-packs">
    <h2>View 2 — Companies, Capability Packs &amp; Verified Compatibility</h2>

    <h3>Configured Companies</h3>
    <table>
      <thead>
        <tr>
          <th>Company ID</th>
          <th>Display Name</th>
          <th>Config Fingerprint</th>
          <th>Enabled Proofs</th>
          <th>Packs (Enabled / Verified)</th>
          <th>Model Bindings</th>
        </tr>
      </thead>
      <tbody>
        ${companyRows}
      </tbody>
    </table>

    <h3>Versioned Capability Packs Catalog</h3>
    <table>
      <thead>
        <tr>
          <th>Pack Identity</th>
          <th>Name</th>
          <th>Outcome Class</th>
          <th>Pinned Workflow</th>
          <th>Required Tools</th>
          <th>Approval Gate</th>
          <th>Eval Profile</th>
        </tr>
      </thead>
      <tbody>
        ${packRows}
      </tbody>
    </table>

    <h3>Verified Pack Compatibility Matrix (Registration Snapshot Evidence)</h3>
    <table>
      <thead>
        <tr>
          <th>Company</th>
          <th>Capability Pack</th>
          <th>Compatibility Status</th>
          <th>Evidence Verified</th>
          <th>Reason Code</th>
          <th>Verified Requirements / Diagnostic</th>
        </tr>
      </thead>
      <tbody>
        ${compatibilityRows}
      </tbody>
    </table>
  </section>

  <!-- VIEW 3: WORKFLOWS & RUNS -->
  <section id="view-workflows-runs" data-view="workflows-runs">
    <h2>View 3 — Workflow Definitions, Known Runs, Approvals &amp; Evaluations</h2>

    <h3>Canonical Compiled Workflows</h3>
    <table>
      <thead>
        <tr>
          <th>Workflow Identity</th>
          <th>Name</th>
          <th>Plan Fingerprint</th>
          <th>Graph Bounds</th>
          <th>Ordered Node Chain</th>
          <th>Referenced Capabilities</th>
        </tr>
      </thead>
      <tbody>
        ${workflowRows}
      </tbody>
    </table>

    <h3>Known Runs (Authoritative Runtime State vs Trace Observations)</h3>
    <table>
      <thead>
        <tr>
          <th>Run ID</th>
          <th>Status</th>
          <th>Status Authority</th>
          <th>Company</th>
          <th>Workflow</th>
          <th>Trace Health</th>
          <th>Evaluation</th>
        </tr>
      </thead>
      <tbody>
        ${runRows}
      </tbody>
    </table>

    <h3>Authoritative Approval Records</h3>
    <table>
      <thead>
        <tr>
          <th>Approval ID</th>
          <th>Status</th>
          <th>Run / Node</th>
          <th>Requested By</th>
          <th>Required Roles</th>
          <th>Resolution</th>
        </tr>
      </thead>
      <tbody>
        ${approvalRows}
      </tbody>
    </table>

    <h3>Evaluation Profiles &amp; Execution Reports</h3>
    <table>
      <thead>
        <tr>
          <th>Eval Profile Ref</th>
          <th>Status</th>
          <th>Execution State</th>
          <th>Case Summary</th>
          <th>Company / Run</th>
          <th>Baseline</th>
        </tr>
      </thead>
      <tbody>
        ${evaluationRows}
      </tbody>
    </table>

    ${runDetailSection}
  </section>
</body>
</html>`;
}

export function renderIntegrationDiagnosticsHtml(
  report: IntegrationDiagnosticReport,
  provenance?: OperatorSourceProvenance
): string {
  const isDemo = (provenance ?? report.sourceProvenance)?.mode !== "live";

  const reqRows = report.requirements
    .map(
      (r) =>
        `<tr data-requirement-ref="${escapeHtml(r.requiredRef)}" data-requirement-status="${escapeHtml(r.status)}">
          <td><code>${escapeHtml(r.category)}</code></td>
          <td>${escapeHtml(r.name)}<br/><small><code>${escapeHtml(r.requiredRef)}</code></small></td>
          <td><span class="badge readiness-${escapeHtml(r.status.toLowerCase())}">${escapeHtml(r.status)}</span></td>
          <td>${r.diagnostic ? escapeHtml(r.diagnostic) : r.reasonCode ? `<code>${escapeHtml(r.reasonCode)}</code>` : "—"}</td>
          <td>${r.remediation ? escapeHtml(r.remediation) : r.status === "SATISFIED" ? "No action required" : "Cannot be verified from inspection evidence; confirm out of band before relying on it"}</td>
        </tr>`
    )
    .join("\n");

  const diagItems =
    report.diagnostics.length > 0
      ? `<div class="diagnostics-box" data-diagnostics="true">
          <strong>Diagnostics:</strong>
          <ul>
            ${report.diagnostics.map((d) => `<li><code>[${escapeHtml(d.code)}]</code> ${escapeHtml(d.message)}${d.remediation ? `<br/><small>Suggested check: ${escapeHtml(d.remediation)}</small>` : ""}</li>`).join("")}
          </ul>
        </div>`
      : "";

  const nextStepItems = report.nextSteps
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AAO Control Center — Integration Diagnostics: ${escapeHtml(report.packIdentity)}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body {
      margin: 0;
      padding: 24px;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.45;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .header-badges {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: flex-end;
    }
    .demo-banner {
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #fde68a;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 0.85rem;
      letter-spacing: 0.02em;
    }
    .readonly-banner {
      background: #e0f2fe;
      color: #0369a1;
      border: 1px solid #bae6fd;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.85rem;
    }
    nav {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
    }
    nav a {
      text-decoration: none;
      color: #1e293b;
      background: #e2e8f0;
      padding: 6px 14px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.9rem;
    }
    section {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    h1, h2, h3 {
      margin-top: 0;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .metric-card {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 12px;
    }
    .metric-card .label {
      font-size: 0.8rem;
      color: #475569;
      text-transform: uppercase;
    }
    .metric-card .value {
      font-size: 1.4rem;
      font-weight: 700;
      margin-top: 4px;
    }
    .metric-card .value-id {
      font-size: 1rem;
      font-weight: 600;
      margin-top: 4px;
      word-break: break-all;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 0.9rem;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: top;
    }
    th {
      background: #f8fafc;
      font-weight: 600;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.78rem;
      font-weight: 600;
      background: #e2e8f0;
    }
    .compat-compatible, .run-completed, .eval-passed, .status-available, .approval-approved, .readiness-ready, .readiness-satisfied, .node-observed_completed {
      background: #dcfce7;
      color: #166534;
    }
    .compat-not_verified, .run-waiting, .eval-registered, .eval-not_run, .status-degraded, .approval-pending, .readiness-not_verified, .node-observed_started, .node-evidence_incomplete {
      background: #fef9c3;
      color: #854d0e;
    }
    .compat-incompatible, .run-failed, .eval-failed, .status-invalid, .trace-corrupt, .approval-rejected, .readiness-blocked, .readiness-missing, .readiness-incompatible, .node-observed_failed {
      background: #fee2e2;
      color: #991b1b;
    }
    .run-unknown, .compat-unavailable, .status-unavailable, .trace-unavailable, .readiness-unavailable, .node-not_observed {
      background: #f1f5f9;
      color: #475569;
    }
    .empty-state {
      color: #64748b;
      font-style: italic;
      padding: 12px;
    }
    .diagnostics-box {
      background: #fffbeb;
      border: 1px solid #fde68a;
      padding: 10px 14px;
      border-radius: 6px;
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>AAO Control Center</h1>
      <p>Guided Integration Diagnostics: <code>${escapeHtml(report.packIdentity)}</code> for <code>${escapeHtml(report.companyDisplayName ?? report.companyId)}</code></p>
    </div>
    <div class="header-badges">
      ${isDemo ? `<div class="demo-banner" data-demo-indicator="true">DEMO DATA — NOT LIVE OPERATIONS</div>` : ""}
      <div class="readonly-banner" data-readonly-indicator="true">
        READ-ONLY SURFACE • ZERO MUTATION AUTHORITY
      </div>
    </div>
  </header>

  <nav aria-label="Breadcrumb Navigation">
    <a href="/control-center">&larr; Back to Control Center Overview</a>
    <a href="#section-readiness">Readiness Summary</a>
    <a href="#section-requirements">Requirements Checklist</a>
    <a href="#section-next-steps">Actionable Next Steps</a>
  </nav>

  <section id="section-readiness" data-section="readiness-summary">
    <h2>Integration Readiness Overview</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="label">Overall Readiness</div>
        <div class="value"><span class="badge readiness-${escapeHtml(report.status.toLowerCase())}">${escapeHtml(report.status)}</span></div>
        ${report.reasonCode ? `<small><code>${escapeHtml(report.reasonCode)}</code></small>` : ""}
      </div>
      <div class="metric-card">
        <div class="label">Company</div>
        <div class="value-id"><code>${escapeHtml(report.companyId)}</code></div>
        <small>${escapeHtml(report.companyDisplayName ?? "")}</small>
      </div>
      <div class="metric-card">
        <div class="label">Capability Pack</div>
        <div class="value-id"><code>${escapeHtml(report.packIdentity)}</code></div>
        <small>${escapeHtml(report.packName ?? "")}</small>
      </div>
      <div class="metric-card">
        <div class="label">Workflow Pinned</div>
        <div class="value-id"><code>${escapeHtml(report.workflowId)}@${escapeHtml(report.workflowVersion)}</code></div>
        <small title="${escapeHtml(report.planFingerprint)}">plan: <code>${escapeHtml(report.planFingerprint.slice(0, 16))}…</code></small>
      </div>
    </div>

    ${diagItems}
  </section>

  <section id="section-requirements" data-section="requirements-checklist">
    <h2>Requirements Checklist (${report.requirements.length})</h2>
    <table>
      <thead>
        <tr>
          <th>Category</th>
          <th>Requirement / Reference</th>
          <th>Status</th>
          <th>Diagnostics / Evidence</th>
          <th>Actionable Remediation</th>
        </tr>
      </thead>
      <tbody>
        ${reqRows}
      </tbody>
    </table>
  </section>

  <section id="section-next-steps" data-section="next-steps">
    <h2>Actionable Next Steps</h2>
    <ol>
      ${nextStepItems}
    </ol>
  </section>
</body>
</html>`;
}

export function renderRunDetailHtml(
  runInspection: RunInspection,
  provenance?: OperatorSourceProvenance,
  advanced?: AdvancedRunInspection,
  selectedNodeId?: string,
  advancedUnavailableCode?: string
): string {
  const s = runInspection.summary;
  const t = runInspection.trace;
  const isDemo = (provenance ?? runInspection.provenance)?.mode !== "live";

  const diagnosticsBox =
    runInspection.diagnostics.length > 0
      ? `<div class="diagnostics-box" data-diagnostics="true">
          <strong>Diagnostics:</strong>
          <ul>
            ${runInspection.diagnostics.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}
          </ul>
        </div>`
      : "";

  const traceDiagnosticsBox =
    t.diagnostics.length > 0
      ? `<div class="diagnostics-box" data-trace-diagnostics="true">
          <strong>Trace Integrity Diagnostics:</strong>
          <ul>
            ${t.diagnostics.map((d) => `<li><code>${escapeHtml(d.code)}</code>: ${escapeHtml(d.message)}</li>`).join("")}
          </ul>
        </div>`
      : "";

  let executionSummarySection = "";
  let nodeMapSection = "";
  let selectedNodeSection = "";
  let attemptsSection = "";
  let runDiagnosticsSection = "";

  if (!advanced && advancedUnavailableCode) {
    executionSummarySection = `<section id="section-execution-summary" data-section="execution-summary">
      <div class="diagnostics-box" data-advanced-unavailable="${escapeHtml(advancedUnavailableCode)}">
        <strong>Advanced Run inspection unavailable</strong> (<code>${escapeHtml(advancedUnavailableCode)}</code>):
        node attempts, counters and token accounting require canonical Trace evidence from the inspection source. No figures are shown rather than reconstructed ones.
      </div>
    </section>`;
  }

  if (advanced) {
    const executedPlanCount = advanced.nodes.filter((n) => n.executed).length;
    const totalPlanCount = advanced.nodes.filter((n) => n.planned).length;
    // Same counter rows and token wording as the CLI (shared formatter, shared DTO).
    const counterCards = executionCounterRows(advanced)
      .map(([label, value]) => `<div class="metric-card" data-counter="${escapeHtml(label)}">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value-id">${escapeHtml(value)}</div>
        </div>`)
      .join("\n");

    executionSummarySection = `<section id="section-execution-summary" data-section="execution-summary">
      <h2>Execution Summary (Correlated Runtime &amp; Trace Evidence)</h2>
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="label">Plan Nodes</div>
          <div class="value">${executedPlanCount} / ${totalPlanCount}</div>
          <small>observed nodes</small>
        </div>
        <div class="metric-card">
          <div class="label">Evidence Health</div>
          <div class="value"><span class="badge trace-${escapeHtml(advanced.evidenceHealth)}">${escapeHtml(advanced.evidenceHealth)}</span></div>
        </div>
        ${counterCards}
      </div>
    </section>`;

    const nodeRows = advanced.nodes
      .map((n, idx) => {
        const isSelected = selectedNodeId === n.nodeId;
        const rowStyle = isSelected ? ` style="background: #f0fdf4; font-weight: 600;"` : "";
        const tokens = n.tokenUsage ? formatTokenUsageText(n.tokenUsage) : "—";
        return `<tr${rowStyle} data-node-id="${escapeHtml(n.nodeId)}">
          <td>${idx + 1}</td>
          <td><a href="?nodeId=${encodeURIComponent(n.nodeId)}#section-node-detail"><code>${escapeHtml(n.nodeId)}</code></a></td>
          <td><code>${escapeHtml(n.nodeKind)}</code></td>
          <td><span class="badge node-${escapeHtml(n.status.toLowerCase())}">${escapeHtml(n.status)}</span></td>
          <td>${n.executionCount}</td>
          <td>${n.attemptCount}</td>
          <td>${n.scheduledRetries}</td>
          <td>${n.toolRef ? `<code>${escapeHtml(n.toolRef)}</code>` : "—"}</td>
          <td>${n.modelPolicyRef ? `<code>${escapeHtml(n.modelPolicyRef)}</code>` : "—"}</td>
          <td>${escapeHtml(tokens)}</td>
          <td>${n.approvalStatus ? `<span class="badge approval-${escapeHtml(n.approvalStatus.toLowerCase())}">${escapeHtml(n.approvalStatus)}</span>` : "—"}</td>
          <td>${n.durationMs !== undefined ? `${n.durationMs} ms` : "—"}</td>
          <td>${n.diagnostics.length > 0 ? escapeHtml(n.diagnostics.join("; ")) : "—"}</td>
        </tr>`;
      })
      .join("\n");

    nodeMapSection = `<section id="section-node-map" data-section="node-execution-map">
      <h2>Workflow Node Execution Map (${advanced.nodes.length} nodes)</h2>
      <table>
        <thead>
          <tr>
            <th>Seq</th>
            <th>Node ID</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Executions</th>
            <th>Node Attempts</th>
            <th>Scheduled Retries</th>
            <th>Tool</th>
            <th>Model Policy</th>
            <th>Tokens</th>
            <th>Approval</th>
            <th>Duration</th>
            <th>Diagnostics</th>
          </tr>
        </thead>
        <tbody>
          ${nodeRows}
        </tbody>
      </table>
    </section>`;

    const attemptRow = (att: AdvancedRunInspection["attempts"][number], withNode: boolean) => `<tr>
                    ${withNode ? `<td><code>${escapeHtml(att.nodeId)}</code></td>` : ""}
                    <td>${att.step}</td>
                    <td>#${att.attempt}</td>
                    <td><span class="badge node-${escapeHtml(att.status.toLowerCase())}">${escapeHtml(att.status)}</span></td>
                    <td><code>${escapeHtml(att.startedAt)}</code></td>
                    <td>${att.durationMs !== undefined ? `${att.durationMs} ms` : "—"}</td>
                    <td>${att.toolPhysicalInvocations}</td>
                    <td>${att.modelInvocations}</td>
                    <td>${att.tokenUsage ? escapeHtml(formatTokenUsageText(att.tokenUsage)) : "—"}</td>
                    <td>${att.reasonCode ? `<code>${escapeHtml(att.reasonCode)}</code>` : "—"}</td>
                    <td>${att.recoveryReplay ? `<span class="badge">RECOVERY REPLAY</span>` : "—"}</td>
                  </tr>`;
    const attemptHeader = (withNode: boolean) => `<tr>
                ${withNode ? "<th>Node ID</th>" : ""}
                <th>Step</th>
                <th>Attempt</th>
                <th>Outcome</th>
                <th>Started At</th>
                <th>Duration</th>
                <th>Tool Invocations</th>
                <th>Model Invocations</th>
                <th>Tokens</th>
                <th>Reason Code</th>
                <th>Recovery Replay</th>
              </tr>`;

    if (selectedNodeId) {
      const selectedNode = advanced.nodes.find((n) => n.nodeId === selectedNodeId);
      if (selectedNode) {
        const attemptRows =
          selectedNode.attempts.length === 0
            ? `<tr><td colspan="10" class="empty-state">No node attempts observed for node '${escapeHtml(selectedNodeId)}'.</td></tr>`
            : selectedNode.attempts.map((att) => attemptRow(att, false)).join("\n");

        selectedNodeSection = `<section id="section-node-detail" data-section="selected-node-detail">
          <h2>Selected Node Detail: <code>${escapeHtml(selectedNode.nodeId)}</code></h2>
          <div class="metrics-grid">
            <div class="metric-card">
              <div class="label">Node ID</div>
              <div class="value-id"><code>${escapeHtml(selectedNode.nodeId)}</code></div>
              <small>Kind: <code>${escapeHtml(selectedNode.nodeKind)}</code></small>
            </div>
            <div class="metric-card">
              <div class="label">Execution Status</div>
              <div class="value"><span class="badge node-${escapeHtml(selectedNode.status.toLowerCase())}">${escapeHtml(selectedNode.status)}</span></div>
            </div>
            <div class="metric-card">
              <div class="label">Execution Occurrences</div>
              <div class="value">${selectedNode.executionCount}</div>
            </div>
            <div class="metric-card">
              <div class="label">Node Attempts</div>
              <div class="value">${selectedNode.attemptCount}</div>
              <small>${selectedNode.scheduledRetries} scheduled retries; ${selectedNode.recoveryReplayCount} recovery replays</small>
            </div>
            <div class="metric-card">
              <div class="label">Duration</div>
              <div class="value">${selectedNode.durationMs !== undefined ? `${selectedNode.durationMs} ms` : "—"}</div>
            </div>
          </div>
          ${selectedNode.diagnostics.length > 0 ? `<div class="diagnostics-box"><strong>Node Diagnostics:</strong> ${escapeHtml(selectedNode.diagnostics.join("; "))}</div>` : ""}
          <h3>Node Attempts</h3>
          <table>
            <thead>
              ${attemptHeader(false)}
            </thead>
            <tbody>
              ${attemptRows}
            </tbody>
          </table>
        </section>`;
      }
    }

    const allAttemptRows =
      advanced.attempts.length === 0
        ? `<tr><td colspan="11" class="empty-state">No node attempts observed for this run.</td></tr>`
        : advanced.attempts.map((att) => attemptRow(att, true)).join("\n");
    const unattributedRows = advanced.unattributedEvents
      .map((e) => `<li>seq ${e.sequence}: <code>${escapeHtml(e.type)}</code>${e.nodeId ? ` (node <code>${escapeHtml(e.nodeId)}</code>)` : ""}</li>`)
      .join("");

    attemptsSection = `<section id="section-attempts" data-section="execution-attempts">
      <h2>Node Attempts (${advanced.attempts.length}${advanced.attemptsTruncated ? ", truncated" : ""})</h2>
      <p><small>One row per observed <code>node.started</code>; lifecycle and Tool/model events attach to their attempt by canonical span.</small></p>
      <table>
        <thead>
          ${attemptHeader(true)}
        </thead>
        <tbody>
          ${allAttemptRows}
        </tbody>
      </table>
      ${unattributedRows ? `<div class="diagnostics-box" data-unattributed="true"><strong>Unattributed Evidence (${advanced.unattributedEvents.length}):</strong><ul>${unattributedRows}</ul></div>` : ""}
    </section>`;

    const diagRows =
      advanced.diagnostics.length === 0
        ? `<tr><td colspan="4" class="empty-state">No execution diagnostics flagged for this run.</td></tr>`
        : advanced.diagnostics
            .map(
              (d) =>
                `<tr>
                  <td><code>${escapeHtml(d.code)}</code></td>
                  <td><span class="badge">${escapeHtml(d.severity)}</span></td>
                  <td>${escapeHtml(d.observed)}<br/><small>${escapeHtml(d.explanation)}</small></td>
                  <td>${escapeHtml(d.suggestedCheck)}</td>
                </tr>`
            )
            .join("\n");

    runDiagnosticsSection = `<section id="section-run-diagnostics" data-section="run-diagnostics">
      <h2>Run Diagnostics &amp; Actionable Remediation (${advanced.diagnostics.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Severity</th>
            <th>Observed Evidence &amp; Explanation</th>
            <th>Suggested Check / Remediation</th>
          </tr>
        </thead>
        <tbody>
          ${diagRows}
        </tbody>
      </table>
    </section>`;
  }

  const timelineRows =
    t.events.length === 0
      ? `<tr><td colspan="6" class="empty-state">${t.health === "corrupt" ? "Trace events are withheld due to corrupt trace integrity." : "No trace events available for this run."}</td></tr>`
      : t.events
          .map(
            (ev) =>
              `<tr data-event-seq="${ev.sequence}">
                <td>${ev.sequence}</td>
                <td><code>${escapeHtml(ev.occurredAt)}</code></td>
                <td><code>${escapeHtml(ev.type)}</code></td>
                <td><code>${escapeHtml(ev.nodeId ?? "—")}</code></td>
                <td><code>${escapeHtml(ev.status ?? "—")}</code></td>
                <td><code>${escapeHtml(ev.reasonCode ?? ev.toolRef ?? ev.modelPolicyRef ?? ev.approvalId ?? "—")}</code></td>
              </tr>`
          )
          .join("\n");

  const approvalRows =
    runInspection.approvals.length === 0
      ? `<tr><td colspan="6" class="empty-state">No known approval records for this run.</td></tr>`
      : runInspection.approvals
          .map(
            (a) =>
              `<tr data-approval-id="${escapeHtml(a.approvalId)}">
                <td><code>${escapeHtml(a.approvalId)}</code></td>
                <td><span class="badge approval-${escapeHtml(a.status)}">${escapeHtml(a.status.toUpperCase())}</span></td>
                <td><code>${escapeHtml(a.nodeId)}</code></td>
                <td><code>${escapeHtml(a.requestedBy.id)}</code> (${escapeHtml(a.requestedAt)})</td>
                <td><code>${escapeHtml(a.requiredApproverRoleIds.join(", "))}</code></td>
                <td>${a.resolvedBy ? `<code>${escapeHtml(a.resolvedBy.id)}</code> (${escapeHtml(a.resolvedAt ?? "")})` : "Pending human decision"}</td>
              </tr>`
          )
          .join("\n");

  const evaluationRows =
    runInspection.evaluations.length === 0
      ? `<tr><td colspan="5" class="empty-state">No evaluation records for this run.</td></tr>`
      : runInspection.evaluations
          .map(
            (e) =>
              `<tr data-eval-profile="${escapeHtml(e.evalProfileRef)}">
                <td><code>${escapeHtml(e.evalProfileRef)}</code></td>
                <td><span class="badge eval-${escapeHtml(e.status.toLowerCase())}">${escapeHtml(e.status)}</span></td>
                <td>${e.executed ? "Executed Report" : "Registered Profile Only (Not Run)"}</td>
                <td>${e.executed && e.totalCases !== undefined ? `${e.passedCases}/${e.totalCases} (${((e.passRate ?? 0) * 100).toFixed(0)}%)` : "—"}</td>
                <td>${e.baselineComparisonStatus ? `<code>${escapeHtml(e.baselineComparisonStatus)}</code>` : "—"}</td>
              </tr>`
          )
          .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AAO Control Center — Run Detail: ${escapeHtml(s.runId)}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body {
      margin: 0;
      padding: 24px;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.45;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .header-badges {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: flex-end;
    }
    .demo-banner {
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #fde68a;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 0.85rem;
      letter-spacing: 0.02em;
    }
    .readonly-banner {
      background: #e0f2fe;
      color: #0369a1;
      border: 1px solid #bae6fd;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.85rem;
    }
    nav {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
    }
    nav a {
      text-decoration: none;
      color: #1e293b;
      background: #e2e8f0;
      padding: 6px 14px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.9rem;
    }
    section {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    h1, h2, h3 {
      margin-top: 0;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .metric-card {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 12px;
    }
    .metric-card .label {
      font-size: 0.8rem;
      color: #475569;
      text-transform: uppercase;
    }
    .metric-card .value {
      font-size: 1.4rem;
      font-weight: 700;
      margin-top: 4px;
    }
    .metric-card .value-id {
      font-size: 1rem;
      font-weight: 600;
      margin-top: 4px;
      word-break: break-all;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 0.9rem;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: top;
    }
    th {
      background: #f8fafc;
      font-weight: 600;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.78rem;
      font-weight: 600;
      background: #e2e8f0;
    }
    .compat-compatible, .run-completed, .eval-passed, .status-available, .approval-approved, .readiness-ready, .readiness-satisfied, .node-observed_completed {
      background: #dcfce7;
      color: #166534;
    }
    .compat-not_verified, .run-waiting, .eval-registered, .eval-not_run, .status-degraded, .approval-pending, .readiness-not_verified, .node-observed_started, .node-evidence_incomplete {
      background: #fef9c3;
      color: #854d0e;
    }
    .compat-incompatible, .run-failed, .eval-failed, .status-invalid, .trace-corrupt, .approval-rejected, .readiness-blocked, .readiness-missing, .readiness-incompatible, .node-observed_failed {
      background: #fee2e2;
      color: #991b1b;
    }
    .run-unknown, .compat-unavailable, .status-unavailable, .trace-unavailable, .readiness-unavailable, .node-not_observed {
      background: #f1f5f9;
      color: #475569;
    }
    .empty-state {
      color: #64748b;
      font-style: italic;
      padding: 12px;
    }
    .diagnostics-box {
      background: #fffbeb;
      border: 1px solid #fde68a;
      padding: 10px 14px;
      border-radius: 6px;
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>AAO Control Center</h1>
      <p>Run Detail Inspection: <code>${escapeHtml(s.runId)}</code></p>
    </div>
    <div class="header-badges">
      ${isDemo ? `<div class="demo-banner" data-demo-indicator="true">DEMO DATA — NOT LIVE OPERATIONS</div>` : ""}
      <div class="readonly-banner" data-readonly-indicator="true">
        READ-ONLY SURFACE • ZERO EXECUTION OR APPROVAL MUTATION AUTHORITY
      </div>
    </div>
  </header>

  <nav aria-label="Control Center Navigation">
    <a href="/control-center">&larr; Back to Control Center Overview</a>
    <a href="#section-identity">Run Identity</a>
    ${advanced ? `<a href="#section-execution-summary">Execution Summary</a>` : ""}
    ${advanced ? `<a href="#section-node-map">Node Execution Map</a>` : ""}
    ${advanced && selectedNodeId ? `<a href="#section-node-detail">Node Detail: ${escapeHtml(selectedNodeId)}</a>` : ""}
    ${advanced ? `<a href="#section-attempts">Execution Attempts</a>` : ""}
    ${advanced ? `<a href="#section-run-diagnostics">Run Diagnostics</a>` : ""}
    <a href="#section-timeline">Trace Timeline</a>
    <a href="#section-approvals">Approvals</a>
    <a href="#section-evaluations">Evaluations</a>
  </nav>

  <section id="section-identity" data-section="run-identity">
    <h2>Run Identity &amp; Execution Summary</h2>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="label">Run ID</div>
        <div class="value-id"><code>${escapeHtml(s.runId)}</code></div>
      </div>
      <div class="metric-card">
        <div class="label">Authoritative Status</div>
        <div class="value"><span class="badge run-${escapeHtml(s.status.toLowerCase())}">${escapeHtml(s.status)}</span></div>
        <small>Source: <code>${escapeHtml(s.statusSource)}</code></small>
      </div>
      <div class="metric-card">
        <div class="label">Trace Health</div>
        <div class="value"><span class="badge trace-${escapeHtml(s.traceHealth)}}">${escapeHtml(s.traceHealth)}</span></div>
        <small>${t.returnedEventCount}/${t.eventCount} events ${t.truncated ? "(truncated)" : ""}</small>
      </div>
      <div class="metric-card">
        <div class="label">Workflow</div>
        <div class="value-id"><code>${escapeHtml(s.workflowId)}@${escapeHtml(s.workflowVersion)}</code></div>
      </div>
      <div class="metric-card">
        <div class="label">Company</div>
        <div class="value-id"><code>${escapeHtml(s.companyId ?? "—")}</code></div>
      </div>
      <div class="metric-card">
        <div class="label">Capability Pack</div>
        <div class="value-id"><code>${escapeHtml(s.packIdentity ?? "—")}</code></div>
      </div>
    </div>

    ${diagnosticsBox}
    ${traceDiagnosticsBox}

    <table>
      <thead>
        <tr><th>Property</th><th>Observed Evidence</th></tr>
      </thead>
      <tbody>
        <tr><td><strong>Run ID</strong></td><td><code>${escapeHtml(s.runId)}</code></td></tr>
        <tr><td><strong>Company ID</strong></td><td><code>${escapeHtml(s.companyId ?? "—")}</code></td></tr>
        <tr><td><strong>Workflow Reference</strong></td><td><code>${escapeHtml(s.workflowId)}@${escapeHtml(s.workflowVersion)}</code></td></tr>
        <tr><td><strong>Canonical Run Status</strong></td><td><span class="badge run-${escapeHtml(s.status.toLowerCase())}">${escapeHtml(s.status)}</span> ${s.statusReason ? `(<code>${escapeHtml(s.statusReason)}</code>)` : ""}</td></tr>
        <tr><td><strong>Status Source</strong></td><td><code>${escapeHtml(s.statusSource)}</code></td></tr>
        <tr><td><strong>Trace Health</strong></td><td><span class="badge trace-${escapeHtml(s.traceHealth)}">${escapeHtml(s.traceHealth)}</span></td></tr>
        <tr><td><strong>Event Counts</strong></td><td>${t.returnedEventCount} returned / ${t.eventCount} total (${t.truncated ? "bounded/truncated" : "complete"})</td></tr>
        <tr><td><strong>Current / Terminal Node</strong></td><td><code>${escapeHtml(s.currentNodeId ?? "—")}</code></td></tr>
        <tr><td><strong>Started At</strong></td><td><code>${escapeHtml(s.startedAt ?? t.startedAt ?? "—")}</code></td></tr>
        <tr><td><strong>Finished At</strong></td><td><code>${escapeHtml(s.finishedAt ?? t.finishedAt ?? "—")}</code></td></tr>
        <tr><td><strong>Evidence Availability</strong></td><td>Trace available: <strong>${s.traceAvailable ? "yes" : "no"}</strong> | Authoritative Runtime state: <strong>${s.statusSource === "authoritative_runtime" ? "yes" : "no"}</strong></td></tr>
      </tbody>
    </table>
  </section>

  ${executionSummarySection}
  ${nodeMapSection}
  ${selectedNodeSection}
  ${attemptsSection}
  ${runDiagnosticsSection}

  <section id="section-timeline" data-section="trace-timeline">
    <h2>Trace Timeline (Bounded Chronological Projections)</h2>
    <table>
      <thead>
        <tr>
          <th>Seq</th>
          <th>Timestamp</th>
          <th>Event</th>
          <th>Node</th>
          <th>Outcome</th>
          <th>Diagnostic</th>
        </tr>
      </thead>
      <tbody>
        ${timelineRows}
      </tbody>
    </table>
  </section>

  <section id="section-approvals" data-section="run-approvals">
    <h2>Authoritative Approval Records</h2>
    <table>
      <thead>
        <tr>
          <th>Approval ID</th>
          <th>Status</th>
          <th>Node</th>
          <th>Requested By</th>
          <th>Required Roles</th>
          <th>Resolution</th>
        </tr>
      </thead>
      <tbody>
        ${approvalRows}
      </tbody>
    </table>
  </section>

  <section id="section-evaluations" data-section="run-evaluations">
    <h2>Evaluation Results &amp; Profiles</h2>
    <table>
      <thead>
        <tr>
          <th>Eval Profile Ref</th>
          <th>Status</th>
          <th>Execution State</th>
          <th>Case Summary</th>
          <th>Baseline</th>
        </tr>
      </thead>
      <tbody>
        ${evaluationRows}
      </tbody>
    </table>
  </section>
</body>
</html>`;
}

export function renderNotFoundHtml(
  message: string,
  provenance?: OperatorSourceProvenance
): string {
  const isDemo = provenance?.mode !== "live";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AAO Control Center — Not Found</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body {
      margin: 0;
      padding: 24px;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.45;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .header-badges {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: flex-end;
    }
    .demo-banner {
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #fde68a;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 0.85rem;
      letter-spacing: 0.02em;
    }
    .readonly-banner {
      background: #e0f2fe;
      color: #0369a1;
      border: 1px solid #bae6fd;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.85rem;
    }
    nav {
      margin-bottom: 20px;
    }
    nav a {
      text-decoration: none;
      color: #1e293b;
      background: #e2e8f0;
      padding: 6px 14px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.9rem;
    }
    section {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 24px;
    }
    .error-code {
      color: #991b1b;
      font-size: 1.2rem;
      font-weight: 700;
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>AAO Control Center</h1>
      <p>Operator Inspection Surface</p>
    </div>
    <div class="header-badges">
      ${isDemo ? `<div class="demo-banner" data-demo-indicator="true">DEMO DATA — NOT LIVE OPERATIONS</div>` : ""}
      <div class="readonly-banner" data-readonly-indicator="true">
        READ-ONLY SURFACE • ZERO EXECUTION OR APPROVAL MUTATION AUTHORITY
      </div>
    </div>
  </header>

  <nav>
    <a href="/control-center">&larr; Back to Control Center Overview</a>
  </nav>

  <section>
    <div class="error-code">INSPECTION_RUN_NOT_FOUND</div>
    <p>${escapeHtml(message)}</p>
  </section>
</body>
</html>`;
}
