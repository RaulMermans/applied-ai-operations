import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraceEvent } from "@aao/contracts";
import { COMPANY_RESEARCH_PACK, OPERATIONAL_REQUEST_PACK } from "@aao/capability-packs";
import { createInMemoryTraceStore, createTraceRecorder, deriveRunMetrics, validateTrace, type TraceStore } from "@aao/observability";
import {
  CANONICAL_APPROVAL_RECORDS,
  CANONICAL_NORTHSTAR_MANIFEST,
  CANONICAL_RUN_RECORDS,
  CANONICAL_WORKFLOWS,
  buildCanonicalTraceFixtures,
  createCanonicalDemoInspectionSource,
  createEvidenceBackedInspectionSource,
  createOperatorInspectionService,
  createVerifiedRegistrationEvidenceForCompany,
  formatAdvancedRunInspectionNodesText,
  formatAdvancedRunInspectionTimelineText,
  formatTokenUsageText,
  projectAdvancedRunInspection,
  projectIntegrationDiagnostics,
  summarizeTokenUsage,
  type OperatorInspectionSource,
} from "../src/index.js";

// --- Canonical Trace builder: every fixture goes through the canonical recorder. ---

const WF = { workflowId: "company_research.proof", workflowVersion: "1.0.0" };
const node = (nodeId: string, step: number, attempt: number) => ({ kind: "node" as const, nodeId, step, attempt });
const toolRef = { id: "public_web.search", version: "1.0.0" };
const access = { decision: "allow" as const, principalId: "user.northstar.analyst", agentCeilingApplied: false };

async function recordRun(runId: string, build: (b: ReturnType<typeof builder>) => Promise<void>): Promise<TraceEvent[]> {
  const store = createInMemoryTraceStore();
  let ms = Date.parse("2026-03-01T10:00:00.000Z");
  const recorder = createTraceRecorder({ store, clock: { now: () => new Date((ms += 1000)).toISOString() } });
  await recorder.emit({ type: "run.started", runId, ...WF, span: { kind: "run" }, key: { run: runId }, payload: { entryNodeId: "plan", initialStateRevision: 0, nodeCount: 2, reliabilityPolicies: [] } });
  await build(builder(recorder, runId));
  const trace = await store.getRunTrace(runId);
  expect(validateTrace(trace).issues).toEqual([]);
  return trace;
}

function builder(recorder: ReturnType<typeof createTraceRecorder>, runId: string) {
  const emit = (e: Record<string, unknown>) => recorder.emit({ runId, ...WF, ...e } as Parameters<typeof recorder.emit>[0]);
  return {
    start: (nodeId: string, step: number, attempt: number, kind = "tool", replay = false) =>
      emit({ type: "node.started", nodeId, span: node(nodeId, step, attempt), parentSpan: { kind: "run" }, key: { step, attempt, replay }, payload: { kind, step, attempt, maxAttempts: 3, stateRevision: step - 1, recoveryReplay: replay } }),
    done: (nodeId: string, step: number, attempt: number, kind = "tool", outcomeSource = "executor") =>
      emit({ type: "node.completed", nodeId, span: node(nodeId, step, attempt), parentSpan: { kind: "run" }, key: { step }, payload: { kind, step, attemptCount: attempt, stateRevisionBefore: step - 1, stateRevisionAfter: step, outcomeSource } }),
    failed: (nodeId: string, step: number, attempt: number, code: string) =>
      emit({ type: "node.failed", nodeId, span: node(nodeId, step, attempt), parentSpan: { kind: "run" }, key: { step }, payload: { kind: "tool", step, attemptCount: attempt, code, category: "EXECUTION", retryable: true } }),
    tool: async (nodeId: string, step: number, attempt: number, tex: string, result: "completed" | "failed" | "open") => {
      const span = { kind: "tool" as const, toolExecutionId: tex, attempt };
      const base = { nodeId, span, parentSpan: node(nodeId, step, attempt), key: { toolExecutionId: tex, attempt } };
      await emit({ type: "tool.call.started", ...base, payload: { toolRef, toolExecutionId: tex, attempt, permissionClasses: ["read_only"], access, recoveryReplay: false } });
      if (result === "completed") await emit({ type: "tool.call.completed", ...base, payload: { toolRef, toolExecutionId: tex, attempt, permissionClasses: ["read_only"], result: "success" } });
      if (result === "failed") await emit({ type: "tool.call.failed", ...base, payload: { toolRef, toolExecutionId: tex, attempt, code: "PROVIDER_TIMEOUT", retryable: true, category: "EXECUTION" } });
    },
    model: async (nodeId: string, step: number, attempt: number, inv: string, result: { usage?: Record<string, number> } | "failed" | "open", parent: "node" | "run" = "node") => {
      const span = { kind: "model" as const, invocationId: inv, attempt: 1 };
      const base = { nodeId, span, parentSpan: parent === "node" ? node(nodeId, step, attempt) : { kind: "run" }, key: { invocationId: inv, attempt: 1 } };
      await emit({ type: "model.call.started", ...base, payload: { invocationId: inv, attempt: 1, modelPolicyRef: "company_research.planning", modelBindingId: "northstar.model.native", outputKind: "text", requiredCapabilityIds: [], recoveryReplay: false } });
      if (result === "failed") await emit({ type: "model.call.failed", ...base, payload: { invocationId: inv, attempt: 1, modelBindingId: "northstar.model.native", code: "PROVIDER_ERROR" } });
      else if (result !== "open") await emit({ type: "model.call.completed", ...base, payload: { invocationId: inv, attempt: 1, modelBindingId: "northstar.model.native", outputKind: "text", ...(result.usage ? { usage: result.usage } : {}) } });
    },
    retry: (nodeId: string, step: number, failedAttempt: number) =>
      emit({ type: "retry.scheduled", nodeId, span: node(nodeId, step, failedAttempt), key: { step, attempt: failedAttempt }, payload: { step, failedAttempt, nextAttempt: failedAttempt + 1, maxAttempts: 3, category: "EXECUTION", causeCode: "PROVIDER_TIMEOUT", delayMs: 0 } }),
    exhausted: (nodeId: string, step: number, attempt: number) =>
      emit({ type: "retry.exhausted", nodeId, span: node(nodeId, step, attempt), key: { step }, payload: { step, attempt, maxAttempts: 3, category: "EXECUTION", causeCode: "PROVIDER_TIMEOUT" } }),
    approval: async (nodeId: string, step: number, approvalId: string) => {
      await emit({ type: "approval.requested", nodeId, span: node(nodeId, step, 1), key: { approvalId }, payload: { approvalId, step, requestedBy: { id: "user.northstar.requester", type: "user" }, requiredApproverRoleIds: ["operations.approver"], permissionClasses: ["write_draft"], allowSelfApproval: false, requestFingerprint: "a".repeat(64) } });
      await emit({ type: "node.waiting", nodeId, span: node(nodeId, step, 1), parentSpan: { kind: "run" }, key: { step }, payload: { kind: "approval", step, waitKind: "approval", referenceId: approvalId } });
      await emit({ type: "approval.resolved", key: { approvalId, resolved: true }, span: { kind: "run" }, payload: { approvalId, status: "approved", resolvedBy: { id: "user.northstar.manager", type: "user" }, resolvedAt: "2026-03-01T11:00:00.000Z" } });
    },
    recover: async (nodeId: string, step: number, attempt: number) => {
      await emit({ type: "recovery.started", span: { kind: "run" }, key: { recovery: 1 }, payload: { checkpointId: "chk.test.001", checkpointSequence: 0, runStatus: "RUNNING", stateRevision: 0, currentNodeId: nodeId } });
      await emit({ type: "recovery.replayed", nodeId, span: node(nodeId, step, attempt), key: { step, attempt, replayed: 1 }, payload: { operationId: `op.${nodeId}.${step}`, step, attempt, recoveryReplayCount: 1 } });
    },
    end: (steps: number) => emit({ type: "run.completed", span: { kind: "run" }, key: { run: runId }, payload: { finalNodeId: "final", stateRevision: steps, steps } }),
  };
}

const inspect = (runId: string, traceEvents: readonly TraceEvent[] | undefined) => projectAdvancedRunInspection({ runId, traceEvents });

// --- Execution attempt correlation ---

describe("Sprint 28C: execution attempt correlation", () => {
  it("1–2. single successful Tool attempt: 4 lifecycle events are 1 attempt and 1 physical invocation", async () => {
    const trace = await recordRun("run.c.single", async (b) => {
      await b.start("search", 1, 1);
      await b.tool("search", 1, 1, "tex.single", "completed");
      await b.done("search", 1, 1);
      await b.end(1);
    });
    const a = inspect("run.c.single", trace);
    expect(a.counters).toMatchObject({ traceEvents: 6, nodeExecutionOccurrences: 1, nodeAttempts: 1, toolPhysicalInvocations: 1, toolLogicalExecutions: 1, scheduledRetries: 0 });
    expect(a.attempts).toHaveLength(1);
    expect(a.attempts[0]).toMatchObject({ nodeId: "search", step: 1, attempt: 1, status: "completed", toolPhysicalInvocations: 1, recoveryReplay: false });
    // node.started, tool.call.started, tool.call.completed, node.completed
    expect(a.attempts[0]!.evidenceEventIds).toHaveLength(4);
  });

  it("3–4. single model invocation: start + completion is 1 invocation and 1 completion", async () => {
    const trace = await recordRun("run.c.model", async (b) => {
      await b.start("plan", 1, 1, "model");
      await b.model("plan", 1, 1, "inv.model", { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
      await b.done("plan", 1, 1, "model");
      await b.end(1);
    });
    const a = inspect("run.c.model", trace);
    expect(a.counters!.modelInvocations).toBe(1);
    expect(a.tokenUsage).toMatchObject({ status: "complete", modelInvocations: 1, callsCompleted: 1, totalTokens: 15 });
    expect(a.attempts[0]).toMatchObject({ modelInvocations: 1, modelPolicyRef: "company_research.planning" });
  });

  it("5. repeated node at a different step is a separate execution, not a retry", async () => {
    const trace = await recordRun("run.c.repeat", async (b) => {
      for (const [id, step] of [["a", 2], ["b", 3], ["a", 4]] as const) {
        await b.start(id, step, 1);
        await b.done(id, step, 1);
      }
      await b.end(4);
    });
    const a = inspect("run.c.repeat", trace);
    const nodeA = a.nodes.find((n) => n.nodeId === "a")!;
    expect(nodeA.executionCount).toBe(2);
    expect(nodeA.attemptCount).toBe(2);
    expect(nodeA.scheduledRetries).toBe(0);
    expect(nodeA.attempts.map((x) => [x.step, x.attempt])).toEqual([[2, 1], [4, 1]]);
    expect(new Set(nodeA.attempts.map((x) => x.spanId)).size).toBe(2);
    expect(a.counters).toMatchObject({ nodeExecutionOccurrences: 3, nodeAttempts: 3, scheduledRetries: 0 });
    expect(a.diagnostics.some((d) => d.code === "RETRIES_OBSERVED")).toBe(false);
    expect(a.diagnostics.some((d) => d.code === "NODE_REPEATED")).toBe(true);
  });

  it("6. two retries within one node execution: one step, three attempts, two scheduled retries", async () => {
    const trace = await recordRun("run.c.retry2", async (b) => {
      for (const attempt of [1, 2, 3]) {
        await b.start("search", 2, attempt);
        await b.tool("search", 2, attempt, `tex.r.${attempt}`, attempt < 3 ? "failed" : "completed");
        if (attempt < 3) await b.retry("search", 2, attempt);
      }
      await b.done("search", 2, 3);
      await b.end(2);
    });
    const a = inspect("run.c.retry2", trace);
    const n = a.nodes.find((x) => x.nodeId === "search")!;
    expect(n).toMatchObject({ executionCount: 1, attemptCount: 3, scheduledRetries: 2, status: "OBSERVED_COMPLETED" });
    expect(n.attempts.map((x) => x.status)).toEqual(["retried", "retried", "completed"]);
    expect(n.attempts[0]!.reasonCode).toBe("PROVIDER_TIMEOUT");
    expect(a.counters).toMatchObject({ nodeExecutionOccurrences: 1, nodeAttempts: 3, scheduledRetries: 2, toolPhysicalInvocations: 3 });
  });

  it("7. retry scheduled but never started is reported, not invented", async () => {
    const trace = await recordRun("run.c.retry-open", async (b) => {
      await b.start("search", 1, 1);
      await b.tool("search", 1, 1, "tex.ro", "failed");
      await b.retry("search", 1, 1);
    });
    const a = inspect("run.c.retry-open", trace);
    expect(a.attempts).toHaveLength(1);
    expect(a.attempts[0]!.status).toBe("retried");
    expect(a.diagnostics.some((d) => d.code === "RETRY_NOT_STARTED")).toBe(true);
  });

  it("8. retry exhaustion: final failure after all attempts", async () => {
    const trace = await recordRun("run.c.exhausted", async (b) => {
      for (const attempt of [1, 2, 3]) {
        await b.start("search", 1, attempt);
        await b.tool("search", 1, attempt, `tex.x.${attempt}`, "failed");
        if (attempt < 3) await b.retry("search", 1, attempt);
      }
      await b.exhausted("search", 1, 3);
      await b.failed("search", 1, 3, "NODE_RETRY_EXHAUSTED");
    });
    const a = inspect("run.c.exhausted", trace);
    const n = a.nodes.find((x) => x.nodeId === "search")!;
    expect(n).toMatchObject({ attemptCount: 3, scheduledRetries: 2, status: "OBSERVED_FAILED" });
    expect(a.counters).toMatchObject({ scheduledRetries: 2, exhaustedRetries: 1 });
    expect(n.attempts[2]!.reasonCode).toBe("NODE_RETRY_EXHAUSTED");
  });

  it("9. recovery replay keeps its logical span and is not counted as a new attempt", async () => {
    const trace = await recordRun("run.c.replay", async (b) => {
      await b.start("intake", 1, 1);
      await b.recover("intake", 1, 1);
      await b.start("intake", 1, 1, "tool", true);
      await b.done("intake", 1, 1);
      await b.end(1);
    });
    const a = inspect("run.c.replay", trace);
    expect(a.counters).toMatchObject({ nodeExecutionOccurrences: 1, nodeAttempts: 1, recoveryReplayAttempts: 1 });
    expect(a.attempts.map((x) => [x.recoveryReplay, x.status])).toEqual([[false, "open"], [true, "completed"]]);
    expect(a.attempts[0]!.spanId).toBe(a.attempts[1]!.spanId);
    expect(formatAdvancedRunInspectionTimelineText(a)).toContain("(recovery replay)");
  });

  it("10. orphan Tool event (no node parent span) is canonical corruption, never normal metrics", async () => {
    const trace = await recordRun("run.c.orphan-tool", async (b) => {
      await b.start("search", 1, 1);
      await b.tool("search", 1, 1, "tex.o", "completed");
      await b.done("search", 1, 1);
      await b.end(1);
    });
    const malformed = trace.map((e) => (e.type === "tool.call.started" ? { ...e, parentSpanId: "span.not-a-node" } : e));
    const a = inspect("run.c.orphan-tool", malformed);
    expect(a.evidenceHealth).toBe("corrupt");
    expect(a.counters).toBeUndefined();
    expect(a.attempts).toEqual([]);
    expect(a.tokenUsage).toBeUndefined();
  });

  it("10b. model event without an attributable node span stays visible as unattributed evidence", async () => {
    const trace = await recordRun("run.c.orphan-model", async (b) => {
      await b.start("plan", 1, 1, "model");
      await b.done("plan", 1, 1, "model");
      await b.model("plan", 1, 1, "inv.orphan", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }, "run");
      await b.end(1);
    });
    const a = inspect("run.c.orphan-model", trace);
    expect(a.unattributedEvents.map((e) => e.type)).toEqual(["model.call.started", "model.call.completed"]);
    expect(a.attempts[0]!.modelInvocations).toBe(0);
    expect(a.counters!.modelInvocations).toBe(1);
    expect(a.diagnostics.some((d) => d.code === "UNATTRIBUTED_EVIDENCE")).toBe(true);
  });

  it("11. missing attempt metadata fails validation; no fictitious attempt is defaulted", async () => {
    const trace = await recordRun("run.c.noattempt", async (b) => {
      await b.start("search", 1, 1);
      await b.done("search", 1, 1);
      await b.end(1);
    });
    const malformed = trace.map((e) => {
      if (e.type !== "node.started") return e;
      const { attempt: _omit, ...payload } = e.payload as Record<string, unknown>;
      return { ...e, payload } as TraceEvent;
    });
    const a = inspect("run.c.noattempt", malformed);
    expect(a.evidenceHealth).toBe("corrupt");
    expect(a.attempts).toEqual([]);
    expect(a.nodes.every((n) => n.attemptCount === 0)).toBe(true);
  });

  it("12. duplicate lifecycle event (and duplicate usage-bearing completion) is corruption, never double counted", async () => {
    const trace = await recordRun("run.c.dup", async (b) => {
      await b.start("plan", 1, 1, "model");
      await b.model("plan", 1, 1, "inv.dup", { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
      await b.done("plan", 1, 1, "model");
      await b.end(1);
    });
    const i = trace.findIndex((e) => e.type === "model.call.completed");
    const duplicated = [...trace.slice(0, i + 1), trace[i]!, ...trace.slice(i + 1)].map((e, sequence) => ({ ...e, sequence }));
    expect(deriveRunMetrics({ trace: duplicated }).ok).toBe(false);
    const a = inspect("run.c.dup", duplicated);
    expect(a.evidenceHealth).toBe("corrupt");
    expect(a.tokenUsage).toBeUndefined();
  });

  it("13. corrupt span relationship (terminal event on an unopened step) fails safely", async () => {
    const trace = await recordRun("run.c.span", async (b) => {
      await b.start("search", 1, 1);
      await b.done("search", 1, 1);
      await b.end(1);
    });
    const malformed = trace.map((e) => (e.type === "node.completed" ? { ...e, payload: { ...(e.payload as object), step: 7 } } : e));
    const a = inspect("run.c.span", malformed);
    expect(a.evidenceHealth).toBe("corrupt");
    expect(a.diagnostics.some((d) => d.code === "TRACE_CORRUPT")).toBe(true);
  });

  it("14. approval waitpoint and continuation remain one attempt", async () => {
    const trace = await recordRun("run.c.approval", async (b) => {
      await b.start("require_approval", 1, 1, "approval");
      await b.approval("require_approval", 1, "approval.c.001");
      await b.done("require_approval", 1, 1, "approval", "approval_resolution");
      await b.end(1);
    });
    const a = inspect("run.c.approval", trace);
    expect(a.attempts).toHaveLength(1);
    expect(a.attempts[0]).toMatchObject({ status: "completed", approvalId: "approval.c.001" });
    // No authoritative ApprovalRecord: status is not fabricated from the Trace.
    expect(a.nodes[0]!.approvalStatus).toBeUndefined();
    expect(a.diagnostics.some((d) => d.code === "APPROVAL_RECORD_MISSING")).toBe(true);
  });

  it("15. node started without terminal event stays open/incomplete", async () => {
    const trace = await recordRun("run.c.open", async (b) => {
      await b.start("search", 1, 1);
    });
    const a = inspect("run.c.open", trace);
    expect(a.attempts[0]!.status).toBe("open");
    expect(a.attempts[0]!.finishedAt).toBeUndefined();
    expect(a.nodes[0]!.status).toBe("OBSERVED_STARTED");
    expect(a.authoritativeStatus).toBe("UNKNOWN");
  });
});

// --- Token accounting ---

describe("Sprint 28C: token accounting completeness", () => {
  const modelRun = async (runId: string, calls: Array<{ usage?: Record<string, number> } | "failed" | "open">) =>
    recordRun(runId, async (b) => {
      await b.start("plan", 1, 1, "model");
      for (const [i, c] of calls.entries()) await b.model("plan", 1, 1, `inv.${i}`, c);
      if (!calls.includes("open")) {
        await b.done("plan", 1, 1, "model");
        await b.end(1);
      }
    });
  const full = { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };

  it("no model calls: complete, zero invocations, no implied missing usage", async () => {
    const trace = await recordRun("run.t.none", async (b) => { await b.start("s", 1, 1); await b.done("s", 1, 1); await b.end(1); });
    const a = inspect("run.t.none", trace);
    expect(a.tokenUsage).toMatchObject({ status: "complete", modelInvocations: 0 });
    expect(formatTokenUsageText(a.tokenUsage)).toBe("COMPLETE (0 model invocations)");
  });

  it("one call with full usage: complete", async () => {
    const a = inspect("run.t.full", await modelRun("run.t.full", [full]));
    expect(a.tokenUsage).toMatchObject({ status: "complete", inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  });

  it("one call without usage: unavailable, totals unknown (not 0)", async () => {
    const a = inspect("run.t.nousage", await modelRun("run.t.nousage", [{}]));
    expect(a.tokenUsage!.status).toBe("unavailable");
    expect(a.tokenUsage!.totalTokens).toBeUndefined();
    const text = formatAdvancedRunInspectionNodesText(a);
    expect(text).toContain("Token Accounting: NOT RECORDED (0/1 invocations with usage)");
    expect(text).not.toMatch(/total=0/);
  });

  it("two calls, one with usage: PARTIAL with known recorded totals", async () => {
    const a = inspect("run.t.partial", await modelRun("run.t.partial", [full, {}]));
    expect(a.tokenUsage).toMatchObject({ status: "partial", callsWithUsage: 1, modelInvocations: 2, knownTotalTokens: 120 });
    expect(a.tokenUsage!.totalTokens).toBeUndefined();
    expect(formatTokenUsageText(a.tokenUsage)).toContain("PARTIAL (known recorded totals: input=100, output=20, total=120");
  });

  it("failed call without usage makes accounting partial", async () => {
    const a = inspect("run.t.failed", await modelRun("run.t.failed", [full, "failed"]));
    expect(a.tokenUsage).toMatchObject({ status: "partial", callsFailed: 1, knownTotalTokens: 120 });
  });

  it("missing completion event leaves usage unknown", async () => {
    const a = inspect("run.t.open", await modelRun("run.t.open", [full, "open"]));
    expect(a.tokenUsage).toMatchObject({ status: "partial", modelInvocations: 2, callsCompleted: 1 });
  });

  it("missing totalTokens with known input/output: total unknown, not derived", async () => {
    const a = inspect("run.t.nototal", await modelRun("run.t.nototal", [{ usage: { inputTokens: 7, outputTokens: 3 } }]));
    expect(a.tokenUsage).toMatchObject({ status: "partial", inputTokens: 7, outputTokens: 3, knownTotalTokens: 0 });
    expect(a.tokenUsage!.totalTokens).toBeUndefined();
    expect(formatTokenUsageText(a.tokenUsage)).toContain("PARTIAL");
  });

  it("node-level and run-level totals agree, and agree with canonical deriveRunMetrics", async () => {
    const { tracesByRunId } = await buildCanonicalTraceFixtures();
    for (const [runId, trace] of Object.entries(tracesByRunId)) {
      if (validateTrace(trace).issues.length > 0) continue;
      const a = inspect(runId, trace);
      const nodesKnown = a.nodes.reduce((n, x) => n + (x.tokenUsage?.knownTotalTokens ?? 0), 0);
      expect(nodesKnown).toBe(a.tokenUsage!.knownTotalTokens);
      const m = deriveRunMetrics({ trace });
      expect(m.ok).toBe(true);
      if (!m.ok) continue;
      // No canonical fixture has unfinished model calls, so completeness must match exactly.
      expect(a.tokenUsage!.status).toBe(m.metrics.tokenUsage.status);
      expect(a.tokenUsage!.knownTotalTokens).toBe(m.metrics.tokenUsage.knownTotalTokens);
      expect(a.tokenUsage!.totalTokens ?? null).toBe(m.metrics.tokenUsage.totalTokens);
    }
  });

  it("summarizeTokenUsage counts invocations, never lifecycle events", async () => {
    const trace = await modelRun("run.t.events", [full]);
    expect(summarizeTokenUsage(trace).modelInvocations).toBe(1);
  });
});

// --- Requirement diagnostics ---

describe("Sprint 28C: independent requirement diagnostics", () => {
  const verified = createVerifiedRegistrationEvidenceForCompany("northstar-commerce").company_research!;
  const statusOf = (report: ReturnType<typeof projectIntegrationDiagnostics>, ref: string) => report.requirements.find((r) => r.requiredRef === ref)?.status;
  const diagnose = (registrationEvidence: typeof verified | undefined, manifest: Record<string, unknown> = CANONICAL_NORTHSTAR_MANIFEST, pack = COMPANY_RESEARCH_PACK) =>
    projectIntegrationDiagnostics({ companyManifest: manifest, pack, registrationEvidence });
  const tool = `${COMPANY_RESEARCH_PACK.manifest.requirements.toolRefs[0]!.id}@${COMPANY_RESEARCH_PACK.manifest.requirements.toolRefs[0]!.version}`;
  const policy = COMPANY_RESEARCH_PACK.manifest.requirements.modelPolicyRefs[0]!;
  const evalProfile = COMPANY_RESEARCH_PACK.manifest.verification.evalProfileRef;
  const cap = COMPANY_RESEARCH_PACK.manifest.requirements.modelCapabilities[0]!;

  it("verified compatible pack: READY, each evidence-backed requirement SATISFIED, unverifiable ones honest", () => {
    const r = diagnose(verified);
    expect(r.status).toBe("READY");
    for (const req of r.requirements) {
      const expected = req.category === "integration" || req.name === "Preliminary Permissions" ? "NOT_VERIFIED" : "SATISFIED";
      expect([req.name, req.status]).toEqual([req.name, expected]);
      if (req.status === "SATISFIED") expect(req.diagnostic).toBeDefined();
    }
  });

  it("missing Tool + missing Model Policy + missing Eval profile are all reported simultaneously", () => {
    const r = diagnose({ ...verified, registeredTools: verified.registeredTools!.filter((t) => `${t.id}@${t.version}` !== tool), registeredModelPolicies: verified.registeredModelPolicies!.filter((p) => p !== policy), registeredEvalProfiles: [] });
    expect(r.status).toBe("BLOCKED");
    expect(statusOf(r, tool)).toBe("MISSING");
    expect(statusOf(r, policy)).toBe("MISSING");
    expect(statusOf(r, evalProfile)).toBe("MISSING");
  });

  it("missing Tool + unverifiable Model Capability + registered Eval profile", () => {
    const r = diagnose({ ...verified, registeredTools: verified.registeredTools!.filter((t) => `${t.id}@${t.version}` !== tool), registeredModelAdapters: undefined, modelAdapters: undefined });
    expect(r.status).toBe("BLOCKED");
    expect(statusOf(r, tool)).toBe("MISSING");
    expect(statusOf(r, cap)).toBe("NOT_VERIFIED");
    expect(statusOf(r, evalProfile)).toBe("SATISFIED");
  });

  it("missing Tool + missing Model Policy only", () => {
    const r = diagnose({ ...verified, registeredTools: [], registeredModelPolicies: [] });
    expect(r.requirements.filter((x) => x.category === "tool").every((x) => x.status === "MISSING")).toBe(true);
    expect(r.requirements.filter((x) => x.category === "model_policy").every((x) => x.status === "MISSING")).toBe(true);
    expect(statusOf(r, evalProfile)).toBe("SATISFIED");
  });

  it("unsupported adapter with valid unrelated requirements", () => {
    const r = diagnose({ ...verified, registeredModelAdapters: [{ id: "aao.native-model", version: "1.0.0", capabilities: [] }] });
    expect(r.status).toBe("BLOCKED");
    expect(statusOf(r, cap)).toBe("INCOMPATIBLE");
    expect(statusOf(r, tool)).toBe("SATISFIED");
    expect(statusOf(r, policy)).toBe("SATISFIED");
  });

  it("missing snapshot evidence: everything evidence-dependent is NOT_VERIFIED, never MISSING", () => {
    const r = diagnose(undefined);
    expect(r.status).toBe("NOT_VERIFIED");
    for (const ref of [tool, policy, evalProfile, cap]) expect(statusOf(r, ref)).toBe("NOT_VERIFIED");
  });

  it("missing Eval registration evidence is NOT_VERIFIED, not a confirmed absence", () => {
    const r = diagnose({ ...verified, registeredEvalProfiles: undefined });
    expect(statusOf(r, evalProfile)).toBe("NOT_VERIFIED");
    expect(r.status).toBe("NOT_VERIFIED");
    expect(r.reasonCode).toBe("PACK_EVIDENCE_UNAVAILABLE");
  });

  it("configured but unverified integration", () => {
    const r = diagnose(verified);
    const slot = r.requirements.find((x) => x.category === "integration")!;
    expect(slot.status).toBe("NOT_VERIFIED");
    expect(slot.diagnostic).toContain("not verified");
  });

  it("disabled pack: proof requirement INCOMPATIBLE, unrelated evidence still independently SATISFIED", () => {
    const r = diagnose(verified, { ...CANONICAL_NORTHSTAR_MANIFEST, enabledProofs: ["operational_request"] });
    expect(r.status).toBe("BLOCKED");
    expect(r.requirements.find((x) => x.name.startsWith("Proof Enabled"))!.status).toBe("INCOMPATIBLE");
    expect(statusOf(r, tool)).toBe("SATISFIED");
  });

  it("workflow fingerprint mismatch", () => {
    const r = diagnose({ ...verified, workflow: { ...verified.workflow!, planFingerprint: "0".repeat(64) } });
    expect(r.status).toBe("BLOCKED");
    expect(r.requirements.find((x) => x.category === "workflow")!.status).toBe("INCOMPATIBLE");
    expect(statusOf(r, tool)).toBe("SATISFIED");
  });

  it("approval role configuration is checked independently of any Run decision", () => {
    // Company config validation already rejects an enabled approval proof without an
    // approver role, so a valid manifest can only show the configured case.
    const opsEvidence = createVerifiedRegistrationEvidenceForCompany("northstar-commerce").operational_request!;
    const r = diagnose(opsEvidence, CANONICAL_NORTHSTAR_MANIFEST, OPERATIONAL_REQUEST_PACK);
    const approval = r.requirements.find((x) => x.category === "approval")!;
    expect(approval.status).toBe("SATISFIED");
    expect(approval.diagnostic).toContain("defined in company governance");
  });

  it("unavailable source: explicit INSPECTION_SOURCE_UNAVAILABLE", async () => {
    const { getIntegrationDiagnostics: _withheld, ...rest } = await createCanonicalDemoInspectionSource();
    const service = createOperatorInspectionService(rest);
    await expect(service.getIntegrationDiagnostics("northstar-commerce", COMPANY_RESEARCH_PACK.identity)).rejects.toMatchObject({ code: "INSPECTION_SOURCE_UNAVAILABLE" });
  });
});

// --- Source integrity and read-only safety ---

describe("Sprint 28C: evidence source integrity", () => {
  it("a redacted RunInspection-only source never yields a fabricated advanced analysis", async () => {
    const full = await createCanonicalDemoInspectionSource({ includeExtendedRuns: true });
    const redactedOnly: OperatorInspectionSource = { getProvenance: full.getProvenance, getRunInspection: full.getRunInspection };
    const service = createOperatorInspectionService(redactedOnly);
    await expect(service.getRunInspection("run.northstar.cr.001")).resolves.toBeDefined();
    await expect(service.getAdvancedRunInspection("run.northstar.cr.001")).rejects.toMatchObject({ code: "INSPECTION_SOURCE_UNAVAILABLE" });
    await expect(service.getAdvancedRunInspection("run.unknown.999")).rejects.toMatchObject({ code: "INSPECTION_NOT_FOUND" });
  });

  it("the service contains no double-cast reconstruction of canonical records", () => {
    const src = readFileSync(join(__dirname, "../src/service.ts"), "utf8");
    expect(src).not.toMatch(/as unknown as readonly (TraceEvent|ApprovalRecord)\[\]/);
  });

  it("valid canonical evidence succeeds through the trusted source", async () => {
    const service = createOperatorInspectionService(await createCanonicalDemoInspectionSource({ includeExtendedRuns: true }));
    const a = await service.getAdvancedRunInspection("run.northstar.cr.retry");
    expect(a.counters).toMatchObject({ nodeAttempts: 2, nodeExecutionOccurrences: 1, scheduledRetries: 1, toolPhysicalInvocations: 2 });
  });

  it("incomplete Trace stays incomplete and Run stays UNKNOWN without authoritative state", async () => {
    const { tracesByRunId } = await buildCanonicalTraceFixtures();
    const a = inspect("run.arbor.cr.incomplete", tracesByRunId["run.arbor.cr.incomplete"]);
    expect(a.authoritativeStatus).toBe("UNKNOWN");
    expect(a.attempts.every((x) => x.status === "open")).toBe(true);
    expect(a.evaluations).toEqual([]);
  });
});

describe("Sprint 28C: read-only purity (measured)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("inspection performs zero writes, network calls, or mutations of its evidence", async () => {
    const { tracesByRunId } = await buildCanonicalTraceFixtures();
    const backing = createInMemoryTraceStore();
    for (const trace of Object.values(tracesByRunId)) for (const e of trace) await backing.append(e);
    const appendSpy = vi.fn(backing.append);
    const traceStore: TraceStore = { ...backing, append: appendSpy };
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const verified = createVerifiedRegistrationEvidenceForCompany("northstar-commerce");
    const knownRuns = Object.keys(CANONICAL_RUN_RECORDS).map((runId) => ({ runId, authoritativeRun: CANONICAL_RUN_RECORDS[runId] }));
    const inputs = { manifest: CANONICAL_NORTHSTAR_MANIFEST, verified, approvals: CANONICAL_APPROVAL_RECORDS, workflows: CANONICAL_WORKFLOWS, runs: CANONICAL_RUN_RECORDS };
    const before = JSON.stringify(inputs);
    const traceBefore = JSON.stringify(await Promise.all(Object.keys(tracesByRunId).map((id) => backing.getRunTrace(id))));

    const service = createOperatorInspectionService(createEvidenceBackedInspectionSource({
      companies: [{ manifest: CANONICAL_NORTHSTAR_MANIFEST, registrationEvidenceByPack: verified }],
      capabilityPacks: [COMPANY_RESEARCH_PACK, OPERATIONAL_REQUEST_PACK],
      workflows: CANONICAL_WORKFLOWS,
      knownRuns,
      traceStore,
      approvalRecords: CANONICAL_APPROVAL_RECORDS,
    }));
    await service.getOverview();
    await service.listKnownRuns();
    for (const { runId } of knownRuns) {
      await service.getRunInspection(runId);
      await service.getAdvancedRunInspection(runId);
    }
    await service.getIntegrationDiagnostics("northstar-commerce", COMPANY_RESEARCH_PACK.identity);

    expect({
      traceWrites: appendSpy.mock.calls.length,
      networkCalls: fetchSpy.mock.calls.length,
      inputMutations: JSON.stringify(inputs) === before ? 0 : 1,
      traceMutations: JSON.stringify(await Promise.all(Object.keys(tracesByRunId).map((id) => backing.getRunTrace(id)))) === traceBefore ? 0 : 1,
    }).toEqual({ traceWrites: 0, networkCalls: 0, inputMutations: 0, traceMutations: 0 });
  });

  it("by construction the package cannot invoke models, Tools, approvals, workflows, or Evals", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
    const executionPackages = ["@aao/runtime", "@aao/model-runtime", "@aao/tool-runtime", "@aao/agent-runtime", "@aao/approval", "@aao/evaluation", "@aao/durability", "@aao/integration-public-web", "@aao/integration-documents", "@aao/adapters"];
    expect(Object.keys(pkg.dependencies).filter((d) => executionPackages.includes(d))).toEqual([]);
    const srcDir = join(__dirname, "../src");
    const imports = readdirSync(srcDir).flatMap((f) => [...readFileSync(join(srcDir, f), "utf8").matchAll(/from "(@aao\/[^"]+)"/g)].map((m) => m[1]!));
    expect(imports.filter((i) => executionPackages.includes(i))).toEqual([]);
  });
});
