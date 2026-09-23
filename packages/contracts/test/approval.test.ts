import { describe, expect, it } from "vitest";
import { ApprovalRecordSchema, ApprovalStatusSchema } from "../src/approval.js";
import { approvalRecordFixture } from "./fixtures.js";

const CANONICAL_APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "cancelled"] as const;

describe("ApprovalStatusSchema", () => {
  it.each(CANONICAL_APPROVAL_STATUSES.map((status) => [status]))("accepts canonical approval status %s", (status) => {
    expect(ApprovalStatusSchema.safeParse(status).success).toBe(true);
  });

  it("rejects an invalid approval status", () => {
    expect(ApprovalStatusSchema.safeParse("resolved").success).toBe(false);
  });
});

describe("ApprovalRecordSchema", () => {
  it("parses a valid pending approval", () => {
    expect(ApprovalRecordSchema.safeParse(approvalRecordFixture).success).toBe(true);
  });

  it("parses a resolved approval with resolvedAt/resolvedBy", () => {
    const resolved = {
      ...approvalRecordFixture,
      status: "approved" as const,
      resolvedAt: "2026-09-23T12:10:00Z",
      resolvedBy: "reviewer@example.com",
    };
    expect(ApprovalRecordSchema.safeParse(resolved).success).toBe(true);
  });

  it("rejects an invalid status", () => {
    expect(ApprovalRecordSchema.safeParse({ ...approvalRecordFixture, status: "resolved" }).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { requestedAt: _requestedAt, ...malformed } = approvalRecordFixture;
    expect(ApprovalRecordSchema.safeParse(malformed).success).toBe(false);
  });

  it("does not require or accept a raw secret/credential field", () => {
    expect(ApprovalRecordSchema.safeParse({ ...approvalRecordFixture, secret: "sk-live-abc" }).success).toBe(false);
  });
});
