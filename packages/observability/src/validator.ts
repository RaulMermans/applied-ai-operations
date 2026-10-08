import { TRACE_TERMINAL_EVENT_TYPES, type RunStatus, type TraceEvent, type TraceEventType } from "@aao/contracts";
import { checkTraceEvent } from "./content-policy.js";
import type { TraceStore } from "./store.js";

/**
 * Deterministic Trace-contract validation (ADR-020), independent of the
 * execution engine. It returns diagnostics with stable codes; it never
 * mutates or repairs a trace, and nothing in AAO uses its result to make an
 * execution decision. It is the evidence primitive future Evals and the Run
 * Inspector build on.
 */
export const TRACE_DIAGNOSTIC_CODES = [
  "TRACE_INVALID_EVENT",
  "TRACE_IDENTITY_MISMATCH",
  "TRACE_SEQUENCE_GAP",
  "TRACE_DUPLICATE_EVENT",
  "TRACE_RUN_START_MISSING",
  "TRACE_TERMINAL_EVENT_MISSING",
  "TRACE_TERMINAL_EVENT_MISMATCH",
  "TRACE_EVENT_AFTER_TERMINAL",
  "TRACE_NODE_EVENT_MISMATCH",
  "TRACE_TOOL_EVENT_MISMATCH",
  "TRACE_MODEL_EVENT_MISMATCH",
  "TRACE_AGENT_EVENT_MISMATCH",
  "TRACE_RETRY_EVENT_MISMATCH",
  "TRACE_APPROVAL_EVENT_MISMATCH",
  "TRACE_CHECKPOINT_EVENT_MISMATCH",
  "TRACE_RECOVERY_EVENT_MISMATCH",
  "TRACE_STATE_MISMATCH",
] as const;
export type TraceDiagnosticCode = (typeof TRACE_DIAGNOSTIC_CODES)[number];

export interface TraceDiagnostic {
  code: TraceDiagnosticCode;
  sequence?: number;
  nodeId?: string;
}

export interface TraceValidationResult {
  valid: boolean;
  issues: TraceDiagnostic[];
}

/** Observational events that may legitimately follow the terminal Run event (e.g. a host cancelling a pending approval after `run.cancelled`). */
export const TRACE_POST_TERMINAL_EVENT_TYPES: readonly TraceEventType[] = Object.freeze(["approval.resolved"]);

const TERMINAL_FOR_STATUS: Partial<Record<RunStatus, TraceEventType>> = { COMPLETED: "run.completed", FAILED: "run.failed", CANCELLED: "run.cancelled" };

/**
 * Sequence rule: the local reference recorder owns each Run's sequence, so
 * a valid trace is strictly contiguous from 0 (`0,1,3` is a gap).
 */
export function validateTrace(events: readonly unknown[], options: { runId?: string; runStatus?: RunStatus } = {}): TraceValidationResult {
  const issues: TraceDiagnostic[] = [];
  const add = (code: TraceDiagnosticCode, event?: TraceEvent) => issues.push({ code, ...(event ? { sequence: event.sequence } : {}), ...(event?.nodeId ? { nodeId: event.nodeId } : {}) });

  const valid: TraceEvent[] = [];
  events.forEach((raw, index) => {
    const checked = checkTraceEvent(raw);
    if (checked.ok) valid.push(checked.event);
    else issues.push({ code: "TRACE_INVALID_EVENT", sequence: index });
  });

  const first = valid[0];
  if (first === undefined) {
    add("TRACE_RUN_START_MISSING");
    if (options.runStatus && TERMINAL_FOR_STATUS[options.runStatus]) add("TRACE_TERMINAL_EVENT_MISSING");
    return { valid: false, issues };
  }

  const ids = new Set<string>();
  let gapReported = false;
  valid.forEach((event, index) => {
    if (event.traceId !== first.traceId || event.runId !== first.runId || event.workflowId !== first.workflowId || event.workflowVersion !== first.workflowVersion || (options.runId !== undefined && event.runId !== options.runId)) add("TRACE_IDENTITY_MISMATCH", event);
    if (event.sequence !== index && !gapReported) { add("TRACE_SEQUENCE_GAP", event); gapReported = true; }
    if (ids.has(event.eventId)) add("TRACE_DUPLICATE_EVENT", event);
    ids.add(event.eventId);
  });

  const starts = valid.filter((event) => event.type === "run.started");
  if (starts.length !== 1 || valid[0]!.type !== "run.started") add("TRACE_RUN_START_MISSING", starts[1] ?? valid[0]);

  const terminalIndex = valid.findIndex((event) => TRACE_TERMINAL_EVENT_TYPES.includes(event.type));
  if (terminalIndex >= 0) {
    valid.slice(terminalIndex + 1).forEach((event) => { if (!TRACE_POST_TERMINAL_EVENT_TYPES.includes(event.type)) add("TRACE_EVENT_AFTER_TERMINAL", event); });
  }
  if (options.runStatus !== undefined) {
    const expected = TERMINAL_FOR_STATUS[options.runStatus];
    const actual = terminalIndex >= 0 ? valid[terminalIndex]!.type : undefined;
    if (expected && actual === undefined) add("TRACE_TERMINAL_EVENT_MISSING");
    else if (expected !== actual) add("TRACE_TERMINAL_EVENT_MISMATCH", terminalIndex >= 0 ? valid[terminalIndex] : undefined);
  }

  checkCausality(valid, add);
  return { valid: issues.length === 0, issues };
}

type P = Record<string, unknown>;
const p = (event: TraceEvent) => event.payload as P;

function checkCausality(events: readonly TraceEvent[], add: (code: TraceDiagnosticCode, event?: TraceEvent) => void): void {
  const nodeStarts = new Map<string, number[]>(); // node|step → attempts started (non-replay), in order
  const nodeStartSpans = new Set<string>();
  const startedAttempts = new Set<string>(); // node|step|attempt (any replay)
  const scheduled = new Set<string>(); // node|step|nextAttempt
  const replayed = new Set<string>(); // step|attempt
  const nodeTerminal = new Set<string>();
  const callOpen = new Map<string, number>(); // tool|model id|attempt → open starts
  const agentIterations = new Map<string, number>();
  const agentStarted = new Set<string>();
  const approvals = new Set<string>();
  let lastCheckpoint = -1;
  let recoveryStarted = false;

  for (const event of events) {
    const payload = p(event);
    const node = event.nodeId ?? "";
    switch (event.type) {
      case "node.started": {
        const step = payload.step as number;
        const attempt = payload.attempt as number;
        startedAttempts.add(`${node}|${step}|${attempt}`);
        nodeStartSpans.add(event.spanId);
        if (payload.recoveryReplay === true) {
          if (!replayed.has(`${step}|${attempt}`)) add("TRACE_RECOVERY_EVENT_MISMATCH", event);
          break;
        }
        const list = nodeStarts.get(`${node}|${step}`) ?? [];
        const expected = (list[list.length - 1] ?? 0) + 1;
        // A resumed attempt may follow recorded failures whose starts were traced; never go backwards or skip.
        if (attempt !== expected && !(list.length === 0 && attempt > 1 && scheduled.has(`${node}|${step}|${attempt}`))) add("TRACE_NODE_EVENT_MISMATCH", event);
        if (attempt > 1 && !scheduled.has(`${node}|${step}|${attempt}`)) add("TRACE_RETRY_EVENT_MISMATCH", event);
        list.push(attempt);
        nodeStarts.set(`${node}|${step}`, list);
        break;
      }
      case "node.completed":
      case "node.failed":
      case "node.waiting": {
        const key = `${node}|${payload.step as number}`;
        if (!nodeStarts.has(key) && ![...startedAttempts].some((entry) => entry.startsWith(`${key}|`))) add("TRACE_NODE_EVENT_MISMATCH", event);
        if (event.type !== "node.waiting") {
          if (nodeTerminal.has(key)) add("TRACE_NODE_EVENT_MISMATCH", event);
          nodeTerminal.add(key);
        }
        break;
      }
      case "retry.scheduled": {
        if (!startedAttempts.has(`${node}|${payload.step as number}|${payload.failedAttempt as number}`) || (payload.nextAttempt as number) !== (payload.failedAttempt as number) + 1) add("TRACE_RETRY_EVENT_MISMATCH", event);
        scheduled.add(`${node}|${payload.step as number}|${payload.nextAttempt as number}`);
        break;
      }
      case "retry.exhausted":
        if (!startedAttempts.has(`${node}|${payload.step as number}|${payload.attempt as number}`)) add("TRACE_RETRY_EVENT_MISMATCH", event);
        break;
      case "tool.call.started":
      case "model.call.started": {
        const family = event.type.startsWith("tool") ? "tool" : "model";
        const id = family === "tool" ? (payload.toolExecutionId as string) : (payload.invocationId as string);
        const key = `${family}|${id}|${payload.attempt as number}`;
        callOpen.set(key, (callOpen.get(key) ?? 0) + 1);
        if (family === "tool" && (event.parentSpanId === undefined || !nodeStartSpans.has(event.parentSpanId))) add("TRACE_TOOL_EVENT_MISMATCH", event);
        break;
      }
      case "tool.call.completed":
      case "tool.call.failed":
      case "model.call.completed":
      case "model.call.failed": {
        const family = event.type.startsWith("tool") ? "tool" : "model";
        const id = family === "tool" ? (payload.toolExecutionId as string) : (payload.invocationId as string);
        const key = `${family}|${id}|${payload.attempt as number}`;
        const open = callOpen.get(key) ?? 0;
        if (open < 1) add(family === "tool" ? "TRACE_TOOL_EVENT_MISMATCH" : "TRACE_MODEL_EVENT_MISMATCH", event);
        else callOpen.set(key, open - 1);
        break;
      }
      case "tool.call.blocked":
        if (callOpen.get(`tool|${payload.toolExecutionId as string}|${payload.attempt as number}`)) add("TRACE_TOOL_EVENT_MISMATCH", event);
        break;
      case "agent.started":
        agentStarted.add(`${payload.agentExecutionId as string}|${payload.attempt as number}`);
        break;
      case "agent.iteration.completed":
      case "agent.completed":
      case "agent.failed": {
        const key = `${payload.agentExecutionId as string}|${payload.attempt as number}`;
        if (!agentStarted.has(key)) { add("TRACE_AGENT_EVENT_MISMATCH", event); break; }
        const done = agentIterations.get(key) ?? 0;
        if (event.type === "agent.iteration.completed") {
          if ((payload.iteration as number) !== done + 1) add("TRACE_AGENT_EVENT_MISMATCH", event);
          agentIterations.set(key, done + 1);
        } else if (event.type === "agent.completed" && (payload.iterationsUsed as number) !== done) add("TRACE_AGENT_EVENT_MISMATCH", event);
        break;
      }
      case "approval.requested":
        approvals.add(payload.approvalId as string);
        break;
      case "approval.resolved":
        if (!approvals.has(payload.approvalId as string)) add("TRACE_APPROVAL_EVENT_MISMATCH", event);
        break;
      case "checkpoint.created": {
        const sequence = payload.checkpointSequence as number;
        if (sequence <= lastCheckpoint) add("TRACE_CHECKPOINT_EVENT_MISMATCH", event);
        lastCheckpoint = Math.max(lastCheckpoint, sequence);
        break;
      }
      case "recovery.started":
        recoveryStarted = true;
        break;
      case "recovery.replayed":
        if (!recoveryStarted) add("TRACE_RECOVERY_EVENT_MISMATCH", event);
        replayed.add(`${payload.step as number}|${payload.attempt as number}`);
        break;
      case "recovery.outcome_reused":
      case "recovery.blocked":
      case "recovery.completed":
        if (!recoveryStarted) add("TRACE_RECOVERY_EVENT_MISMATCH", event);
        break;
      default:
        break;
    }
    if (event.type === "node.waiting" && !approvals.has(payload.referenceId as string)) add("TRACE_APPROVAL_EVENT_MISMATCH", event);
  }
}

/**
 * The minimal Runtime execution shape the comparison needs. Structural, so
 * this package never depends on `@aao/runtime`; a `RuntimeExecutionState`
 * satisfies it.
 */
export interface ComparableExecution {
  run: { runId: string; workflowId: string; workflowVersion: string; status: RunStatus };
  state: { revision: number };
  nodeStatusesById: Record<string, string>;
  history: ReadonlyArray<{ nodeId: string; step: number; status: "SUCCEEDED" | "FAILED"; attemptCount: number }>;
  wait?: { nodeId: string; referenceId: string };
}

/**
 * Compares a trace with authoritative Runtime execution state — a future
 * Eval primitive. Runtime is the truth: a disagreement is reported as a
 * trace integrity/completeness issue and nothing is repaired from Trace.
 */
export function compareTraceWithExecution(events: readonly unknown[], execution: ComparableExecution): TraceValidationResult {
  const base = validateTrace(events, { runId: execution.run.runId, runStatus: execution.run.status });
  const issues = [...base.issues];
  const valid = events.map((raw) => checkTraceEvent(raw)).flatMap((checked) => (checked.ok ? [checked.event] : []));
  const add = (code: TraceDiagnosticCode, nodeId?: string) => issues.push({ code, ...(nodeId ? { nodeId } : {}) });

  if (valid.some((event) => event.workflowId !== execution.run.workflowId || event.workflowVersion !== execution.run.workflowVersion)) add("TRACE_IDENTITY_MISMATCH");

  // Node trajectory: every committed history record (except a cancelled approval wait) has exactly its terminal Node event, in order.
  const expected = execution.history.filter((record) => execution.nodeStatusesById[record.nodeId] !== "CANCELLED").map((record) => `${record.nodeId}|${record.step}|${record.status === "SUCCEEDED" ? "node.completed" : "node.failed"}|${record.attemptCount}`);
  const actual = valid.filter((event) => event.type === "node.completed" || event.type === "node.failed").map((event) => `${event.nodeId}|${p(event).step as number}|${event.type}|${p(event).attemptCount as number}`);
  if (expected.join(",") !== actual.join(",")) add("TRACE_NODE_EVENT_MISMATCH");

  // Attempts: the traced attempts of each recorded Node execution match the Runtime's attempt count.
  for (const record of execution.history) {
    if (execution.nodeStatusesById[record.nodeId] === "CANCELLED") continue;
    const attempts = new Set(valid.filter((event) => event.type === "node.started" && event.nodeId === record.nodeId && p(event).step === record.step).map((event) => p(event).attempt as number));
    if (attempts.size !== record.attemptCount) add("TRACE_RETRY_EVENT_MISMATCH", record.nodeId);
  }

  if (execution.run.status === "WAITING_FOR_APPROVAL" && execution.wait) {
    const requested = valid.some((event) => event.type === "approval.requested" && p(event).approvalId === execution.wait!.referenceId);
    const waiting = valid.some((event) => event.type === "node.waiting" && event.nodeId === execution.wait!.nodeId && p(event).referenceId === execution.wait!.referenceId);
    if (!requested || !waiting) add("TRACE_APPROVAL_EVENT_MISMATCH", execution.wait.nodeId);
  }

  const started = valid.find((event) => event.type === "run.started");
  const lastUpdate = [...valid].reverse().find((event) => event.type === "state.updated");
  const tracedRevision = lastUpdate ? (p(lastUpdate).revisionAfter as number) : started ? (p(started).initialStateRevision as number) : undefined;
  if (tracedRevision !== execution.state.revision) add("TRACE_STATE_MISMATCH");

  return { valid: issues.length === 0, issues };
}

/** The canonical ordered trace of one Run — what a future Run Inspector, Eval Runtime, or failure analysis renders. */
export interface TraceRun {
  runId: string;
  traceId?: string;
  workflowId?: string;
  workflowVersion?: string;
  events: TraceEvent[];
  /** Valid and, when the Run has a terminal event, terminated: a complete trace. */
  complete: boolean;
  issues: TraceDiagnostic[];
}

export async function reconstructRunTrace(store: TraceStore, runId: string, options: { runStatus?: RunStatus } = {}): Promise<TraceRun> {
  const events = await store.getRunTrace(runId);
  const result = validateTrace(events, { runId, ...(options.runStatus ? { runStatus: options.runStatus } : {}) });
  const first = events[0];
  return {
    runId,
    ...(first ? { traceId: first.traceId, workflowId: first.workflowId, workflowVersion: first.workflowVersion } : {}),
    events,
    complete: result.valid,
    issues: result.issues,
  };
}
