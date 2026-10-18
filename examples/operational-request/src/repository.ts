import type { OperationalChangeDraft } from "./contracts.js";

export interface OperationalDraftRepository {
  /**
   * Persists an approved operational change draft.
   * Honored under the `write_draft` idempotency contract using `execution_id`.
   * Replays with identical execution ID and payload succeed idempotently without creating duplicates.
   * Conflicting payloads for an existing execution ID or draft ID fail closed.
   */
  saveDraft(
    toolExecutionId: string,
    draft: OperationalChangeDraft
  ): Promise<{ ok: true; draft: OperationalChangeDraft } | { ok: false; code: "IDEMPOTENCY_CONFLICT" }>;

  /** Inspect a draft by its unique draftId. Read-only for tests. */
  getDraft(draftId: string): OperationalChangeDraft | undefined;

  /** Inspect a draft by the tool execution ID that created it. Read-only for tests. */
  getDraftByExecutionId(toolExecutionId: string): OperationalChangeDraft | undefined;

  /** List all stored drafts. Read-only for tests. */
  getAllDrafts(): readonly OperationalChangeDraft[];

  /** Reset repository state (test helper). */
  clear(): void;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function freezeDraft(draft: OperationalChangeDraft): OperationalChangeDraft {
  return Object.freeze({
    ...draft,
    proposedChanges: Object.freeze({ ...draft.proposedChanges }),
  });
}

/**
 * Creates an in-memory host-owned draft repository.
 * Keeps drafts strictly within local memory, never contacting external systems.
 */
export function createInMemoryDraftRepository(): OperationalDraftRepository {
  const draftsByExecutionId = new Map<string, OperationalChangeDraft>();
  const draftsById = new Map<string, OperationalChangeDraft>();

  return Object.freeze({
    async saveDraft(
      toolExecutionId: string,
      draft: OperationalChangeDraft
    ): Promise<{ ok: true; draft: OperationalChangeDraft } | { ok: false; code: "IDEMPOTENCY_CONFLICT" }> {
      const existingByExec = draftsByExecutionId.get(toolExecutionId);
      if (existingByExec) {
        if (deepEqual(existingByExec, draft)) {
          return { ok: true as const, draft: existingByExec };
        }
        return { ok: false as const, code: "IDEMPOTENCY_CONFLICT" as const };
      }

      const existingById = draftsById.get(draft.draftId);
      if (existingById) {
        if (deepEqual(existingById, draft)) {
          return { ok: true as const, draft: existingById };
        }
        return { ok: false as const, code: "IDEMPOTENCY_CONFLICT" as const };
      }

      const frozen = freezeDraft(draft);
      draftsByExecutionId.set(toolExecutionId, frozen);
      draftsById.set(draft.draftId, frozen);
      return { ok: true as const, draft: frozen };
    },

    getDraft(draftId: string) {
      return draftsById.get(draftId);
    },

    getDraftByExecutionId(toolExecutionId: string) {
      return draftsByExecutionId.get(toolExecutionId);
    },

    getAllDrafts() {
      return Object.freeze(Array.from(draftsById.values()));
    },

    clear() {
      draftsByExecutionId.clear();
      draftsById.clear();
    },
  });
}
