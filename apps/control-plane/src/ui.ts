import type {
  OperatorSourceProvenance,
  OverviewInspection,
  RunInspection,
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
                <td><code>${escapeHtml(c.companyId)}</code></td>
                <td><code>${escapeHtml(c.packIdentity)}</code></td>
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
    .compat-compatible, .run-completed, .eval-passed, .status-available, .approval-approved {
      background: #dcfce7;
      color: #166534;
    }
    .compat-not_verified, .run-waiting, .eval-registered, .eval-not_run, .status-degraded, .approval-pending {
      background: #fef9c3;
      color: #854d0e;
    }
    .compat-incompatible, .run-failed, .eval-failed, .status-invalid, .trace-corrupt, .approval-rejected {
      background: #fee2e2;
      color: #991b1b;
    }
    .run-unknown, .compat-unavailable, .status-unavailable, .trace-unavailable {
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

export function renderRunDetailHtml(
  runInspection: RunInspection,
  provenance?: OperatorSourceProvenance
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
    .compat-compatible, .run-completed, .eval-passed, .status-available, .approval-approved {
      background: #dcfce7;
      color: #166534;
    }
    .compat-not_verified, .run-waiting, .eval-registered, .eval-not_run, .status-degraded, .approval-pending {
      background: #fef9c3;
      color: #854d0e;
    }
    .compat-incompatible, .run-failed, .eval-failed, .status-invalid, .trace-corrupt, .approval-rejected {
      background: #fee2e2;
      color: #991b1b;
    }
    .run-unknown, .compat-unavailable, .status-unavailable, .trace-unavailable {
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
