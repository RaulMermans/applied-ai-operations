import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVAL_CANONICAL_CRITICAL_CATEGORIES, EvalGateDecisionSchema, RunStatusSchema, type EvalDataset } from "@aao/contracts";
import { continueApprovedWorkflow } from "@aao/approval";
import { createGovernanceRegistry, resolveAuthority } from "@aao/governance";
import { SUPPORTED_TOOL_PERMISSION_CLASSES, checkToolPermissionSupport, createToolRegistry, executeTool } from "@aao/tool-runtime";
import { buildEvalSuiteReport, createStaticEvidenceResolver, evalBaselineFingerprint, evaluateEvalGate, proposeEvalBaseline, runEvalDataset } from "../src/index.js";
import { loadFoundationInputs, runGatePipeline } from "../cli/host.mjs";
import { realFlagship } from "./support/fixture-builders.js";
import { loadDefinitions, registry } from "./support/evals.js";
import { alice } from "./support/world.js";

/**
 * Sprint 18 non-authority (ADR-023): analytics, baselines, gate decisions,
 * and adapter reports are engineering/release quality data. A gate PASS
 * cannot approve, authorize, trigger a Tool, change Run state, mark replay
 * safe, increase retries, or enable a side-effect class — there is no API
 * through which it could, and execution never reads it.
 */
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const sourceFiles = (pkg: string): string[] => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
  return walk(join(packagesDir, pkg, "src"));
};

/** Evaluate a live Run as a RUNTIME dataset, build its suite, accept it as a baseline, and gate it: the full Sprint 18 chain over live evidence. */
async function gateLiveRun(bundle: object, runId: string) {
  const evidenceRef = `live://${runId}`;
  const dataset: EvalDataset = {
    schemaVersion: 2, id: "test.live-gate", version: "1.0.0", name: "Live gate",
    cases: ["trace.contract-valid", "run.completed", "tool.lookup-required", "approval.required-and-approved", "retry.within-budget"].map((id) => {
      const found = loadDefinitions().find((entry) => entry.id === id)!;
      return { id: `live.${id}.001`, evalRef: { id: found.id, version: found.version }, mode: "RUNTIME" as const, evidenceRef, expected: { status: "passed" as const } };
    }),
  };
  const run = await runEvalDataset({ dataset, definitions: loadDefinitions(), registry: registry(), evidenceResolver: createStaticEvidenceResolver([[evidenceRef, bundle as never]]) });
  if (!run.ok) throw new Error(JSON.stringify(run.issues));
  const suite = buildEvalSuiteReport({ dataset, definitions: loadDefinitions(), run: run.run });
  const baseline = proposeEvalBaseline({ suite, id: "test-live-baseline", version: "1.0.0" });
  const policy = { schemaVersion: 1, id: "test-live-gate", version: "1.0.0", name: "Live gate", datasetRef: { id: dataset.id, version: dataset.version }, baselineRef: { id: baseline.id, version: baseline.version, fingerprint: evalBaselineFingerprint(baseline) }, hardFail: { requireAllCasesPresent: true, requireExpectationMatchRate: 1, maxRegressions: 0, criticalCategories: [...EVAL_CANONICAL_CRITICAL_CATEGORIES] }, warnings: [] };
  const gate = evaluateEvalGate({ policy, baseline, candidate: suite });
  if (!gate.ok) throw new Error(JSON.stringify(gate.error));
  return gate.decision;
}

describe("Runtime independence", () => {
  it("a complete AAO Run's state, Trace, Audit, Metrics, Approval state, and Tool invocation count are identical before and after analytics and gating", async () => {
    const run = await realFlagship("approve", "live_run", "run.gate.independence");
    const approvalId = run.bundle.trace!.map((event) => event as { type: string; payload: { approvalId?: string } }).find((event) => event.type === "approval.requested")!.payload.approvalId!;
    const snapshot = async () => JSON.stringify({
      execution: run.execution,
      trace: await run.world.store.getRunTrace("run.gate.independence"),
      audit: await run.world.auditStore.getStream("run:run.gate.independence"),
      metrics: run.bundle.metrics,
      approval: run.world.approvals.getApproval(approvalId),
      toolCalls: run.world.calls.length,
    });
    const before = await snapshot();
    const decision = await gateLiveRun(run.bundle, "run.gate.independence");
    expect(decision).toMatchObject({ passed: true, outcome: "PASS" });
    const foundation = await runGatePipeline(loadFoundationInputs());
    expect(foundation.ok && foundation.decision.passed).toBe(true);
    expect(await snapshot()).toBe(before);
  });
});

describe("a gate PASS carries no authority", () => {
  it("cannot approve: a pending Approval stays pending, the Tool is never called, and the Run cannot continue", async () => {
    const run = await realFlagship("none", "live_run", "run.gate.pending");
    const approvalId = run.execution.wait!.referenceId;
    const before = JSON.stringify({ execution: run.execution, approval: run.world.approvals.getApproval(approvalId), calls: run.world.calls });
    const foundation = await runGatePipeline(loadFoundationInputs());
    expect(foundation.ok && foundation.decision.outcome).toBe("PASS");
    expect(run.world.approvals.getApproval(approvalId)?.status).toBe("pending");
    expect(JSON.stringify({ execution: run.execution, approval: run.world.approvals.getApproval(approvalId), calls: run.world.calls })).toBe(before);
    const continued = await continueApprovedWorkflow(run.world.approvals, { plan: run.world.plan, registry: run.world.registry, execution: run.execution, options: run.world.runtimeOptions });
    expect(continued.ok).toBe(false);
    expect(run.world.calls).toHaveLength(0);
  });

  it("cannot enable unsupported Tool classes: with every eval and the gate passing, external_side_effect, destructive, and sensitive_data stay unsupported and handlers stay uncalled", async () => {
    const foundation = await runGatePipeline(loadFoundationInputs());
    expect(foundation.ok && foundation.decision.passed).toBe(true);
    expect([...SUPPORTED_TOOL_PERMISSION_CLASSES]).toEqual(["read_only", "write_draft"]);
    for (const permissionClass of ["external_side_effect", "destructive", "sensitive_data"] as const) {
      expect(checkToolPermissionSupport({ permissionClasses: [permissionClass] }).supported).toBe(false);
      const tools = createToolRegistry();
      let invoked = 0;
      tools.register({ spec: { schemaVersion: 1, id: "gate.side-effect", version: "1.0.0", name: "Side effect", inputSchema: { type: "object" }, outputSchema: { type: "object" }, permissionClasses: [permissionClass] }, handler: { execute: async () => { invoked += 1; return { ok: true, output: {} }; } } });
      const blocked = await executeTool({ tools, request: { schemaVersion: 1, toolExecutionId: `tex.gate.${permissionClass}`, toolRef: { id: "gate.side-effect", version: "1.0.0" }, input: {} }, authorizationContext: { schemaVersion: 1, principal: alice, grantedPermissionClasses: [permissionClass] } });
      expect(blocked).toMatchObject({ ok: false, failure: { code: "TOOL_PERMISSION_UNSUPPORTED" } });
      expect(invoked).toBe(0);
    }
  });

  it("a forged GateDecision PASS grants no Role or permission class: Governance still denies an unbound actor", () => {
    const governance = createGovernanceRegistry({ actors: [alice, { id: "user.mallory", type: "user" }], roles: [{ id: "operator", version: "1.0.0", permissionClasses: ["read_only"] }], bindings: [{ id: "alice.operator", actorId: alice.id, roleId: "operator", status: "active" }], policies: [] });
    const forged = EvalGateDecisionSchema.parse({ schemaVersion: 1, policyRef: { id: "foundation-ci", version: "1.0.0" }, baselineRef: { id: "runtime-foundation", version: "1.0.0" }, datasetRef: { id: "aao.runtime-foundation", version: "2.0.0" }, passed: true, outcome: "PASS", hardFailures: [], warnings: [], candidateSummary: { casesTotal: 1, expectationsMatched: 1, expectationsMismatched: 0, expectationErrors: 0, expectationMatchRate: 1, rawStatuses: { passed: 1, failed: 0, error: 0 }, averageScore: { status: "unavailable" } }, comparisonSummary: { unchangedMatch: 1, unchangedMismatch: 0, regressions: 0, improvements: 0, newCases: 0, missingCases: 0, incompatible: 0 }, findings: [] });
    expect(forged.passed).toBe(true);
    // resolveAuthority takes a registry, an actor, and permission classes — nothing else exists to pass a decision through.
    expect(resolveAuthority(governance, { id: "user.mallory", type: "user" }, ["read_only"]).decision).toBe("DENY");
    expect(resolveAuthority(governance, { ...forged, id: "user.mallory", type: "user" } as never, ["read_only"]).decision).toBe("DENY");
    expect(resolveAuthority(governance, alice, ["write_draft"]).decision).toBe("DENY");
  });

  it("a gate decision is not a Run status: no CI or gate value exists in the Run lifecycle", () => {
    expect(RunStatusSchema.options.filter((status) => /CI|GATE|EVAL/.test(status))).toEqual([]);
  });
});

describe("static non-authority", () => {
  const EXECUTION_PACKAGES = ["runtime", "tool-runtime", "model-runtime", "agent-runtime", "approval", "durability", "governance", "authorization", "mcp-connector", "workflow-dsl", "observability"];

  it("analytics, gates, and conformance reach no authority: no approve, authorize, Tool execution, Run transition, retry, replay safety, or Governance path", () => {
    for (const file of sourceFiles("evaluation").filter((path) => /\/(analytics|gates|conformance)\//.test(path))) {
      expect(code(file), file).not.toMatch(/\b(?:executeTool|authorize|resolveAuthority|approve|reject|requestApproval|continueApprovedWorkflow|executeWorkflow|resumeWorkflow|requestCancellation|transitionRunRecord|recoverySafety|retrySafety|ReliabilityPolicy|SUPPORTED_TOOL_PERMISSION_CLASSES|statePatch|createGovernanceRegistry|RunStatus)\b/);
    }
  });

  it("no execution package reads baselines, gate policies, gate decisions, or conformance reports (baselines are never Runtime memory)", () => {
    for (const pkg of EXECUTION_PACKAGES) for (const file of sourceFiles(pkg)) expect(code(file), file).not.toMatch(/evals\/baselines|evals\/gates|EvalBaseline|EvalGateDecision|EvalGatePolicy|AdapterConformanceReport|RegressionFinding|semanticVerdictFingerprint/);
  });

  it("conformance drivers live with their substrates and never import @aao/evaluation", () => {
    for (const [pkg, files] of [["tool-runtime", ["driver.mjs"]], ["mcp-connector", ["driver.mjs"]], ["model-runtime", ["harness.mjs", "native-driver.mjs", "vercel-ai-driver.mjs"]]] as const) {
      for (const file of files) {
        const source = code(join(packagesDir, pkg, "conformance", file));
        expect(source, `${pkg}/${file}`).not.toMatch(/@aao\/evaluation|@aao\/observability|import\(/);
      }
    }
  });
});
