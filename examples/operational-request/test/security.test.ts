import { describe, expect, it } from "vitest";
import {
  createInMemoryTraceStore,
  createTraceRecorder,
} from "@aao/observability";
import {
  createFixtureProof,
  fixedClock,
  manager,
  PROMPT_INJECTION_REQUEST,
  REQUEST_WITH_SEEDED_SECRET,
  REQUEST_WITH_SECRET_DO_NOT_PERSIST,
  SECRET_TOKEN,
  SECRET_DO_NOT_PERSIST,
} from "../fixtures/index.js";
import { STATE_KEYS, type OperationalRequestResult } from "../src/index.js";
import { failureCode, failureNodeId } from "./support.js";


describe("Security & Privacy Boundaries", () => {
  it("treats prompt injection instructions strictly as untrusted data", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.sec.injection",
      request: PROMPT_INJECTION_REQUEST,
    });

    // Workflow reached approval waitpoint; injection did NOT auto-approve or trigger CRM update
    expect(initial.execution?.run.status).toBe("WAITING_FOR_APPROVAL");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);

    // If human approves the draft, only local draft is created
    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.approve(approvalId, manager);
    const resumed = await proof.continue(initial.execution!);

    expect(resumed.ok).toBe(true);
    expect(resumed.execution?.run.status).toBe("COMPLETED");

    const drafts = proof.draftRepository.getAllDrafts();
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.externalExecution).toBe("not_executed");
  });

  it("fails closed if model succumbs to injection and attempts privilege escalation", async () => {
    const { proof } = createFixtureProof({
      modelOptions: { forbiddenMetadata: true },
    });
    const result = await proof.execute({
      runId: "run.sec.injection-succumbed",
      request: PROMPT_INJECTION_REQUEST,
    });

    expect(result.ok).toBe(false);
    expect(failureCode(result)).toBe("NODE_EXECUTION_FAILED");
    expect(failureNodeId(result)).toBe("validate_proposal");
    expect(proof.draftRepository.getAllDrafts().length).toBe(0);

  });

  it("ensures seeded secrets never leak into metadata-only Trace events", async () => {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });

    const { proof } = createFixtureProof({ trace });
    const initial = await proof.execute({
      runId: "run.sec.secret-leakage",
      request: REQUEST_WITH_SEEDED_SECRET,
    });

    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.approve(approvalId, manager);
    await proof.continue(initial.execution!);

    const traceEvents = await store.getRunTrace("run.sec.secret-leakage");
    expect(traceEvents.length).toBeGreaterThan(0);

    // Serialized trace must NOT contain the secret token
    const traceJson = JSON.stringify(traceEvents);
    expect(traceJson.includes(SECRET_TOKEN)).toBe(false);
  });

  it("ensures final operational result excludes unnecessary secret tokens from instruction", async () => {
    const { proof } = createFixtureProof();
    const initial = await proof.execute({
      runId: "run.sec.secret-result",
      request: REQUEST_WITH_SEEDED_SECRET,
    });

    const approvalId = initial.execution?.wait?.referenceId;
    if (!approvalId) throw new Error("Expected approval waitpoint");
    proof.approvals.approve(approvalId, manager);
    const resumed = await proof.continue(initial.execution!);

    const finalResult = resumed.execution?.state.values[STATE_KEYS.finalResult] as OperationalRequestResult;
    expect(finalResult.renderedMarkdown.includes(SECRET_TOKEN)).toBe(false);
  });

  it("verifies SECRET_DO_NOT_PERSIST seeded into failure paths never leaks into trace or error", async () => {
    const store = createInMemoryTraceStore();
    const trace = createTraceRecorder({ store, clock: fixedClock() });

    const { proof } = createFixtureProof({
      trace,
      modelOptions: { unsupportedOperation: true }, // will trigger failure path
    });
    const result = await proof.execute({
      runId: "run.sec.secret-failure",
      request: REQUEST_WITH_SECRET_DO_NOT_PERSIST,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.failure)).not.toContain(SECRET_DO_NOT_PERSIST);
    }

    const traceEvents = await store.getRunTrace("run.sec.secret-failure");
    expect(JSON.stringify(traceEvents)).not.toContain(SECRET_DO_NOT_PERSIST);
  });
});
