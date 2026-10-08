import { RunMetricsSchema, type FailureCategory, type MetricCompleteness, type ModelPricingProfile, type NodeAttemptMetrics, type RunMetrics, type TraceEvent } from "@aao/contracts";
import { checkTraceEvent } from "../content-policy.js";
import { validateTrace, type TraceDiagnostic } from "../validator.js";
import { matchPricingProfile, modelCallCostNanos, validatePricingProfiles } from "./pricing.js";

/**
 * Trace → validation → RunMetrics (ADR-021, docs/architecture/metrics.md).
 *
 * A pure, deterministic projection: no clock, randomness, I/O, or external
 * call. The same Trace and the same pricing profiles always produce
 * deep-equal RunMetrics. It reads only Trace evidence and explicit pricing;
 * it never reads Audit, Durability, or Runtime state, and nothing in AAO
 * reads its result to make an execution decision.
 *
 * Preconditions: the Trace must pass `validateTrace`. An invalid Trace yields
 * a bounded `METRICS_INVALID_TRACE` diagnostic and no metrics at all — never
 * normal-looking numbers from corrupt evidence. A valid Trace whose
 * recorder reported this Run degraded (`traceHealth`, e.g. the recorder's
 * `runHealth(runId)`) yields `traceQuality: partial`.
 */
export type RunMetricsProjection =
  | { ok: true; quality: "complete" | "partial"; metrics: RunMetrics }
  | { ok: false; quality: "invalid"; code: "METRICS_INVALID_TRACE"; traceIssues: TraceDiagnostic[] }
  | { ok: false; quality: "invalid"; code: "METRICS_INVALID_PRICING_PROFILE" | "METRICS_COST_OVERFLOW" };

export interface DeriveRunMetricsParams {
  /** The Run's canonical Trace, in sequence order (e.g. `TraceStore.getRunTrace`). */
  trace: readonly unknown[];
  /** Trusted host pricing configuration. Never taken from Trace, model, Tool, or workflow data. */
  pricing?: readonly ModelPricingProfile[];
  /** The recorder's completeness report for this Run, when known. Reused, never re-derived. */
  traceHealth?: { status: "healthy" | "degraded" };
}

type P = Record<string, unknown>;
const p = (event: TraceEvent) => event.payload as P;
const ms = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from));
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sortedCounts<K extends string>(counts: Map<K, number>, field: string): Array<Record<string, K | number>> {
  return [...counts.entries()].sort(([a], [b]) => cmp(a, b)).map(([key, value]) => ({ [field]: key, count: value }));
}

function increment<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

export function deriveRunMetrics(params: DeriveRunMetricsParams): RunMetricsProjection {
  const pricing = validatePricingProfiles(params.pricing);
  if (!pricing.ok) return { ok: false, quality: "invalid", code: "METRICS_INVALID_PRICING_PROFILE" };
  const validation = validateTrace(params.trace);
  if (!validation.valid) return { ok: false, quality: "invalid", code: "METRICS_INVALID_TRACE", traceIssues: validation.issues };
  const events = params.trace.map((raw) => (checkTraceEvent(raw) as { ok: true; event: TraceEvent }).event);
  const started = events[0]!;
  const startedPayload = p(started);

  // --- Run lifecycle and latency: run.started → terminal event, never checkpoint timing. ---
  const terminal = events.find((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled");
  const endedAt = terminal?.occurredAt ?? null;
  const durationMs = terminal ? ms(started.occurredAt, terminal.occurredAt) : null;

  // --- Node attempts, paired by attempt span (node + step + attempt). A recovery replay keeps its logical span. ---
  interface Attempt { record: NodeAttemptMetrics; endAt?: string; waitStart?: string; waitRef?: string; waitEnd?: string }
  const attempts: Attempt[] = [];
  const openBySpan = new Map<string, Attempt>();
  const nodeKinds = new Map<string, string>();
  for (const event of events) {
    const payload = p(event);
    if (event.type === "node.started") {
      nodeKinds.set(event.nodeId!, payload.kind as string);
      const attempt: Attempt = { record: { nodeId: event.nodeId!, kind: payload.kind as NodeAttemptMetrics["kind"], step: payload.step as number, attempt: payload.attempt as number, recoveryReplay: payload.recoveryReplay === true, outcome: "open", startedAt: event.occurredAt, durationMs: null, waitDurationMs: null } };
      attempts.push(attempt);
      openBySpan.set(event.spanId, attempt);
      continue;
    }
    if (event.type === "approval.resolved") {
      const waiting = attempts.find((candidate) => candidate.waitRef === payload.approvalId && candidate.waitEnd === undefined);
      if (waiting) waiting.waitEnd = event.occurredAt;
      continue;
    }
    const outcome = ({ "node.completed": "completed", "node.failed": "failed", "node.waiting": "waiting", "retry.scheduled": "retried" } as const)[event.type as "node.completed"];
    if (outcome === undefined) continue;
    const attempt = openBySpan.get(event.spanId);
    if (!attempt) continue;
    attempt.endAt ??= event.occurredAt;
    attempt.record.outcome = outcome;
    if (event.type === "node.waiting") { attempt.waitStart = event.occurredAt; attempt.waitRef = payload.referenceId as string; }
  }
  for (const attempt of attempts) {
    if (attempt.endAt !== undefined) attempt.record.durationMs = ms(attempt.record.startedAt, attempt.endAt);
    if (attempt.waitStart !== undefined && attempt.waitEnd !== undefined) attempt.record.waitDurationMs = ms(attempt.waitStart, attempt.waitEnd);
  }
  const waited = attempts.filter((attempt) => attempt.waitStart !== undefined);
  const approvalWaitDurationMs = waited.every((attempt) => attempt.record.waitDurationMs !== null) ? sum(waited.map((attempt) => attempt.record.waitDurationMs!)) : null;

  const ofType = (type: string) => events.filter((event) => event.type === type);
  const nodeIds = [...new Set(attempts.map((attempt) => attempt.record.nodeId))].sort(cmp);
  const byNode = nodeIds.map((nodeId) => {
    const mine = attempts.filter((attempt) => attempt.record.nodeId === nodeId);
    const durations = mine.map((attempt) => attempt.record.durationMs);
    const count = (type: string) => events.filter((event) => event.type === type && event.nodeId === nodeId).length;
    return {
      nodeId,
      kind: nodeKinds.get(nodeId) as NodeAttemptMetrics["kind"],
      executions: new Set(mine.map((attempt) => attempt.record.step)).size,
      attempts: mine.filter((attempt) => !attempt.record.recoveryReplay).length,
      completed: count("node.completed"),
      failed: count("node.failed"),
      waits: count("node.waiting"),
      attemptDurationMsTotal: durations.every((value) => value !== null) ? sum(durations as number[]) : null,
    };
  });

  // --- Run status as evidenced by the Trace. ---
  const unresolvedWait = waited.some((attempt) => attempt.waitEnd === undefined);
  const runStatus: RunMetrics["runStatus"] = terminal
    ? ({ "run.completed": "COMPLETED", "run.failed": "FAILED", "run.cancelled": "CANCELLED" } as const)[terminal.type as "run.completed"]
    : unresolvedWait ? "WAITING_FOR_APPROVAL" : "RUNNING";

  // --- Retries and failures: explicit retry evidence, existing taxonomy only. ---
  const retriesScheduled = ofType("retry.scheduled");
  const failedAttemptCategories = new Map<FailureCategory, number>();
  const failedAttemptCodes = new Map<string, number>();
  let uncategorizedAttempts = 0;
  const failedAttemptEvents = events.filter((event) => event.type === "retry.scheduled" || event.type === "node.failed");
  for (const event of failedAttemptEvents) {
    const payload = p(event);
    const category = payload.category as FailureCategory | undefined;
    if (category) increment(failedAttemptCategories, category);
    else uncategorizedAttempts += 1;
    // The most specific existing code: the attempt cause, else the executor's own code, else the Runtime code.
    const code = event.type === "retry.scheduled" ? (payload.causeCode as string) : ((payload.causeCode as string | undefined) ?? (payload.executorFailure as { code?: string } | undefined)?.code ?? (payload.code as string));
    increment(failedAttemptCodes, code);
  }
  const runFailed = terminal?.type === "run.failed" ? p(terminal) : undefined;

  // --- Model calls, token usage, and modelled cost. ---
  type Identity = { provider: string; model: string; revision?: string } | null;
  const identityByCall = new Map<string, Identity>();
  const callKey = (payload: P) => `${payload.invocationId as string}|${payload.attempt as number}`;
  const identityKey = (identity: Identity) => (identity ? JSON.stringify([identity.provider, identity.model, identity.revision ?? null]) : "~unregistered");
  interface ModelBucket { identity: Identity; callsStarted: number; callsCompleted: number; callsFailed: number; callsWithoutUsage: number; knownInputTokens: number; knownOutputTokens: number; knownTotalTokens: number; pricedCalls: number; unpricedCalls: number; cost: bigint }
  const buckets = new Map<string, ModelBucket>();
  const bucket = (identity: Identity) => {
    const key = identityKey(identity);
    let entry = buckets.get(key);
    if (!entry) { entry = { identity, callsStarted: 0, callsCompleted: 0, callsFailed: 0, callsWithoutUsage: 0, knownInputTokens: 0, knownOutputTokens: 0, knownTotalTokens: 0, pricedCalls: 0, unpricedCalls: 0, cost: 0n }; buckets.set(key, entry); }
    return entry;
  };
  const tokens = { completed: 0, failed: 0, withUsage: 0, withoutUsage: 0, input: 0, output: 0, total: 0, inputMissing: false, outputMissing: false, totalMissing: false, anyReported: false };
  const unpricedReasons = new Map<string, number>();
  const usedProfiles = new Map<string, ModelPricingProfile>();
  let pricedCalls = 0;
  let knownCost = 0n;
  for (const event of events) {
    const payload = p(event);
    if (event.type === "model.call.started") {
      const identity = (payload.modelIdentity as Identity | undefined) ?? null;
      identityByCall.set(callKey(payload), identity);
      bucket(identity).callsStarted += 1;
    } else if (event.type === "model.call.failed") {
      tokens.failed += 1;
      const entry = bucket(identityByCall.get(callKey(payload)) ?? null);
      entry.callsFailed += 1;
      entry.unpricedCalls += 1;
      increment(unpricedReasons, "CALL_FAILED");
    } else if (event.type === "model.call.completed") {
      tokens.completed += 1;
      const identity = identityByCall.get(callKey(payload)) ?? (payload.modelIdentity as Identity | undefined) ?? null;
      const entry = bucket(identity);
      entry.callsCompleted += 1;
      const usage = (payload.usage ?? {}) as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined) tokens.anyReported = true;
      if (usage.inputTokens === undefined) tokens.inputMissing = true; else { tokens.input += usage.inputTokens; entry.knownInputTokens += usage.inputTokens; }
      if (usage.outputTokens === undefined) tokens.outputMissing = true; else { tokens.output += usage.outputTokens; entry.knownOutputTokens += usage.outputTokens; }
      if (usage.totalTokens === undefined) tokens.totalMissing = true; else { tokens.total += usage.totalTokens; entry.knownTotalTokens += usage.totalTokens; }
      const hasUsage = usage.inputTokens !== undefined && usage.outputTokens !== undefined;
      if (hasUsage) tokens.withUsage += 1; else { tokens.withoutUsage += 1; entry.callsWithoutUsage += 1; }
      const profile = identity ? matchPricingProfile(pricing.profiles, identity) : undefined;
      const reason = identity === null ? "MODEL_IDENTITY_MISSING" : profile === undefined ? "PRICING_PROFILE_NOT_FOUND" : !hasUsage ? "USAGE_MISSING" : undefined;
      if (reason !== undefined) { entry.unpricedCalls += 1; increment(unpricedReasons, reason); continue; }
      const cost = modelCallCostNanos(profile!, usage.inputTokens!, usage.outputTokens!);
      entry.pricedCalls += 1;
      entry.cost += cost;
      pricedCalls += 1;
      knownCost += cost;
      usedProfiles.set(`${profile!.profileId}@${profile!.profileVersion}`, profile!);
    }
  }
  const modelCalls = tokens.completed + tokens.failed;
  const complete = (missing: boolean) => tokens.failed === 0 && !missing;
  const tokenStatus: MetricCompleteness = modelCalls === 0 || (complete(tokens.inputMissing) && complete(tokens.outputMissing) && complete(tokens.totalMissing)) ? "complete" : tokens.anyReported ? "partial" : "unavailable";
  const unpricedCalls = modelCalls - pricedCalls;
  // A cost beyond exact JSON-integer range is refused, never clamped or zeroed.
  if (knownCost > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, quality: "invalid", code: "METRICS_COST_OVERFLOW" };
  const costStatus: MetricCompleteness = modelCalls === 0 || unpricedCalls === 0 ? "complete" : pricedCalls === 0 ? "unavailable" : "partial";
  const knownCostNumber = Number(knownCost);

  // --- Tools: physical handler invocations vs logical executions (distinct toolExecutionId). ---
  interface ToolBucket { toolId: string; toolVersion: string; physicalInvocations: number; logical: Set<string>; completed: number; failed: number; blocked: number }
  const toolBuckets = new Map<string, ToolBucket>();
  for (const event of events) {
    if (!event.type.startsWith("tool.call.")) continue;
    const payload = p(event);
    const ref = payload.toolRef as { id: string; version: string };
    const key = JSON.stringify([ref.id, ref.version]);
    let entry = toolBuckets.get(key);
    if (!entry) { entry = { toolId: ref.id, toolVersion: ref.version, physicalInvocations: 0, logical: new Set(), completed: 0, failed: 0, blocked: 0 }; toolBuckets.set(key, entry); }
    if (event.type === "tool.call.started") { entry.physicalInvocations += 1; entry.logical.add(payload.toolExecutionId as string); }
    else if (event.type === "tool.call.completed") entry.completed += 1;
    else if (event.type === "tool.call.failed") entry.failed += 1;
    else if (event.type === "tool.call.blocked") entry.blocked += 1;
  }
  const byTool = [...toolBuckets.entries()].sort(([a], [b]) => cmp(a, b)).map(([, entry]) => ({ toolId: entry.toolId, toolVersion: entry.toolVersion, physicalInvocations: entry.physicalInvocations, logicalExecutions: entry.logical.size, completed: entry.completed, failed: entry.failed, blocked: entry.blocked }));

  // --- Approvals (Trace chronology; Audit stays the accountability record). ---
  const requestedIds = new Set(ofType("approval.requested").map((event) => p(event).approvalId as string));
  const resolutions = ofType("approval.resolved");
  const resolvedIds = new Set(resolutions.map((event) => p(event).approvalId as string));
  const resolvedWith = (status: string) => resolutions.filter((event) => p(event).status === status).length;

  const lastStateUpdate = [...events].reverse().find((event) => event.type === "state.updated");
  const release = (startedPayload.release ?? {}) as { releaseId?: string; gitSha?: string; environment?: string };
  const degraded = params.traceHealth?.status === "degraded";

  const metrics: RunMetrics = {
    schemaVersion: 1,
    runId: started.runId,
    traceId: started.traceId,
    workflowId: started.workflowId,
    workflowVersion: started.workflowVersion,
    dimensions: {
      ...(typeof startedPayload.reliabilityPolicyFingerprint === "string" ? { reliabilityPolicyFingerprint: startedPayload.reliabilityPolicyFingerprint } : {}),
      ...(release.releaseId ? { releaseId: release.releaseId } : {}),
      ...(release.gitSha ? { gitSha: release.gitSha } : {}),
      ...(release.environment ? { environment: release.environment } : {}),
    },
    runStatus,
    traceQuality: { status: degraded ? "partial" : "complete", issues: degraded ? [{ code: "METRICS_INCOMPLETE_TRACE" }] : [] },
    startedAt: started.occurredAt,
    endedAt,
    durationMs,
    approvalWaitDurationMs,
    durationExcludingApprovalWaitMs: durationMs !== null && approvalWaitDurationMs !== null ? Math.max(0, durationMs - approvalWaitDurationMs) : null,
    steps: terminal ? (p(terminal).steps as number) : null,
    nodes: {
      executions: new Set(attempts.map((attempt) => `${attempt.record.nodeId}|${attempt.record.step}`)).size,
      attempts: attempts.filter((attempt) => !attempt.record.recoveryReplay).length,
      recoveryReplayAttempts: attempts.filter((attempt) => attempt.record.recoveryReplay).length,
      completed: ofType("node.completed").length,
      failed: ofType("node.failed").length,
      waiting: ofType("node.waiting").length,
      attemptDetails: attempts.map((attempt) => attempt.record),
      byNode,
    },
    retries: { scheduled: retriesScheduled.length, exhausted: ofType("retry.exhausted").length, nodesRetried: new Set(retriesScheduled.map((event) => `${event.nodeId}|${p(event).step as number}`)).size },
    models: {
      callsStarted: ofType("model.call.started").length,
      callsCompleted: tokens.completed,
      callsFailed: tokens.failed,
      byModel: [...buckets.entries()].sort(([a], [b]) => cmp(a, b)).map(([, entry]) => ({ identity: entry.identity, callsStarted: entry.callsStarted, callsCompleted: entry.callsCompleted, callsFailed: entry.callsFailed, callsWithoutUsage: entry.callsWithoutUsage, knownInputTokens: entry.knownInputTokens, knownOutputTokens: entry.knownOutputTokens, knownTotalTokens: entry.knownTotalTokens, pricedCalls: entry.pricedCalls, unpricedCalls: entry.unpricedCalls, knownEstimatedCostNanos: Number(entry.cost) })),
    },
    agents: { executions: ofType("agent.started").length, iterations: ofType("agent.iteration.completed").length, completed: ofType("agent.completed").length, failed: ofType("agent.failed").length },
    tools: { physicalInvocations: sum(byTool.map((tool) => tool.physicalInvocations)), logicalExecutions: new Set(ofType("tool.call.started").map((event) => p(event).toolExecutionId as string)).size, completed: sum(byTool.map((tool) => tool.completed)), failed: sum(byTool.map((tool) => tool.failed)), blocked: sum(byTool.map((tool) => tool.blocked)), byTool },
    approvals: { requested: requestedIds.size, approved: resolvedWith("approved"), rejected: resolvedWith("rejected"), expired: resolvedWith("expired"), cancelled: resolvedWith("cancelled"), pending: [...requestedIds].filter((id) => !resolvedIds.has(id)).length },
    durability: { checkpointsCreated: ofType("checkpoint.created").length, recoveryStarts: ofType("recovery.started").length, recoveryReplays: ofType("recovery.replayed").length, reusedOutcomes: ofType("recovery.outcome_reused").length, recoveryBlocks: ofType("recovery.blocked").length, recoveryCompletions: ofType("recovery.completed").length },
    cancellation: { requested: ofType("cancellation.requested").length > 0, applied: ofType("cancellation.applied").length > 0 },
    // The terminal Run event states the final revision; it does not depend on every state.updated having been recorded.
    state: { updates: ofType("state.updated").length, finalStateRevision: terminal ? (p(terminal).stateRevision as number) : lastStateUpdate ? (p(lastStateUpdate).revisionAfter as number) : (startedPayload.initialStateRevision as number) },
    tokenUsage: {
      status: tokenStatus,
      modelCallsCompleted: tokens.completed,
      modelCallsFailed: tokens.failed,
      callsWithUsage: tokens.withUsage,
      callsWithoutUsage: tokens.withoutUsage,
      inputTokens: complete(tokens.inputMissing) ? tokens.input : null,
      outputTokens: complete(tokens.outputMissing) ? tokens.output : null,
      totalTokens: complete(tokens.totalMissing) ? tokens.total : null,
      knownInputTokens: tokens.input,
      knownOutputTokens: tokens.output,
      knownTotalTokens: tokens.total,
    },
    cost: {
      status: costStatus,
      currency: pricing.currency,
      estimatedCostNanos: costStatus === "complete" ? knownCostNumber : null,
      knownEstimatedCostNanos: knownCostNumber,
      pricedCalls,
      unpricedCalls,
      unpricedReasons: sortedCounts(unpricedReasons, "reason") as RunMetrics["cost"]["unpricedReasons"],
      pricingProfiles: [...usedProfiles.keys()].sort(cmp).map((key) => ({ profileId: usedProfiles.get(key)!.profileId, profileVersion: usedProfiles.get(key)!.profileVersion })),
    },
    failures: {
      failedAttempts: failedAttemptEvents.length,
      uncategorizedAttempts,
      byCategory: sortedCounts(failedAttemptCategories, "category") as RunMetrics["failures"]["byCategory"],
      byCode: sortedCounts(failedAttemptCodes, "code") as RunMetrics["failures"]["byCode"],
      detectedEvents: ofType("failure.detected").length,
      runFailure: runFailed ? { code: runFailed.code as string, ...(runFailed.category ? { category: runFailed.category as FailureCategory } : {}) } : null,
    },
  };
  // Self-check: the projection only ever emits a contract-valid, JSON-safe result.
  return { ok: true, quality: metrics.traceQuality.status, metrics: RunMetricsSchema.parse(metrics) as RunMetrics };
}
