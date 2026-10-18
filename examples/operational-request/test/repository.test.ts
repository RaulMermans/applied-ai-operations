import { describe, expect, it } from "vitest";
import { createInMemoryDraftRepository } from "../src/repository.js";
import type { OperationalChangeDraft } from "../src/contracts.js";

const DRAFT_A: OperationalChangeDraft = Object.freeze({
  schemaVersion: 1,
  draftId: "draft.1111222233334444",
  requestId: "req-001",
  operation: "account.update_display_name",
  accountId: "ACME-001",
  proposedChanges: Object.freeze({ displayName: "Acme Data Solutions" }),
  approvalId: "approval:abcdef123456",
  status: "approved_draft",
  externalExecution: "not_executed",
});

describe("Host-Owned Draft Repository & Idempotency", () => {
  it("stores a valid draft and retrieves it", async () => {
    const repo = createInMemoryDraftRepository();
    const result = await repo.saveDraft("exec.001", DRAFT_A);
    expect(result.ok).toBe(true);

    const retrieved = repo.getDraft(DRAFT_A.draftId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.draftId).toBe(DRAFT_A.draftId);
    expect(retrieved?.status).toBe("approved_draft");
    expect(retrieved?.externalExecution).toBe("not_executed");

    const byExec = repo.getDraftByExecutionId("exec.001");
    expect(byExec?.draftId).toBe(DRAFT_A.draftId);
    expect(repo.getAllDrafts().length).toBe(1);
  });

  it("handles identical idempotent replay without duplicate creation", async () => {
    const repo = createInMemoryDraftRepository();
    const first = await repo.saveDraft("exec.001", DRAFT_A);
    expect(first.ok).toBe(true);

    // Replay with exact same execution ID and payload
    const replay = await repo.saveDraft("exec.001", DRAFT_A);
    expect(replay.ok).toBe(true);
    expect(repo.getAllDrafts().length).toBe(1);
  });

  it("rejects conflicting payload for an existing execution ID", async () => {
    const repo = createInMemoryDraftRepository();
    const first = await repo.saveDraft("exec.001", DRAFT_A);
    expect(first.ok).toBe(true);

    // Conflicting draft with same executionId but altered displayName
    const conflicting: OperationalChangeDraft = {
      ...DRAFT_A,
      proposedChanges: { displayName: "Conflicting Name" },
    };
    const conflict = await repo.saveDraft("exec.001", conflicting);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    }
    expect(repo.getAllDrafts().length).toBe(1);
  });

  it("rejects conflicting payload for an existing draft ID with a different execution ID", async () => {
    const repo = createInMemoryDraftRepository();
    const first = await repo.saveDraft("exec.001", DRAFT_A);
    expect(first.ok).toBe(true);

    // Conflicting draft with same draftId but altered payload under exec.002
    const conflicting: OperationalChangeDraft = {
      ...DRAFT_A,
      proposedChanges: { displayName: "Another Conflicting Name" },
    };
    const conflict = await repo.saveDraft("exec.002", conflicting);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    }
    expect(repo.getAllDrafts().length).toBe(1);
  });

  it("returns frozen immutable copies that cannot be mutated externally", async () => {
    const repo = createInMemoryDraftRepository();
    await repo.saveDraft("exec.001", DRAFT_A);
    const retrieved = repo.getDraft(DRAFT_A.draftId)!;

    expect(() => {
      // @ts-expect-error mutating frozen object
      retrieved.status = "mutated";
    }).toThrow();
  });
});
